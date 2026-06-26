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
- **実装済み（`enabled=true`）**: `fast_validation` / `dataset_export` / `loss_report` / `video_check`（下記）。`full_validation` / `dataset_convert` / `dataset_validation` は I/F とプラグイン枠のみ（`enabled=false`）。
- すべてのジョブは `POST /jobs`（`api_orchestrator` がプロキシ）経由で起動する。各パイプラインは `run_id`（`^[A-Za-z0-9_-]+$`）を検証してパストラバーサルを防ぐ。

## 実装済みパイプライン

- **`dataset_export`** — `recorded/<run_id>` を `data/<operator>/<task>/<NNN>` へ**移動**する（operator / task は run の `session.json` 由来。`NNN` は 001, 002… のゼロ詰め自動採番。パスコンポーネントはサニタイズ）。同一マウント上のファイル単位リネームなので大容量 bag でも高速。**移動後は `recorded/` から収録物が消える**（オーケストレータは完了した run のみ export し、`NNN` を確保してからファイルを移すため中断時もデータ消失しない）。`recorded/<run_id>` と兄弟ファイル（`.qos.yaml` / `.failed.json`）も削除し、`<NNN>/dataset.json` に来歴を保存。レポート: `data/report/dataset_export/<run_id>/summary.json`。バルク／個別の起動はオーケストレータの `POST /api/v1/datasets/export(-all)` 経由（成功後に run 行も削除）。
- **`loss_report`** — ロボット非依存・config 不要の per-topic ロス推定。完了した MCAP のメッセージ log_time から、トピックごとの**中央値の到着間隔**を求め、`loss ≈ 1 − actual/expected` を算出する（読み取りのみ・ペイロードを decode しない）。レポート: `data/report/loss_report/<run_id>/summary.json`。
- **`video_check`** — オンデマンド（params `{topic}`）の `CompressedImage`→mp4 プレビュー。PyAV（`av` + `Pillow`）で生成し、これらは**遅延 import**するためパッケージ不在でもサービスは起動できる（不在時は明確な失敗ジョブになる）。出力は `data/report/video_check/<run_id>/<topic>.mp4`、`GET /api/v1/files/...` で配信。フレーム上限 900。

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
- job record（**`api_orchestrator` の SQLite が正**）

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
- backend-driven: pipeline 定義・フォーム schema は `api_orchestrator` が frontend に配布する（Pipelines タブ）。
- 共有設定は [config](config.md)。

## 実装状況と開発ガイド

本書は**設計の正本（将来像を含む）**。**現状の有効 pipeline は `fast_validation` / `dataset_export` /
`loss_report` / `video_check`**（上記「実装済みパイプライン」参照）。`full_validation` / `dataset_convert` /
`dataset_validation` は I/F だけ（`enabled=false`）。Plugin/Pipeline Registry・dora dataflow（YAML）・
dora daemon・AI node・job/template の永続化は**未実装**で、各パイプラインは in-process の node 関数として
実装されている（重い読込・エンコードは worker のスレッドに退避）。

validation チェックの追加方法・単体試験・ローカル CLI（`python -m dora_runner.cli`）でのデバッグ手順は、
開発者ガイド [docs/dora/README.ja.md](../../dora/README.ja.md) を参照。
