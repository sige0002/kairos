# rosbag2_recorder 仕様

> ステータス: 設計確定（v1）。`fig_const/rosbag2recorder.png` を基に、未記載事項を推奨設計として確定。日本語が正本（これを正とする）。英語版 `docs/specs/en/rosbag2_recorder.md` は自動生成ミラー（直接編集しない）。**認証は不要。**

ROS 2 のトピックを **MCAP に正式記録する**コンテナ。公式の生データ記録パス（**正本**）。生データを記録するのはこのコンテナだけ。

## 役割

- 選択した ROS 2 トピックを欠損なく MCAP に記録する役割に特化する。
- 1 コンテナ = 1 記録セッション（同時記録は 1 本のみ）。

## 入力

- 選択された ROS 2 topics（明示リスト、または `"all"`）
- record config（compression / split / QoS など）
- run_id / output_dir
- `RECORDING_CONFIG` の `default_topics` / `topic_qos_overrides`（[config](config.md)）

## 構成コンポーネント

- **Topic Selector** — 記録対象のフィルタリング。`"all"` は start 時点の topic 一覧を展開し manifest に固定する。
- **Recorder** — `ros2 bag record --storage mcap`（subprocess、堅牢で標準準拠）または rosbag2 Python API で実記録（kairos は前者）。
- **MCAP Writer** — `storage_id=mcap`（正本）、`serialization=cdr`。
- **metadata.yaml Writer** — rosbag2 標準メタデータ出力。
- **Compression / Split 管理** — 圧縮（`none` / `zstd`）・分割（サイズ / 時間）。

## QoS / 画像対応

- **既定は rosbag2 が各 publisher の offered QoS に追従する**（推奨。これにより best_effort な publisher も取りこぼさない）。override は任意。
- **取得トピックごとに QoS を選択可能**にする: `reliability`（`reliable` / `best_effort`）、`durability`（`volatile` / `transient_local`）、`depth`。`ros2 bag record` では `--qos-profile-overrides-path`（YAML）で渡す。
  - 注意: `topics: "all"` の場合、config の pattern QoS override は事前適用できない（start 前に実トピック集合が不明なため）。明示的な per-request override のみ適用される。
- **画像系に対応**: `sensor_msgs/Image` / `sensor_msgs/CompressedImage` / ffmpeg（`ffmpeg_image_transport`）。いずれも生バイトのまま MCAP に記録する（再エンコードしない）。

## カスタムメッセージ対応

- 標準外の型（例: `tmc_control_msgs/msg/ServoState`）を持つトピックも記録する。**メッセージ定義（型サポート）が記録環境に存在する前提**とする（`msgs がある前提`）。
- 仕組み: カスタム msg パッケージをビルドした colcon オーバーレイ（`install/`）を記録コンテナにマウントし、起動時に source する（パスは環境変数で指定）。rosbag2 は型サポートを解決できれば生 cdr を記録する（デコードはしない）。
- 型サポートを解決できない topic は rosbag2 が記録をスキップする（上記前提では発生しない想定）。

## API（サービス内部 API。公開は `api_orchestrator` 経由）

- `POST /record/start` — body:
  ```json
  {
    "topics": ["..."] ,
    "run_id": "orchestrator が採番して渡す",
    "compression": "none",
    "split": { "max_size_mb": null, "max_duration_s": null },
    "qos_default": { "reliability": "best_effort", "durability": "volatile", "depth": 10 },
    "qos_overrides": { "/topic": { "reliability": "reliable", "durability": "transient_local", "depth": 1 } }
  }
  ```
  → `201 { run_id, state, started_at }`。`topics` の型は `string[] | "all"`。
- `POST /record/stop` — **冪等**。記録中→停止して `200`、idle→`200`（現状態を返す）。
- `GET /record/status` — `{ state, run_id?, started_at?, message_count, bytes, topics: [], dropped_messages?, integrity }`（`dropped_messages` / `integrity` は[取りこぼし検出](#取りこぼし検出記録キャッシュ整合性)を参照）
- `GET /record/metadata` — 直近 run の metadata（rosbag2 標準 + kairos manifest）
- `GET /healthz` / `GET /readyz`
- 異常: `/data` 書込不可・空き容量不足は記録を拒否（`507` 相当）。多重 start は `409`。

## 開始時の取りこぼし対策（start-paused readiness gate, 任意）

`ros2 bag record` は spawn 後に DDS discovery → subscription match が済むまで対象トピックに購読が確立せず、その間の VOLATILE/best_effort メッセージは録れない（`start_delay_s` は publisher のウォームアップ用で、この lag は別物）。

`recording.start_paused: true`（既定 `false`）で対策を有効化する: recorder を **`--start-paused`** で起動 → 対象トピックの購読がグラフ上で確立するまで待機（最大 `subscription_ready_timeout_s`）→ recorder の `~/resume` を呼んでから「recording」を返す。これで **resume 以降は全購読 live**。**フェイルセーフ**: resume を確認できなければ start を可視的に失敗させる（`507 record_arm_failed`）。一時停止のまま無音録画にはしない。readiness 判定と resume は rclpy + rosbag2 サービスを使い ROS イメージでのみ動く（CI 外）ため**検証後にデプロイ単位で有効化**する想定。t0 必須の単発/latched トピックは publisher 側を transient_local にするのが補完策。

resume は **rosbag2 の `~/resume` サービス**で行うため、対話 SPACE キー（≒擬似 TTY/pty が必要）に依存しない。recorder には常時 `--disable-keyboard-controls` を渡し、キーボード制御を無効化する（不要なオーバーヘッドと TTY 依存の排除）。

### 録画開始レイテンシ（多トピック時）と two-phase start — **TBD**

**現象**: トピック数が多い構成（例: カメラ 4 + 数値 27 = 31 topics）では、`POST /record/start` から実際の書き込み開始まで数秒かかる。内訳は ① `ros2 bag record` の**サブプロセス spawn**（Python CLI + rclcpp 初期化で 1〜3 秒）、② 新規 DDS participant の **discovery + 対象トピックの購読マッチング**（トピック数・グラフ規模に比例。グラフが混んでいるほど延びる）、③ writer 初期化。UI の「recording（赤）」は start 受理で点くため、`start_paused` 無効時は「**赤いのにまだ録れていない**」時間として現れる（有効時は同じ時間が start 応答待ちとして現れる — 見え方が違うだけで根は同じ）。

**TBD（推奨案・要ユーザ判断）: two-phase start（prepare → resume）。** 既存の start-paused readiness gate をそのまま土台に、spawn とマッチングを**操作より前**に済ませる:

1. `POST /record/prepare`（新設）— recorder を `--start-paused` で spawn し、購読マッチングまで済ませて **armed** で待機。matched/missing は既存の arming 観測スナップショットを流用。run_id は prepare 時に採番（rosbag2 は spawn 時に出力先を開くため）。
2. `POST /record/start` — armed なら `~/resume` を呼ぶだけ。**開始は実測ミリ秒オーダー**になり、「resume 以降は全購読 live」という現行ゲートの保証も維持。
3. **auto-disarm** — armed のまま一定時間（例 120 秒）start が来なければ破棄し、空の run ディレクトリも削除（下記コスト対策として必須）。

トレードオフ（明示）:

- **armed 中も購読は live** = 記録と同じ DDS リーダ負荷がかかり続ける（paused の rosbag2 は受信して捨てる）。SHM が効かない構成（[deployment_topology](deployment_topology.md) の「単一ホスト SHM の成立条件」）ではフルコピー負荷なので、arm 窓は短く保ち、UI の操作意図（記録準備の明示操作）に連動させる。
- prepare/armed/disarm の API・状態機械が増える（orchestrator / frontend の変更を伴う設計変更）。よって **TBD** とし、実装判断はユーザと行う。

**代替案 — `rosbag2_py.Recorder` による同一プロセス実装 — TBD（2026-07-09 追記・要再検討）**: 常駐 recorder（rosbag2_py で participant/購読を温存し spawn コストを恒久に消す）は、従来「実績ある `ros2 bag record` サブプロセスの挙動を自前実装で置き換えることになりリスク対効果が悪い」として非推奨としていた。しかし調査の結果、`ros2 bag record` CLI 自体が中身では `rosbag2_py.Recorder`（C++ `rosbag2_transport::Recorder` の pybind11 バインディング）を直接呼ぶ薄いラッパーであることを確認した（`ros2bag/ros2bag/verb/record.py`, jazzy ブランチ）。つまり `rosbag2_py.Recorder` を kairos の自プロセス内から直接呼んでも、cache 溢れ検出・split・SIGINT 相当の flush（`stop()`）は CLI と同一の実装を素通しで使えるだけで、「自前実装への置き換え」には当たらない。`pause()` / `resume()` / `is_paused()` もネイティブメソッド・オプションとして既にあり、上記 two-phase start の実装コストを下げる副次効果もある。サブプロセス spawn（1〜3 秒）を消せるため開始レイテンシの一部には効くが、DDS discovery/購読マッチングの待ち時間そのものは変わらない（two-phase start とは直交し併用可）。**新たな未検証点**: Jazzy でのこの API 対応はごく最近（`rosbag2_py` 0.26.8/0.26.9, 2025-07〜08）で枯れていない点、および `Recorder` のコンストラクタが自前で `rclcpp::init()` するため、既存の readiness gate（`_arm_and_resume()`）が持つ rclpy コンテキストと**同一プロセス内で 2 つの ROS コンテキストが共存**することになり動作未確認、の 2 点。よって非推奨の決定を覆すには実機検証が要る — **TBD** とし、実装判断はユーザと行う。DDS discovery チューニング（initial announcements 等）は短縮効果が小さく単独では解決しない（加点程度）。

## 取りこぼし検出（記録キャッシュ整合性）

`ros2 bag record` は受信メッセージを **メモリ内キャッシュ**（`--max-cache-size`、既定 100 MiB）に貯め、書き込みスレッドがディスクへ吐き出す。バースト・低速ストレージ・CPU 制約などで**書き込みが追いつかないとキャッシュが溢れ、超過分は黙って捨てられる**（rosbag2 が終了時に `Total lost: N` を stderr に出す）。これは記録中の主要なデータ欠落経路。

- **キャッシュ調整**: `recording.max_cache_size_mb`（MiB）で `--max-cache-size` を上書きする。`0` は flag を付けず rosbag2 既定（100 MiB）。大きいほどバースト耐性が上がる。同梱の実機プロファイルは **512** を設定。倍々バッファのため最悪 RAM は約 `2×` で、起動前に空き RAM をプリフライト（不足時 `507 insufficient_memory`）。
- **取りこぼし検出**: recorder の stdout/stderr を**ファイル**（`<run_id>.recorder.log`、run ディレクトリの兄弟）に取り、finalise 時に `Total lost: N` を走査する。**パイプではなくファイル**なので固定長バッファによる stop 時フラッシュのストール（pipe-stall）を起こさず、かつログを後から走査できる（inherit-to-container-log では不可能）。検出結果は `dropped_messages`（落とした件数。`null` は不明）と `integrity`（`ok` / `dropped` / `failed` / `unknown`）として `manifest.json` と `GET /record/status` に出す。クリーンに完了しても溢れがあれば `completed` かつ `integrity=dropped`（=データ欠損あり）と明示する。
- ログは finalise 後に run ディレクトリへ移動（`recorded/<run_id>/recorder.log`）し、bag と一緒に監査できる。

## 出力 / 保存物

- `/data/recorded/<run_id>/<run_id>_*.mcap`（split 時は連番）
- `metadata.yaml`（rosbag2 標準）
- `manifest.json`（kairos 独自）: run_id / state / 選択 topics（型・QoS）/ started_at・ended_at（UTC）/ compression / split / error? / `dropped_messages` / `integrity`。
  - **runs の正は `api_orchestrator` の SQLite**、manifest は監査用。
- `recorder.log`（finalise 後に run ディレクトリへ移動）: recorder プロセスの stdout/stderr。`Total lost`（キャッシュ溢れ）等の解析元。
- `session.json`（MCAP と同じディレクトリ）: operator / task（省略時は `unknown_operator` / `unknown_task` を既定）＋件数等。`dora_runner` の dataset export が保存先 `data/<operator>/<task>` を決めるのに使う。
- run 状態: `created` | `recording` | `stopping` | `completed` | `failed` | `interrupted`。

## 設定（config）

- `run_id` の文字種は `[A-Za-z0-9_-]+`（パストラバーサル防止）。
- `MAX_RECORD_BYTES > 0` で超過時に自動 stop。
- `default_topics` / `topic_qos_overrides` は `RECORDING_CONFIG` の YAML から（パターン一致）。`ROS_DOMAIN_ID` / `DATA_DIR` / `BIND_HOST` は共有 [config](config.md)。

## 設計ポイント

- **MCAP が正本。** 生データを欠損なく記録することに特化し、ROS 2 標準に準拠する。
- 再起動などで中断した run は `state=interrupted` を manifest に残す。
- `run_id` は `api_orchestrator` が採番して渡す。recorder は記録と status / manifest 提供に責務を限定し、**runs の正は orchestrator の SQLite**（Run ライフサイクル・reconciliation は [api_orchestrator](api_orchestrator.md)）。
- 重い検証・変換は `dora_runner` に委譲（このコンテナはやらない）。
