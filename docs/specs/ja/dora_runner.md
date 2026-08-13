# dora_runner 仕様

> ステータス: 設計確定（**v2 = capture store 対応**）。`fig_const/dora.png` を基に、未記載事項を推奨設計として確定。日本語が正本（これを正とする）。英語版 `docs/specs/en/dora_runner.md` は自動生成ミラー（直接編集しない）。**認証は不要。**

記録後の **検証・変換・拡張処理パイプライン**コンテナ（**dora** ベース）。記録済み MCAP を入力に、検証・変換・**AI 処理**を非同期ジョブで実行する。重い処理はすべてここに集約し、`rosbag2_recorder` / `topic_monitor` は軽量に保つ。**dora の拡張性と AI 連携を最大限活かす**ことを設計の中心に置く。

## 役割

- 記録済み MCAP に対して、検証 / 変換 / 拡張（AI 含む）を行う。
- 各処理を差し替え・連結可能な部品として組み立てられるようにする。

## 設計の中心: dora 拡張性 & AI 連携

- 各処理（validator / converter / **AI node**）は **dora node（プラグイン）**として実装し、**dora dataflow（YAML）**で接続する。
- **Plugin Registry** が node を登録し、**Pipeline Registry** が dataflow（= pipeline）を管理する。**pipeline 追加 = dataflow YAML + node 追加**で済み、コア改修は不要。
- node の **I/O は契約（contract）**として固定する:
  - 入力: `capture`（`objects/<capture_id>` のパス / metadata / `object_manifest.json`）、MCAP メッセージ反復子（topic フィルタ・時間範囲指定可）、`params`。
  - 出力: `metrics`（dict）、`artifacts`（生成物パスのリスト）、`report` 断片。
  - これにより node を自由に差し替え・連結できる。
- **AI 連携を一級市民にする**: 推論 / 自動アノテーション / 埋め込み・検索インデックス / 品質スコアリング / 学習用データセット変換（例: **LeRobot** 形式）を **AI dora node** として差し込める。
  - node I/F はモデル差し替え前提（`params.model` 等）。GPU 利用可（`--gpus` / 環境変数）。メッセージはバッチ処理可。
  - 再現性のため、report に pipeline / node / モデルのバージョンを記録する。
- dora dataflow なので、ストリーミング / 分散実行 / node 再利用が効く。

## 入力

- `/data/objects/<capture_id>/*.mcap`（+ `metadata.yaml` / `object_manifest.json`）— **ソース解決はこの 1 本のみ**（[capture_store](capture_store.md) §2）
- pipeline 定義（dataflow YAML）
- config（[config](config.md)、検証テンプレート、`config/<robot>/flows/*.yml`＝`full_validation` の検証フロー）
- job record（`api_orchestrator` 由来）

### capture store との関係（v2）

- **全ジョブの必須入力は `capture_id`**（旧 `run_id` から変更）。`dataset_dir` param は廃止した — エクスポートで bag が動かなくなったので、「録画中の場所」と「エクスポート後の場所」を切り替える必要がそもそも無い。
- **成果物は `report/<pipeline>/<capture_id>/`**。旧 `run_id` 配下の report は捨てる。
- **`objects/<capture_id>/` に書き込まない。** dora_runner は capture を読んで `report/` に書くだけで、`objects/` 配下には（tmp ファイルすら）作らない。これが守られているので、dora_runner は **capture lease を認知しなくてよい**（lease の取得・更新・解放は orchestrator が代行する。[capture_store](capture_store.md) §7.1）。
- capture が削除されればディレクトリは `.trash` へ移り、走っていたジョブは**きれいに失敗する**（遅い正常終了であって破損ではない）。

## 構成コンポーネント

- **MCAP Loader** — `mcap` + `mcap-ros2-support` で読込（**rclpy 不要**、ファイル反復）。topic / 型 / 時刻 / サイズを取得し、必要時のみ decode。
- **Plugin Registry** — dora node（validator / converter / AI）の登録・発見。
- **Pipeline Executor** — dora dataflow の実行・順序制御。job ごとに timeout / リソース上限。
- **Result Writer** — レポート / 変換物の出力。
- **Job Status / Logs** — 状態・進捗・ログ（`api_orchestrator` へ SSE）。

## 実行可能パイプライン（図）

- `fast_validation` / `full_validation` / `dataset_convert` / `dataset_validation`
- **実装済み（`enabled=true`）**: `fast_validation` / `full_validation` / `loss_report` / `clock_check` / `video_check` / `signal_report`（下記）の 6 本。`dataset_convert` / `dataset_validation` は I/F とプラグイン枠のみ（`enabled=false`）。
- **`dataset_export` / `dataset_archive` は廃止**（v2）。dataset は物理移動を伴わない DB 行になり（[capture_store](capture_store.md) §6）、archive は orchestrator の capture 単位エンドポイント（`POST /api/v1/captures/{id}/archive`）が担う。ファイルを動かす仕事は dora_runner から無くなった。
- **検証 2 本（`fast_validation` / `full_validation`）は同梱バイナリ依存**（bagflow + dora CLI）。イメージ以外の環境（ソースチェックアウト / CI）では `enabled=false` の**プレースホルダに落ちる**（理由を description に出す）＝実行できないものを実行できると宣伝しない。
- すべてのジョブは `POST /jobs`（`api_orchestrator` がプロキシ）経由で起動する。各パイプラインは `capture_id` が正規の UUIDv7 であることを検証してパストラバーサルを防ぐ。

## 実装済みパイプライン

- **`loss_report`** — ロボット非依存・config 不要の per-topic ロス推定。完了した MCAP のメッセージ時刻から、トピックごとの**中央値の間隔**を求め、`loss ≈ 1 − actual/expected` を算出する（読み取りのみ・ペイロードを decode しない）。時刻は**送信側の `publish_time`（DDS source timestamp）を優先**し、受信側のジッタ（DDS 伝送・recorder のスケジューリング/キャッシュ）をケイデンス推定から排除する。ただし publish_time を信頼するのは「全メッセージが source stamp を持つ（**非ゼロ**かつ **log_time と異なる**）かつ **両クロックの記録窓が一致（2倍以内）**」する場合のみで、そうでなければ（旧 rosbag2 の `pub==log`、log/source 混在、`0`、送信側クロックのオフセット等）単一の受信側 `log_time` へフォールバックする＝publish_time 化で従来より悪化することはない。なお publish_time でも「ソース欠落」と「録画前の伝送ロス」は区別できない（録画前に落ちたメッセージは MCAP に無く publish_time も消える）ため、これは**測定ではなく推定**である。**どちらのクロックで計算したかはトピックごとに `time_source`（`"publish_time"` / `"log_time"`）として summary に明記**する（honesty 原則）。さらに閾値超過した各間隔を `events` として、topic、収録先頭からの `start_offset_ms` / `end_offset_ms`、`gap_ms`、中央値比 `gap_ratio`、中央値ケイデンスからの `estimated_missing` とともに列挙する。イベント位置は topic 間で比較できる MCAP `log_time` の収録相対時刻、gap 判定自体は上記の選択済み時刻で行う。`estimated_missing` は断定値ではなく、2 つの記録済みメッセージ間の長い間隔からの推定である。レポート: `data/report/loss_report/<capture_id>/summary.json`。
- **`clock_check`** — ロボット非依存の**録画ホスト vs パブリッシャの時計整合性チェック**（ROS 不要・mcap 直読み）。bag 内の 2 つの時刻は別マシンの時計で打たれる — `header.stamp` はパブリッシャ（split 構成ではロボット側）、MCAP `log_time` は録画ホストの受信時刻 — ので、その差は本来伝送＋キューの遅延（ms オーダー）であり、録画 PC の時計が狂っていると差がそのまま時計オフセットになる（録画側が遅れていれば**負値**＝「発行前に受信」）。手法: ①decode 無しの走査で**選択トピックの** `(log_time, publish_time)` と各チャネルのエンコーディングを取得し、`publish_time` が信頼できる場合（loss_report と同じ `source_times` 規則）は **`log_time − publish_time` の中央値**（header オフセットと**同じ向き**）を decode 不要のクロスチェックとして併記する。②トピック単位の有界 decode で `header.stamp` を採取 — 先頭 `n_head` 件と、**逆順読みで真に bag の末尾となる** `n_tail` 件（合計 `max_samples_per_topic`、既定 200）。予算内に収まる小トピックは 1 回で全読みし（統計は全数）、段差判定は**先頭 1/4 と末尾 1/4** の中央値比較（重複なし＝`count` が `message_count` を超えることはない）。decode コストはトピックごとに `min(max_samples_per_topic, message_count)` で有界。CDR/ros2msg でないチャネル（外部取り込み bag の json 等）は理由付きで skip し、ジョブ全体を落とさない。判定: `|median| > threshold_ms`（既定 500）で `offset_suspected`、先頭窓と末尾窓の中央値が threshold 超で乖離すると `step_suspected`（**録画中の NTP ステップ**の形。log_time 側に偽ギャップ/時間逆行が刻まれる）。フラグされたトピックは `offset_kind` で分類する — **`clock_step`**（先頭/末尾窓が乖離。段差があるとき混成中央値の分類は恣意的になるため、段差自体を診断とする）/ `clock_disagreement`（header オフセットが DDS スタンプの測る時計オフセットと一致＝録画側の時計そのものが狂い）/ `source_stamping`（DDS スタンプは両時計の一致を証明しており、header スタンプ自体が外来・遅延 — **bag 再生の再録画はここに落ちる**: 再生は元収録の header.stamp をそのまま流すため）/ `indeterminate`（信頼できる publish_time が無く判別不能）。header の無い型・zero stamp は理由付きで報告し**フラグしない**（zero stamp を epoch と比較して 56 年のオフセットを捏造しない）。一部だけ unstamped のトピックは `unstamped_sampled` で開示する。summary は `result: pass|fail`（fail = フラグ 1 件以上）を持ち Validation タブの汎用レンダラでゲートでき、**空 bag / glob 不一致で何も検査しなかったときは `note` にその旨を明記**する（何も見ていない緑を黙って返さない）。「これは推定であり、どちらの時計が正しいかの測定ではない」旨の definition も明記。**chunk index の無い MCAP では逆順読みが成立しない**ため、予算超過トピックは先頭のみのサンプルに正直に縮退し（tail は `null`・summary の `note` に明記）、段差検出は無効化される（予算内トピックは全読みなので検出可能なまま）。中央値窓による段差検出は**収録の最後 1 割程度に落ちた段差を取り逃し得る**（definition に明記）。params: `threshold_ms` / `max_samples_per_topic` / `target_topics`（glob）。レポート: `data/report/clock_check/<capture_id>/summary.json`。
- **`video_check`** — オンデマンド（params `{topic}`）の `CompressedImage`→mp4 プレビュー。PyAV（`av` + `Pillow`）で生成し、これらは**遅延 import**するためパッケージ不在でもサービスは起動できる（不在時は明確な失敗ジョブになる）。出力は `data/report/video_check/<capture_id>/<topic>.mp4`、`GET /api/v1/files/...` で配信。エンコード上限は params `max_frames`（**`0` = 全フレーム**）。既定は env `VIDEO_MAX_FRAMES`（未設定 = `0` = 全編。レビューは全編を見るという 2026-08-07 の裁定。エンコード時間/ディスクが問題になる設置だけ cap を置く。壊れた値は「全編」へフォールバック — 黙って短く切れるプレビューの方が遅いプレビューより悪い）。fps 推定のケイデンスサンプルは cap と独立に有界（`FPS_SAMPLE_FRAMES`）。エンコーダは env で調整可 — `VIDEO_ENCODE_THREADS`（既定 4。1 プレビューが箱を飽和させない上限）/ `VIDEO_ENCODE_PRESET`（既定 medium = x264 自身の既定。**既定は画質を一切落とさない** — この動画はカメラ健全性の判定材料でもあり、コーデックのつぶれはカメラ劣化と見分けられないため）/ `VIDEO_ENCODE_CRF`（既定 23）。実測（720p・最悪ケースのノイズ 300 frame）: threads 1→4 で 14.7s→7.5s（画質同一）、preset veryfast まで下げると 4.6s。上限で切れた summary は `truncated: true` と実メッセージ総数を持ち、UI は「head only」表示と **Re-encode full episode** ボタン（`{force: true, max_frames: 0}` を再発行）を出す。再生 fps はフレーム時刻のケイデンスから推定し、loss_report と同じ規則で **`publish_time` 優先・`log_time` フォールバック**（使ったクロックは summary の `fps_time_source` に明記）。mp4 は一時ファイルへエンコードしてアトミックに rename するため、再エンコードの途中失敗で配信中の mp4 は壊れない。(capture_id, topic) キャッシュは cap 整合を判定する（truncated キャッシュは全長要求のミス、untruncated で要求 cap 内ならヒット）。
- **`signal_report`** — ロボット非依存の**汎用**数値時系列抽出（JointState 専用ではなく、wrench / odom / cmd_vel など**数値リーフを持つ任意のメッセージ**が対象）。完了した MCAP を 1 回だけスキャンし（「全数値リーフ一括」）、topic_probe の Signals プロッタと**同じ `field_introspect` ロジック**（`libs/kairos_common` に共有）で各メッセージの数値リーフを走査する。パスは `pose.position.x` / `position[2]` のようなドット/添字表現で、**ライブ表示と同じ語彙**（UI で見えた値がサイドカー内で同じパスで引ける）。フィールド集合は各トピックの**先頭メッセージ**から決定し（bagel の episode-0 スキーマ方式。後続メッセージで欠けたリーフは `null`）、メッセージごとに全数値リーフ値を抽出、`max_points`（既定 2000）を超えないよう**均一ストライドでダウンサンプル**して 1 つのサイドカーに書く。**画像トピック（`sensor_msgs/msg/Image` / `CompressedImage`）は除外**（video_check の担当）、数値リーフが無いトピック・録画に存在しないトピックも除外し、いずれも理由付きで `skipped_topics` に記録する。トピックごとの**連続性スコア** `continuity` は**ダウンサンプル前の全解像度**の到着間隔から算出する: `1 - sum(gap - 1.5*median_interval for gaps > 1.5*median_interval)/duration`（`[0,1]` にクランプ。メッセージ 2 未満／継続時間 0 は `null`）。中央値をケイデンス基準に使うことで、少数の長いギャップに対して頑健になる（典型間隔の 1.5 倍を超えた**超過分だけ**が連続性を下げ、全体の継続時間で正規化する）。時刻は loss_report / video_check と同じ規則で **`publish_time` 優先・`log_time` フォールバック**（使ったクロックはトピックごとに `time_source` に明記）。出力: `data/report/signal_report/<capture_id>/summary.json`。フロントエンド（Review「Data integrity」）は loss_events / bins / continuity を集約タイムライン＋イベント表＋サマリとして表示し video_check の mp4 と同期する（**数値 `fields` はサイドカーに残るが、v2 UI は生波形チャートを描かない** — 2026-07-15 撤去。ライブ波形は topic_probe の Signals ビュー）。サイドカー構造:
  ```json
  {
    "pipeline": "signal_report", "version": "1.1.0", "capture_id": "...",
    "generated_at": "<iso8601>", "params": {"topics": null, "max_points": 2000},
    "span": {"duration_ns": 20034502235},
    "topics": {
      "/hsrb/joint_states": {
        "msg_type": "sensor_msgs/msg/JointState",
        "message_count": 1780, "start_ns": 0, "end_ns": 0,
        "start_offset_ns": 0,
        "continuity": 0.98,
        "continuity_definition": "1 - sum(gap - 1.5*median_interval for gaps > 1.5*median_interval)/duration, clamped to [0,1]",
        "time_source": "publish_time",
        "downsample": {"stride": 3, "points": 594},
        "t_ns": [ /* start_ns 相対・先頭 0・トピック共有・ダウンサンプル済み・≤max_points */ ],
        "fields": {"position[0]": [ /* t_ns と整列、欠損は null */ ], "...": []},
        "truncated_fields": 0,
        "loss_events": [
          {"start_ns": 5100000000, "duration_ns": 400000000, "estimated_lost": 11, "severity": "major"}
        ],
        "edges": {"start_delay_ns": 0, "end_early_ns": 120000000},
        "bins": {"count": 600, "bin_ns": 33390837, "densities": [3, 3, 0, 4]}
      }
    },
    "skipped_topics": {"/cam/image": "image topic (use video_check)"}
  }
  ```
  `t_ns` は **`start_ns` 相対**（先頭要素は 0）で出す: 絶対エポックナノ秒（〜1.75e18）は JS の `Number.MAX_SAFE_INTEGER`（〜9.007e15）を超えて量子化されるため、チャート x 軸はエピソード相対にする。`start_ns` / `end_ns` は絶対値（選択クロック）をメタデータとして保持する（JS でサブマイクロ秒演算はしない）。`t_ns` はトピックごとに共有（1 トピックの全フィールドが同じ到着時刻を使う＝時刻配列をフィールドごとに複製しない）。`truncated_fields` は 1 トピック当たりの表示上限（`field_introspect` の 256 リーフ上限）を超えて捨てたリーフ数。
  - **ロス位置の可視化（v1.1）** — 同じ 1 回のスキャンで、Review の集約 integrity タイムライン用に**ロスイベントと時間ビン**も出す（2026-07-15 に UI をトピック別ヒートマップ→1 レーン集約タイムライン＋ランク順イベント表へ再設計。[frontend.md](frontend.md) Review 参照）。まず**エピソード全体の相対クロック**を 1 つ定義する: グローバル零点 = 全**対象トピック**の全解像度タイムスタンプの最小値、`span.duration_ns` = 最大値 − 最小値。以下の 3 フィールドはこのグローバル軸上の値（`t_ns` 同様に小さく JS 安全）:
    - **`start_offset_ns`** = トピック先頭タイムスタンプ − グローバル零点。
    - **`loss_events`** — トピックの**全解像度**到着間隔から算出（間隔が 4 未満なら空）。しきい値 = 中央値間隔 × 1.5。しきい値を**超える**間隔 1 つが 1 イベントで、`start_ns` = （直前メッセージ時刻 − グローバル零点）、`duration_ns` = その間隔、`estimated_lost` = `max(0, round(interval/median) - 1)`、`severity` = `estimated_lost >= 3` で `"major"` それ以外 `"minor"`。中央値が 0（同一スタンプの連続）なら空。リストはトピック当たり最大 200 件（**duration 降順**）に制限し、超過分は `"loss_events_truncated": <捨てた件数>` で明示（暗黙の切り捨て禁止）。
    - **`edges`** — `start_delay_ns` = トピック先頭 − グローバル零点、`end_early_ns` = グローバル終端 − トピック末尾。常に存在（無ければ 0）。
    - **`bins`** — グローバル span を固定 600 分割（`bin_ns = ceil(duration/600)`、最終ビンは短くなりうる）。`densities` は全解像度タイムスタンプから数えた各ビンのメッセージ数（合計 = `message_count`）。メッセージ 2 未満のトピックは `"bins": null`。

    既存の `t_ns` はトピック相対のまま（チャート契約は不変）。フロントエンドは `start_offset_ns` でチャート時刻 ↔ グローバル軸を換算する。
- **`params.dataset_dir` は廃止**（v2）— dataset が論理化されて収録の実体が動かなくなったので、「録画中の場所」と「エクスポート後の場所」を切り替える必要が消えた。`loss_report` / `clock_check` / `video_check` / `signal_report` はすべて `objects/<capture_id>` を読み、出力・キャッシュは `data/report/<pipeline>/<capture_id>/` に固定される。dataset に入れても外しても、レポートも mp4 キャッシュもそのまま有効。

## `fast_validation`: 必須トピックゲート（**実 dora 実行**）

全録画が通る既定のゲート。「この bag に、運用者が必須と宣言したトピックが入っているか」だけを見る。

- **検証テンプレート**（YAML / JSON）: そのデータセット / ロボットで必須のトピックを定義する。
  ```yaml
  name: hsr_teleop_v1
  version: 1
  required_topics:
    - { name: "/joint_states", type: "sensor_msgs/msg/JointState" }  # type は任意
    - { name: "/camera/*/image_raw" }                                 # glob 可
  # 任意: expected_hz, min_duration_s などは後で追加
  ```
- **テンプレート自動生成**: 既存の良好な run の topic 一覧（`metadata.yaml` / MCAP）から雛形テンプレートを生成 → 人が取捨選択して確定する（`POST /validation/templates/generate`。`validation.py`）。
- **実行エンジンは bagflow**（`full_validation` と同じ。下の節がフロー・判定・実行環境の共通仕様）。
  違いは**フローが誰のものか**だけ:
  - フローは**サービス同梱** = `services/dora_runner/flows/fast_validation.yml`（イメージ内 `/opt/kairos/flows/`）。
    運用者がフローを 1 本も書いていないロボットでも動く。
    `config/<robot>/flows/fast_validation.yml` を置けば**そちらが優先**される（探索順＝ロボット config → 同梱）。
  - 検査ノードは `bagflow-topic-presence` 1 本のみで、**トピックを 1 本も購読しない**（`metadata.yaml` の
    トピック一覧だけを見る）。したがって **MCAP は 1 バイトも読まれず、実行時間は bag のサイズに依存しない**
    （4.4GB でも 30MB でもほぼ同じ）。「速い」ことがこのパイプラインの存在意義なので、
    デコードするノードを足すのは `full_validation`（＝ロボット config 側）で行う。
  - `${KAIROS_REQUIRED_TOPIC_SPECS}`（`[{name, type}]`）でテンプレをノードへ渡す。`name` は glob（fnmatch）、
    `type` は省略可＝型不問。**メッセージ 0 件のトピックも「存在する」**とみなす（全トピック録画の bag は
    service 応答トピックが常時 0 件になるため）。最低件数を要求したければフローの `MIN_MESSAGES` を上げる。
- 出力 `summary.json`: `{ template, result: "pass"|"fail", missing: [], extra: [], checked_at, engine: "bagflow", … }`。
  `missing` / `extra` / `result` は**フロントエンドとの契約**（Validation 画面の必須トピック・チェックリストが
  そのまま読む）で、in-process 実装からの移行で変えていない。`missing[].reason`（`topic not in bag` /
  `message type mismatch` / 件数不足）と bagflow 由来の `checks` / `metrics` が追加分。
- **v1（in-process）からの移行**: `validator()` の Python 実装は廃止し、glob・型照合は
  `bagflow-topic-presence`（Rust・単体テスト付き）が持つ。`summary.json` の `version` は `2.0.0`、
  `engine: "bagflow"` が付く（v1 が書いたファイルにこのキーは無い）。

## `full_validation`: 宣言的フロー（**実 dora 実行**）

録画後の重い検証（デコード・画質・欠落）を、**YAML で宣言したフローとして実 dora 上で**回すパイプライン。
実行エンジンは `fast_validation` と共通で、同梱の **bagflow**
（`services/dora_runner/bagflow/`、ベンダリング元と改変点は同ディレクトリの `VENDOR.md`）。
共通の実行機構（ジョブごとの実体化・タイムアウト・後始末・成果物）は `bagflow_pipeline.py` にあり、
両パイプラインはそこへ「どのフローを・どう要約するか」だけを渡す。

```mermaid
flowchart TB
  A["config/&lt;robot&gt;/flows/&lt;flow&gt;.yml<br/>運用者が書く（＝bagflow の flow.yml そのもの）"]
  B["data/report/full_validation/&lt;capture_id&gt;/flow/flow.yml"]
  C["report.json"]
  D["summary.json（pass / fail）"]
  A -->|"実体化: bag/report 注入・${KAIROS_*} 展開・path 解決"| B
  B -->|"bagflow run --no-attach --name &lt;job_id&gt;<br/>（自前 dora coordinator 上で dataflow 生成・実行）"| C
  C -->|"アダプタ bagflow_summary.py"| D
```

### フローと config の関係

- フローは **kairos 方言ではない**。`config/<robot>/flows/*.yml` は bagflow の flow.yml をそのまま置く
  （`bag:` / `report:` は kairos が capture ごとに注入するので書かない）。ジョブは `params.flow`（既定 `default`）で
  選び、`GET /pipelines` の `params_schema` には**発見できたフロー名が enum で載る**ので、UI のフォームは
  自動でピッカーになる。ワンクリック実行は `validation_presets.yaml` に `{pipeline: full_validation,
  params: {flow: …}}` を足すだけ（UI 改修不要）。
  **フローの探索順**: `full_validation` はロボット config のみ（`params.flow` で選ぶ）。`fast_validation` は
  ロボット config → サービス同梱（`/opt/kairos/flows/`）の順で、`params.flow` を持たない（フロー名は固定で
  `fast_validation`＝同名ファイルを config に置くことが上書き手段）。
- **`${KAIROS_*}` 置換**が「検証テンプレ（Console v2 の **Settings → Validation** で選ぶ。v1 UI では Config タブ）」とフローの結節点。文字列値の中に書ける:
  | トークン | 中身 |
  |---|---|
  | `${KAIROS_EXPECT_HZ}` | `{topic: hz}` の JSON。**必須トピックは `hz=0`**（＝存在必須・レート不問。`bagflow-topic-rate` は bag に無いトピックを失敗として報告し、0 を下回るレートは存在しない）。`RECORDING_CONFIG` の `expected_hz_patterns` に一致するトピックは実レートで上書き |
  | `${KAIROS_REQUIRED_TOPICS}` | 必須トピック**名**の JSON 配列（名前しか要らないノード向け） |
  | `${KAIROS_REQUIRED_TOPIC_SPECS}` | 必須トピックの `[{name, type}]` JSON 配列（宣言された**メッセージ型**まで見るノード向け＝`bagflow-topic-presence`）。`fast_validation` の同梱フローが使う |
  | `${KAIROS_CAPTURE_ID}` / `${KAIROS_BAG_DIR}` / `${KAIROS_REPORT_DIR}` / `${KAIROS_REPORT}` | capture と出力先（**`${KAIROS_RUN_ID}` は廃止** — 未知の `${KAIROS_…}` はエラーなので、古いフローは黙って通らず失敗する） |
  - 必須トピックの出どころは **`params.template` →（無ければ）`RECORDING_CONFIG.validation.required_topics`**。
    orchestrator は `fast_validation` と同様に `full_validation` でもテンプレ id を実体へ解決して注入するので、
    **Settings → Validation でテンプレを選ぶと 2 つのパイプラインが同じ必須トピック定義を見る**。
    未指定時に「run 自身から生成した雛形」へフォールバックは**しない**（それでは検査が自明に真になる）。
  - 未知の `${KAIROS_…}` は**エラー**（黙って素通しさせない）。
- **node `path` の解決**: 名前だけ（`bagflow-blur`）＝同梱バイナリ、相対パス＝**元のフローファイルの
  ディレクトリ基準**（実体化で場所が変わっても壊れない）、絶対パス＝そのまま。
- 実体化先が `/config` ではなく `data/report/.../flow/` なのは、bagflow/dora が**フローファイルの隣に書く**ため
  （`.bagflow/dataflow.yml`・`.bagflow/out/<uuid>/log_<node>.txt`）。`/config` は読み取り専用マウント。

### 判定（総合 pass/fail の所在）

bagflow は「事実」だけを報告する（ノードごとの `ok`・エッジごとの `coverage`・異常終了ノードの `incomplete`）。
**総合判定は kairos 側のアダプタが決める**（`bagflow_summary.summarize`）:

- `ok: false` のチェックが 1 つでもあれば **fail**（ソース自身の `source_read` を含む＝途中で切れた MCAP は fail）
- `incomplete` が空でなければ **fail**（そのノードの検査は実行されていないので「失敗なし」は嘘になる）
- チェック結果が 1 件も無ければ **fail**
- `coverage`（各エッジが bag のどれだけを実際に見たか）が `params.min_coverage` 未満なら **fail**。
  既定 `0` は**ゲートせずに数字だけ出す**（キューあふれによる間引きは coverage に必ず出る＝黙って欠けない）。

出力は `data/report/full_validation/<capture_id>/` に `summary.json`（判定）・`report.json`（bagflow 原本）・
`flow/`（実体化フローと各ノードのログ）。summary は汎用 `SummaryResult` がそのまま描ける形
（`metrics.coverage` は 0-100 で、Validation 画面のカバレッジ列がそのまま読む）。**フロー開始前に前回の
`summary.json` / `report.json` を消す**ので、失敗したのに前回の合格が残って「検証済み」に見えることはない。

**ジョブ失敗と検証 fail の区別**（kairos の既存規約）: フローが走って「録画が悪い」と判定したら
**成功ジョブ + `result: fail`**。フローが判定を出せなかった（入力欠落・フロー不正・dataflow の異常終了/
タイムアウト）場合は**ジョブ自体を失敗**させ、`details` にノードログの位置を載せる（summary.json は書かない
＝その run は未検証のまま）。

### 実行環境（4つの運用上の必須事項）

1. **自前の dora coordinator/daemon**。全サービスが `network_mode: host` で、dora 0.5 の `dora up` は
   既定ポート（6012）しか掴めない＝ホスト上の他の dora と衝突しうる。そこで dora_runner は
   `dora coordinator` / `dora daemon` を**自分で loopback 限定の別ポートに起動**する
   （`KAIROS_DORA_CONTROL_PORT` 6112 / `KAIROS_DORA_DAEMON_PORT` 53390 /
   `KAIROS_DORA_DAEMON_LISTEN_PORT` 53391）。同梱 bagflow CLI は `DORA_COORDINATOR_ADDR/PORT` で
   そこへ向く（`VENDOR.md`）。サービス停止時は自分の coordinator を `dora destroy` する。
   **ready の定義は「ポートが開く」ではなく「dataflow を start できる」**。coordinator は bind した
   瞬間から TCP を受けるが、**daemon が coordinator に登録し終わるまで `dora start` は
   `no unnamed daemon connections` で失敗する**（実測でこの窓は存在する）。起動時は
   `dora check`（= `system status`。daemon 未登録なら exit 1）が通るまで待ってから ready にする。
   これを待たないと**サービス再起動直後の 1 本目の検証ジョブが必ず失敗する**（`/readyz` は 200 を
   返しているのに、である）。
2. **`shm_size` が必須**。dora はノード間メッセージを全て `/dev/shm` に置き、**Docker 既定の 64MB では
   枯渇したノードがログを 1 行も残さずに死ぬ**。compose は `shm_size: 2gb`（`DORA_RUNNER_SHM_SIZE`）。
3. **タイムアウトは 3 段**（短い順に、診断が濃い層が先に鳴る）: `bagflow run --timeout`
   （`KAIROS_BAGFLOW_TIMEOUT_S` 既定 600s。どのノードのプロセスが消えたかを出す）→ サブプロセスの +30s 猶予
   → ジョブ全体の `KAIROS_DORA_JOB_TIMEOUT_S`（既定 900s）。
4. **後始末は名前指定で行う**。dora 0.5 はノードの異常終了を下流に伝播しないため、生き残ったノードは
   EOS を待って止まり `/dev/shm` を掴み続ける。失敗・タイムアウト・キャンセルのたびに
   `dora stop --name <job_id>`（残っていれば `--force`）を実行する。dora 0.5 に `stop --all` は無く、
   「動いているもの全部止める」も**実装しない**（自前 coordinator なので `dora destroy` が同義かつ安全）。

同梱ノード（Rust）: `bagflow-decode`（JPEG→生フレーム）/ `-blur` / `-brightness` / `-freeze` /
`-stamp-gap` / `-topic-rate` / `-topic-presence`（`fast_validation` 用・kairos 追加）。
実測 **0.56s wall・3.7 CPU秒**（101秒・780MB・29トピック・VGA 3037 フレームの bag、
`dora up` 済み warm）。**Python 版チェックノードと CUDA デコードは同梱しない**（前者は pyarrow/dora-rs/opencv が
必要、後者は小画像では CPU 版より遅い実測）＝ `VENDOR.md` に理由を記載。

## 出力

- `/data/report/<pipeline>/<capture_id>/`（`summary.json` / preview / logs）
- `/data/converted/<capture_id>/`（`dataset_convert` の出力。例: 学習用形式）
- job record（ユーザー向けの正は **`api_orchestrator` の SQLite**。dora_runner 自身も内部状態を永続化する＝下記「永続化と再起動リコンサイル」）

## 永続化と再起動リコンサイル

- **job / validation template を SQLite に永続化**する（`store.py`。既定 `<data_dir>/dora_runner.db`＝`report/` ツリーと同じデータディレクトリ直下。`api_orchestrator.store` と同じ規約: `threading.RLock` でコネクションを直列化し、`PRAGMA user_version` でスキーマ版を記録）。以前は in-memory で、プロセス再起動で job/template が消えていた（release-readiness の F4/MS-6）。
- **実行系は in-process のまま**（分散キューではなく、永続化するのは**状態**）。実行中の job は `asyncio.Task` を持つ live な `JobRecord` として保持し、状態遷移（queued → running → 終端）ごとに行へ**チェックポイント**する（ログ 1 行ごとには書かない）。`logs_tail` は終端行にそのまま保存される。
- **再起動リコンサイル**: 起動時（`create_dora_app`）に `queued` / `running` のまま残った job を終端の `failed` へ確定し、理由を `summary` に載せる（`{result:"fail", reason:"interrupted", error:{code:"job_interrupted", message:"dora_runner restarted while the job was in flight."}}`）＋ `logs_tail` に注記を追記する。`JobState` に `interrupted` 値は無く、全消費側が終端とみなすのは succeeded/failed/canceled のみなので、**interrupted は `failed` に集約し理由を summary に持たせる**（timeout と同じ表現）。これにより `datasets._job_failure_reason` と Validation タブの汎用レンダラがそのままユーザーへ提示でき、orchestrator / frontend の改修は不要。
- `GET /jobs/{id}/status` / `GET /jobs/{id}/result` は live な `JobRecord` を優先し、無ければ SQLite の行から応答する（再起動後に worker が消えた job も終端状態・結果を返せる）。

## API（サービス内部 API。公開は `api_orchestrator` 経由）

- `POST /jobs` — `{ capture_id, pipeline, params? }` → `{ job_id }`
- `GET /jobs/{id}/status` — `{ state: "queued"|"running"|"succeeded"|"failed"|"canceled", progress, logs_tail, cancel_requested }`
- `GET /jobs/{id}/result` — `{ summary, artifacts: [] }`
- `POST /jobs/{id}/cancel` — **協調キャンセル**（2026-08 改修）。`queued` の job は即座に `canceled`（worker は開始前に honour する）。**`running` の job に対しては「要求」であって「状態」ではない**: 応答は `running` + `cancel_requested: true` のままで、worker が次のチェックポイント — bagflow は subprocess 監視（0.5 秒間隔で cancel event を見て CLI を kill + `dora stop` で dataflow 掃除）、in-process 系（loss_report / signal_report はメッセージごと、video_check はフレームごと）は cancel event の検査 — で実作業を実際に止めたときに初めて `canceled` になる。以前は shield 下の threadpool / subprocess が完走し続けるのにラベルだけ `canceled` になり、orchestrator が lease を解放して走行中ジョブの capture が削除できてしまった（timing sweep S1-1/S1-2）。チェックポイントに到達する前に作業が完了した場合は `succeeded` のまま（cancel が間に合わなかった、という正直な結末）。クライアントは cancel 応答でポーリングを止めてはならず、終端状態まで見続ける。
- `GET /pipelines` — 利用可能 pipeline（dataflow）一覧
- 検証テンプレート: `GET/POST /validation/templates`、`POST /validation/templates/generate`（capture から雛形生成。body `{ capture_id }`）
- `GET /healthz` / `GET /readyz`

## データフロー

MCAP → dora dataflow（validator / converter / AI nodes）→ reports / converted dataset

検証 1 ジョブの実体（2026-07-26 現在。`fast_validation` / `full_validation` は同じ機構）:

```mermaid
flowchart LR
  subgraph orc["api_orchestrator（別コンテナ）"]
    J["POST /api/v1/jobs<br/>テンプレ id を実体へ解決"]
  end

  subgraph runner["dora_runner コンテナ（この仕様の範囲）"]
    API["FastAPI + job store<br/>(SQLite)"]
    REG["pipeline registry"]
    PIPE["bagflow_pipeline.py<br/>実体化・timeout・後始末"]
    SUM["summarize()<br/>report.json → summary.json"]

    subgraph dora["同梱 bagflow + dora 0.5（イメージ内のみ）"]
      CO["dora coordinator/daemon<br/>127.0.0.1:6112 loopback"]
      SRC["bagflow-source"]
      CHK["検査ノード群<br/>-topic-presence / -topic-rate<br/>-decode / -blur / -brightness<br/>-freeze / -stamp-gap"]
      RPT["bagflow-report"]
    end
  end

  FLOWB[/"同梱フロー<br/>/opt/kairos/flows/fast_validation.yml"/]
  FLOWC[/"ロボット config（読み取り専用）<br/>config&lt;robot&gt;/flows/*.yml"/]
  BAG[("/data/objects/&lt;capture_id&gt;<br/>*.mcap + metadata.yaml")]
  OUT[("/data/report/&lt;pipeline&gt;/&lt;capture_id&gt;/<br/>summary.json · report.json · flow/")]

  J --> API --> REG --> PIPE
  FLOWC -. "同名なら優先" .-> PIPE
  FLOWB --> PIPE
  PIPE -->|"bagflow run --name job_id"| CO
  CO --> SRC
  BAG -.->|"full のみ実データを読む<br/>fast は metadata だけ"| SRC
  SRC --> CHK --> RPT --> SUM --> OUT
```

## 設計ポイント

- validator / converter / AI は dora node（プラグイン）。I/O は契約。
- 重い処理は非同期ジョブ。進捗は SSE で `api_orchestrator` → frontend。
- dora dataflow として拡張（node 追加・差し替え・連結）。**AI node を一級市民**として扱う。
- backend-driven: pipeline 定義・フォーム schema は `api_orchestrator` が frontend に配布する（Validation タブ等の実行フォーム）。
- 共有設定は [config](config.md)。

## 実装状況と開発ガイド

本書は**設計の正本（将来像を含む）**。**現状の有効 pipeline は `fast_validation` / `full_validation` /
`loss_report` / `clock_check` / `video_check` / `signal_report`** の 6 本（上記「実装済みパイプライン」参照）。
`dataset_convert` / `dataset_validation` は I/F だけ（`enabled=false`。`POST /jobs` は
`pipeline_unavailable` で拒否）。

**実装済み**: **Plugin/Pipeline Registry**（`registry.py` の `build_default_registry()` が同梱 5 本を登録し、
`plugin_loader.discover_plugins()` が `KAIROS_PLUGINS_DIR`（既定 `services/dora_runner/plugins/`）配下の
manifest をスキャンして自動登録する。例として `hello_dora` プラグインを同梱）、**dora dataflow の
in-process インタプリタ**（プラグインの `executor: dora` は下記の理由で in-process 実行）、
**ジョブの並行度上限・per-job timeout**（`KAIROS_DORA_MAX_CONCURRENCY` / `KAIROS_DORA_JOB_TIMEOUT_S`）、
**job/template の SQLite 永続化と再起動リコンサイル**（上記「永続化と再起動リコンサイル」）。
各パイプラインの重い読込・エンコードは worker スレッドに退避する
（`POST /validation/templates/generate` の MCAP summary 読みも `to_thread` — event loop 上での同期読みは
実行中の全 endpoint を止めていた。2026-08-11, sweep S4）。

**per-job timeout は作業を実際に止める**（2026-08-11, sweep S2-4）。期限超過は cancel と同じ協調機構
（`cancel_event` → worker のチェックポイントで subprocess kill / デコード停止）を発火し、猶予 30 秒
（`_TIMEOUT_STOP_GRACE_S`）で結末を見届けてから確定する: (a) 猶予内に**止まった** → `failed`
（`reason: timeout`、「the work was stopped」）でスロットは実際に解放される。(b) 猶予内に**完走した** →
`succeeded`（期限は wall-clock の上限であって、終わった仕事を failed に塗り替える装置ではない）。
(c) 止まらなかった → `failed` で「still running; slot stays held」と明記（スロットはスレッド終了まで
保持 — 従来はこれが唯一の挙動で、全編エンコードの長尺 bag が偽 failed＋スロット死蔵になっていた）。
API cancel が先に要求していた場合は `canceled` が勝つ（BUG-D と同じ規則）。

**dora の同梱状況（2026-07-26 更新）**: **dora CLI（0.5.0）と同梱 bagflow の Rust ノードは dora_runner
イメージに入っている**。実 dora で動くのは **検証 2 本（`fast_validation` / `full_validation`）**で、
プラグインの `executor: dora` は従来どおり in-process インタプリタで実行する（プラグインの dataflow を
実 dora へ載せ替えるのは別作業）。したがって `/readyz` は 2 成分を誠実に返す: `components.dora`（`dora` バイナリの
有無 = `available` / `in-process`）と `components.bagflow`（bagflow バイナリの有無 = `available` /
`unavailable`）。`/pipelines` の各 `PipelineDefinition` も宣言上の `executor` とは別に
`effective_executor`（実際にどう動くか）を返す。イメージ以外（ソース実行 / CI）では bagflow が無いので
`fast_validation` / `full_validation` はどちらも `enabled=false` に落ちる。**AI node（推論・LeRobot 変換）**は未実装。

validation チェックの追加方法・単体試験・ローカル CLI（`python -m dora_runner.cli`）でのデバッグ手順は、
開発者ガイド [docs/dora/README.ja.md](../../dora/README.ja.md) を参照。

**dora dataflow 化 & プラグインシステムの実装方針**（将来像）は [dora_plugins.md](dora_plugins.md) に確定
（全 pipeline の dataflow 化・`plugins/<name>` の manifest scan 自動登録・段階移行プラン）。現状のプラグインは
**in-tree**（submodule ではなく `services/dora_runner/plugins/` に直置き）で、dora daemon は将来の投資として
枠だけ用意している。
