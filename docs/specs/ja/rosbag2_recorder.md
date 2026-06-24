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
- **Recorder** — `ros2 bag record --storage mcap`（subprocess、堅牢で標準準拠）または rosbag2 Python API で実記録（`../rosbag-view` は前者）。
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
- `GET /record/status` — `{ state, run_id?, started_at?, message_count, bytes, topics: [] }`
- `GET /record/metadata` — 直近 run の metadata（rosbag2 標準 + kairos manifest）
- `GET /healthz` / `GET /readyz`
- 異常: `/data` 書込不可・空き容量不足は記録を拒否（`507` 相当）。多重 start は `409`。

## 出力 / 保存物

- `/data/recorded/<run_id>/<run_id>_*.mcap`（split 時は連番）
- `metadata.yaml`（rosbag2 標準）
- `manifest.json`（kairos 独自）: run_id / state / 選択 topics（型・QoS）/ started_at・ended_at（UTC）/ compression / split / error?。
  - **runs の正は `api_orchestrator` の SQLite**、manifest は監査用。
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
