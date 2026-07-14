# dora_runner 仕様

> ステータス: 設計確定（v1）。`fig_const/dora.png` を基に、未記載事項を推奨設計として確定。日本語が正本（これを正とする）。英語版 `docs/specs/en/dora_runner.md` は自動生成ミラー（直接編集しない）。**認証は不要。**

記録後の **検証・変換・拡張処理パイプライン**コンテナ（**dora** ベース）。記録済み MCAP を入力に、検証・変換・**AI 処理**を非同期ジョブで実行する。重い処理はすべてここに集約し、`rosbag2_recorder` / `topic_monitor` は軽量に保つ。**dora の拡張性と AI 連携を最大限活かす**ことを設計の中心に置く。

## 役割

- 記録済み MCAP に対して、検証 / 変換 / 拡張（AI 含む）を行う。
- 各処理を差し替え・連結可能な部品として組み立てられるようにする。

## 設計の中心: dora 拡張性 & AI 連携

- 各処理（validator / converter / **AI node**）は **dora node（プラグイン）**として実装し、**dora dataflow（YAML）**で接続する。
- **Plugin Registry** が node を登録し、**Pipeline Registry** が dataflow（= pipeline）を管理する。**pipeline 追加 = dataflow YAML + node 追加**で済み、コア改修は不要。
- node の **I/O は契約（contract）**として固定する:
  - 入力: `run`（パス / metadata / manifest）、MCAP メッセージ反復子（topic フィルタ・時間範囲指定可）、`params`。
  - 出力: `metrics`（dict）、`artifacts`（生成物パスのリスト）、`report` 断片。
  - これにより node を自由に差し替え・連結できる。
- **AI 連携を一級市民にする**: 推論 / 自動アノテーション / 埋め込み・検索インデックス / 品質スコアリング / 学習用データセット変換（例: **LeRobot** 形式）を **AI dora node** として差し込める。
  - node I/F はモデル差し替え前提（`params.model` 等）。GPU 利用可（`--gpus` / 環境変数）。メッセージはバッチ処理可。
  - 再現性のため、report に pipeline / node / モデルのバージョンを記録する。
- dora dataflow なので、ストリーミング / 分散実行 / node 再利用が効く。

## 入力

- `/data/recorded/<run>/*.mcap`（+ `metadata.yaml` / `manifest.json`）
- pipeline 定義（dataflow YAML）
- config（[config](config.md)、検証テンプレート等）
- job record（`api_orchestrator` 由来）

## 構成コンポーネント

- **MCAP Loader** — `mcap` + `mcap-ros2-support` で読込（**rclpy 不要**、ファイル反復）。topic / 型 / 時刻 / サイズを取得し、必要時のみ decode。
- **Plugin Registry** — dora node（validator / converter / AI）の登録・発見。
- **Pipeline Executor** — dora dataflow の実行・順序制御。job ごとに timeout / リソース上限。
- **Result Writer** — レポート / 変換物の出力。
- **Job Status / Logs** — 状態・進捗・ログ（`api_orchestrator` へ SSE）。

## 実行可能パイプライン（図）

- `fast_validation` / `full_validation` / `dataset_convert` / `dataset_validation`
- **実装済み（`enabled=true`）**: `fast_validation` / `dataset_export` / `loss_report` / `video_check` / `signal_report`（下記）。`full_validation` / `dataset_convert` / `dataset_validation` は I/F とプラグイン枠のみ（`enabled=false`）。
- すべてのジョブは `POST /jobs`（`api_orchestrator` がプロキシ）経由で起動する。各パイプラインは `run_id`（`^[A-Za-z0-9_-]+$`）を検証してパストラバーサルを防ぐ。

## 実装済みパイプライン

- **`dataset_export`** — `recorded/<run_id>` を `data/<operator>/<task>/<NNN>` へ**移動**する（operator / task は run の `session.json` 由来。`NNN` は 001, 002… のゼロ詰め自動採番。パスコンポーネントはサニタイズ）。同一マウント上のファイル単位リネームなので大容量 bag でも高速。**移動後は `recorded/` から収録物が消える**（オーケストレータは完了した run のみ export し、`NNN` を確保してからファイルを移すため中断時もデータ消失しない）。`recorded/<run_id>` と兄弟ファイル（`.qos.yaml` / `.failed.json`）も削除し、`<NNN>/dataset.json` に来歴を保存。レポート: `data/report/dataset_export/<run_id>/summary.json`。バルク／個別の起動はオーケストレータの `POST /api/v1/datasets/export(-all)` 経由（成功後に run 行も削除）。
- **`loss_report`** — ロボット非依存・config 不要の per-topic ロス推定。完了した MCAP のメッセージ時刻から、トピックごとの**中央値の間隔**を求め、`loss ≈ 1 − actual/expected` を算出する（読み取りのみ・ペイロードを decode しない）。時刻は**送信側の `publish_time`（DDS source timestamp）を優先**し、受信側のジッタ（DDS 伝送・recorder のスケジューリング/キャッシュ）をケイデンス推定から排除する。ただし publish_time を信頼するのは「全メッセージが source stamp を持つ（**非ゼロ**かつ **log_time と異なる**）かつ **両クロックの記録窓が一致（2倍以内）**」する場合のみで、そうでなければ（旧 rosbag2 の `pub==log`、log/source 混在、`0`、送信側クロックのオフセット等）単一の受信側 `log_time` へフォールバックする＝publish_time 化で従来より悪化することはない。なお publish_time でも「ソース欠落」と「録画前の伝送ロス」は区別できない（録画前に落ちたメッセージは MCAP に無く publish_time も消える）ため、これは**測定ではなく推定**である。**どちらのクロックで計算したかはトピックごとに `time_source`（`"publish_time"` / `"log_time"`）として summary に明記**する（honesty 原則）。レポート: `data/report/loss_report/<run_id>/summary.json`。
- **`video_check`** — オンデマンド（params `{topic}`）の `CompressedImage`→mp4 プレビュー。PyAV（`av` + `Pillow`）で生成し、これらは**遅延 import**するためパッケージ不在でもサービスは起動できる（不在時は明確な失敗ジョブになる）。出力は `data/report/video_check/<run_id>/<topic>.mp4`、`GET /api/v1/files/...` で配信。エンコード上限は params `max_frames`（既定 900、**`0` = 全フレーム**）。上限で切れた summary は `truncated: true` と実メッセージ総数を持ち、UI は「head only」表示と **Re-encode full episode** ボタン（`{force: true, max_frames: 0}` を再発行）を出す。再生 fps はフレーム時刻のケイデンスから推定し、loss_report と同じ規則で **`publish_time` 優先・`log_time` フォールバック**（使ったクロックは summary の `fps_time_source` に明記）。mp4 は一時ファイルへエンコードしてアトミックに rename するため、再エンコードの途中失敗で配信中の mp4 は壊れない。(run_id, topic) キャッシュは cap 整合を判定する（truncated キャッシュは全長要求のミス、untruncated で要求 cap 内ならヒット）。
- **`signal_report`** — ロボット非依存の**汎用**数値時系列抽出（JointState 専用ではなく、wrench / odom / cmd_vel など**数値リーフを持つ任意のメッセージ**が対象）。完了した MCAP を 1 回だけスキャンし（「全数値リーフ一括」）、topic_probe の Signals プロッタと**同じ `field_introspect` ロジック**（`libs/kairos_common` に共有）で各メッセージの数値リーフを走査する。パスは `pose.position.x` / `position[2]` のようなドット/添字表現で、**ライブ表示と同じ語彙**（UI で見えた値がサイドカー内で同じパスで引ける）。フィールド集合は各トピックの**先頭メッセージ**から決定し（bagel の episode-0 スキーマ方式。後続メッセージで欠けたリーフは `null`）、メッセージごとに全数値リーフ値を抽出、`max_points`（既定 2000）を超えないよう**均一ストライドでダウンサンプル**して 1 つのサイドカーに書く。**画像トピック（`sensor_msgs/msg/Image` / `CompressedImage`）は除外**（video_check の担当）、数値リーフが無いトピック・録画に存在しないトピックも除外し、いずれも理由付きで `skipped_topics` に記録する。トピックごとの**連続性スコア** `continuity` は**ダウンサンプル前の全解像度**の到着間隔から算出する: `1 - sum(gap - 1.5*median_interval for gaps > 1.5*median_interval)/duration`（`[0,1]` にクランプ。メッセージ 2 未満／継続時間 0 は `null`）。中央値をケイデンス基準に使うことで、少数の長いギャップに対して頑健になる（典型間隔の 1.5 倍を超えた**超過分だけ**が連続性を下げ、全体の継続時間で正規化する）。時刻は loss_report / video_check と同じ規則で **`publish_time` 優先・`log_time` フォールバック**（使ったクロックはトピックごとに `time_source` に明記）。出力: `data/report/signal_report/<run_id>/summary.json`。フロントエンドは uPlot でチャート化し video_check の mp4 と同期する。サイドカー構造:
  ```json
  {
    "pipeline": "signal_report", "version": "1.0.0", "run_id": "...",
    "generated_at": "<iso8601>", "params": {"topics": null, "max_points": 2000},
    "topics": {
      "/hsrb/joint_states": {
        "msg_type": "sensor_msgs/msg/JointState",
        "message_count": 1780, "start_ns": 0, "end_ns": 0,
        "continuity": 0.98,
        "continuity_definition": "1 - sum(gap - 1.5*median_interval for gaps > 1.5*median_interval)/duration, clamped to [0,1]",
        "time_source": "publish_time",
        "downsample": {"stride": 3, "points": 594},
        "t_ns": [ /* start_ns 相対・先頭 0・トピック共有・ダウンサンプル済み・≤max_points */ ],
        "fields": {"position[0]": [ /* t_ns と整列、欠損は null */ ], "...": []},
        "truncated_fields": 0
      }
    },
    "skipped_topics": {"/cam/image": "image topic (use video_check)"}
  }
  ```
  `t_ns` は **`start_ns` 相対**（先頭要素は 0）で出す: 絶対エポックナノ秒（〜1.75e18）は JS の `Number.MAX_SAFE_INTEGER`（〜9.007e15）を超えて量子化されるため、チャート x 軸はエピソード相対にする。`start_ns` / `end_ns` は絶対値（選択クロック）をメタデータとして保持する（JS でサブマイクロ秒演算はしない）。`t_ns` はトピックごとに共有（1 トピックの全フィールドが同じ到着時刻を使う＝時刻配列をフィールドごとに複製しない）。`truncated_fields` は 1 トピック当たりの表示上限（`field_introspect` の 256 リーフ上限）を超えて捨てたリーフ数。
- **エクスポート後の読み出し（`params.dataset_dir`）** — `loss_report` / `video_check` / `signal_report` は省略可能な `dataset_dir`（`<operator>/<task>/<NNN>`、`data/` 相対）を受け付け、`recorded/<run_id>` の代わりに**エクスポート済みデータセットディレクトリの MCAP を読む**（`dataset_export` は移動のため、エクスポート後は `recorded/` に bag が無い）。出力・キャッシュは従来どおり **run_id キー**（`data/report/<pipeline>/<run_id>/`）のままなので、エクスポート前に生成した video_check の mp4 キャッシュはエクスポート後もそのまま再利用される（移動は mtime を保存する）。`dataset_dir` はちょうど 3 コンポーネントの単純名のみ許可（トラバーサル・予約名 `recorded`/`report`/`datasets` は `ValueError` → 失敗ジョブ）。

## 検証（v1）: 必須トピック + テンプレート

- **検証テンプレート**（YAML / JSON）: そのデータセット / ロボットで必須のトピックを定義する。
  ```yaml
  name: hsr_teleop_v1
  version: 1
  required_topics:
    - { name: "/joint_states", type: "sensor_msgs/msg/JointState" }  # type は任意
    - { name: "/camera/*/image_raw" }                                 # glob 可
  # 任意: expected_hz, min_duration_s などは後で追加
  ```
- **テンプレート自動生成**: 既存の良好な run の topic 一覧（`metadata.yaml` / MCAP）から雛形テンプレートを生成 → 人が取捨選択して確定する。
- **`fast_validation`**: 対象 run の topic 一覧をテンプレートと照合し、**必須トピックの過不足**を判定。decode 不要・短時間。
  - 出力 `summary.json`: `{ template, result: "pass"|"fail", missing: [], extra: [], checked_at }`。

## 出力

- `/data/report/<pipeline>/<run>/`（`summary.json` / preview / logs）
- `/data/converted/<run>/`（`dataset_convert` の出力。例: 学習用形式）
- job record（ユーザー向けの正は **`api_orchestrator` の SQLite**。dora_runner 自身も内部状態を永続化する＝下記「永続化と再起動リコンサイル」）

## 永続化と再起動リコンサイル

- **job / validation template を SQLite に永続化**する（`store.py`。既定 `<data_dir>/dora_runner.db`＝`report/` ツリーと同じデータディレクトリ直下。`api_orchestrator.store` と同じ規約: `threading.RLock` でコネクションを直列化し、`PRAGMA user_version` でスキーマ版を記録）。以前は in-memory で、プロセス再起動で job/template が消えていた（release-readiness の F4/MS-6）。
- **実行系は in-process のまま**（分散キューではなく、永続化するのは**状態**）。実行中の job は `asyncio.Task` を持つ live な `JobRecord` として保持し、状態遷移（queued → running → 終端）ごとに行へ**チェックポイント**する（ログ 1 行ごとには書かない）。`logs_tail` は終端行にそのまま保存される。
- **再起動リコンサイル**: 起動時（`create_dora_app`）に `queued` / `running` のまま残った job を終端の `failed` へ確定し、理由を `summary` に載せる（`{result:"fail", reason:"interrupted", error:{code:"job_interrupted", message:"dora_runner restarted while the job was in flight."}}`）＋ `logs_tail` に注記を追記する。`JobState` に `interrupted` 値は無く、`api_orchestrator` の `run_job_to_completion` が終端とみなすのは succeeded/failed/canceled のみなので、**interrupted は `failed` に集約し理由を summary に持たせる**（timeout と同じ表現）。これにより `datasets._job_failure_reason` と Validation タブの汎用レンダラがそのままユーザーへ提示でき、orchestrator / frontend の改修は不要。
- `GET /jobs/{id}/status` / `GET /jobs/{id}/result` は live な `JobRecord` を優先し、無ければ SQLite の行から応答する（再起動後に worker が消えた job も終端状態・結果を返せる）。

## API（サービス内部 API。公開は `api_orchestrator` 経由）

- `POST /jobs` — `{ run_id, pipeline, params? }` → `{ job_id }`
- `GET /jobs/{id}/status` — `{ state: "queued"|"running"|"succeeded"|"failed"|"canceled", progress, logs_tail }`
- `GET /jobs/{id}/result` — `{ summary, artifacts: [] }`
- `POST /jobs/{id}/cancel`
- `GET /pipelines` — 利用可能 pipeline（dataflow）一覧
- 検証テンプレート: `GET/POST /validation/templates`、`POST /validation/templates/generate`（run から雛形生成）
- `GET /healthz` / `GET /readyz`

## データフロー

MCAP → dora dataflow（validator / converter / AI nodes）→ reports / converted dataset

## 設計ポイント

- validator / converter / AI は dora node（プラグイン）。I/O は契約。
- 重い処理は非同期ジョブ。進捗は SSE で `api_orchestrator` → frontend。
- dora dataflow として拡張（node 追加・差し替え・連結）。**AI node を一級市民**として扱う。
- backend-driven: pipeline 定義・フォーム schema は `api_orchestrator` が frontend に配布する（Validation タブ等の実行フォーム）。
- 共有設定は [config](config.md)。

## 実装状況と開発ガイド

本書は**設計の正本（将来像を含む）**。**現状の有効 pipeline は `fast_validation` / `dataset_export` /
`loss_report` / `video_check` / `signal_report`** の 5 本（上記「実装済みパイプライン」参照）。`full_validation` /
`dataset_convert` / `dataset_validation` は I/F だけ（`enabled=false`。`POST /jobs` は
`pipeline_unavailable` で拒否）。

**実装済み**: **Plugin/Pipeline Registry**（`registry.py` の `build_default_registry()` が同梱 5 本を登録し、
`plugin_loader.discover_plugins()` が `KAIROS_PLUGINS_DIR`（既定 `services/dora_runner/plugins/`）配下の
manifest をスキャンして自動登録する。例として `hello_dora` プラグインを同梱）、**dora dataflow の
in-process インタプリタ**（`executor: dora` を宣言したプラグインも、後述の理由で in-process で実行）、
**ジョブの並行度上限・per-job timeout**（`KAIROS_DORA_MAX_CONCURRENCY` / `KAIROS_DORA_JOB_TIMEOUT_S`）、
**job/template の SQLite 永続化と再起動リコンサイル**（上記「永続化と再起動リコンサイル」）。
各パイプラインの重い読込・エンコードは worker スレッドに退避する。

**未実装 / 未同梱**: **Rust の dora CLI/daemon（coordinator）は同梱していない**。そのため `/readyz` は
`components.dora` に**実際の実行系**（`dora` バイナリがあれば `available`、無ければ `in-process`）を誠実に
返し、`status` は dora 不在でも `ready`（in-process で動くため）。`/pipelines` の各 `PipelineDefinition` も
宣言上の `executor` とは別に `effective_executor`（実際にどう動くか）を返す。**AI node（推論・LeRobot 変換）**は未実装。

validation チェックの追加方法・単体試験・ローカル CLI（`python -m dora_runner.cli`）でのデバッグ手順は、
開発者ガイド [docs/dora/README.ja.md](../../dora/README.ja.md) を参照。

**dora dataflow 化 & プラグインシステムの実装方針**（将来像）は [dora_plugins.md](dora_plugins.md) に確定
（全 pipeline の dataflow 化・`plugins/<name>` の manifest scan 自動登録・段階移行プラン）。現状のプラグインは
**in-tree**（submodule ではなく `services/dora_runner/plugins/` に直置き）で、dora daemon は将来の投資として
枠だけ用意している。
