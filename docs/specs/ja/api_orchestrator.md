# api_orchestrator 仕様

> ステータス: 設計確定（v1）。`fig_const/apiオーケストラ.png` を基に、未記載事項を推奨設計として確定。日本語が正本（これを正とする）。英語版 `docs/specs/en/api_orchestrator.md` は自動生成ミラー（直接編集しない）。**認証は不要。**

**ジョブ管理 / 状態管理 / API ハブ**コンテナ。frontend が話す唯一の公開 API（**単一入口**。REST / SSE の制御・状態を集約する。例外として WebRTC の映像・signaling のみ frontend が `webrtc_streamer` へ直接接続）。`rosbag2_recorder` / `topic_monitor` / `webrtc_streamer` / `dora_runner` は内部サービスで、orchestrator が指示・集約する。

## 役割

- Run / ジョブのライフサイクル一元管理。
- backend-driven config（設定・スキーマ・タブ構成をバックエンドが提供）。
- 各サービスへの指示と結果集約・通知のハブ。

## 入力

- Frontend からの操作（記録 Start/Stop、Run 登録、Pipeline 実行）
- `topic_monitor` からの live metrics（SSE）
- `dora_runner` からのジョブ結果・ログ（stage3）

## 構成コンポーネント

- **Run Manager** / **Manifest Manager** / **Pipeline Registry** / **Result Aggregator** / **WebSocket・SSE Hub** / **Settings Manager**
- feature ベースのルーター構成（`recording` / `topics` / `runs` / `events` / `pipelines` …）を推奨（`../rosbag-view` 準拠、疎結合）。

## 公開 API（`/api/v1`、無認証）

- 記録: `POST /api/v1/record/start`、`POST /api/v1/record/stop`、`GET /api/v1/record/status`（recorder へプロキシ）
- Run: `GET /api/v1/runs`（カーソルページング）、`GET /api/v1/runs/{id}`
- Topic: `GET /api/v1/topics`（一覧。**情報源は `topic_monitor` の `GET /topics` discovery をプロキシ**: `name` / `type` / `publisher_count` / `subscriber_count` / `qos` / `last_seen`）、`GET /api/v1/topics/status`（monitor 由来の live metrics）
- イベント: `GET /api/v1/events`（**SSE 集約**。契約は下記）
- Pipeline / Job（stage3。詳細は [dora_runner](dora_runner.md)）: `GET /api/v1/pipelines`、`POST /api/v1/jobs`、`GET /api/v1/jobs/{id}/status`、`GET /api/v1/jobs/{id}/result`、`POST /api/v1/jobs/{id}/cancel`
- 検証テンプレート: `GET/POST /api/v1/validation/templates`、`POST /api/v1/validation/templates/generate`（run から雛形生成）
- 設定: `GET /api/v1/config`（frontend 実行時設定: endpoints / tabs / defaults（`ros_domain_id` を含む）/ stream / schemas）、`GET/POST /api/v1/settings`
- 収録設定（フル編集）: `GET /api/v1/config/recording` → `{ config: <RecordingConfig dump>|null, path }`、`PUT /api/v1/config/recording`（body `{ config }`。下記「収録設定のフル編集」参照）
- 設定カタログ: `GET /api/v1/config/options`、`POST /api/v1/config/select`（検証テンプレート等のカテゴリ別選択肢と現在の選択）
- システム情報: `GET /api/v1/system` → `{ cpu: { model, cores }, gpu }`（ホストの読み取り専用イントロスペクション。`nvidia-smi` 不在時は `gpu: null`。常に `200`）
- ファイル配信: `GET /api/v1/files/{path}` — `data_dir` からの**相対パス**でファイルを配信（トラバーサルガード: `data_dir` 配下のみ。それ以外・不在は `404`）。`video_check` の mp4 プレビュー取得に使う
- データセット: `GET /api/v1/datasets`（`data/<operator>/<task>/<NNN>/dataset.json` を走査した一覧。`data_dir` 配下のみ読む）、`POST /api/v1/datasets/export`（body `{ run_id }`。下記「データセットエクスポート」参照）、`POST /api/v1/datasets/export-all`（`recorded/` 内の完了 run を**一括** export）
- `GET /healthz` / `GET /readyz`（`components: { recorder, monitor, streamer }` の疎通も返す）
- `GET /openapi.json`（OpenAPI。frontend は Orval でクライアントを自動生成）

## Run ライフサイクル（orchestrator が一元管理）

1. `POST /api/v1/record/start` → orchestrator が **`run_id` を採番**し SQLite に run を作成（`state=created`）。
2. recorder の `POST /record/start`（`run_id` を渡す）を呼ぶ。成功で `state=recording`、失敗なら **run 行は残したまま `state=failed` に更新**（理由を記録。DB 行は削除しない）。
3. start 成功直後に recorder の `GET /record/metadata` を取得し、**確定した topics / type / QoS（`"all"` 展開結果を含む）を run 行へ同期**する。取得失敗時は `recording` のまま `error` に理由を記録して再試行する。
4. `POST /api/v1/record/stop` → recorder stop → 最終 metadata（`message_count` / `bytes` / `ended_at` / topics）を再同期して `state=completed`。同期不能のまま完了した場合は `state=completed` とし `error` に同期失敗を残す（reconciliation 対象）。
5. **再起動時の reconciliation**: 起動時に `recording` / `stopping` の run を recorder の `GET /record/status` と突き合わせ、実体が無ければ `state=interrupted` に更新する。

- `run_id` は orchestrator が所有して recorder へ渡す。**SQLite が唯一の正**、recorder の `manifest.json` は監査用。
- run 行の `topics` / type / QoS は recorder の metadata 由来（orchestrator が上記タイミングで同期する）。
- run state の enum は共有 [config](config.md) に従う。
- **start 時の operator / task**: 空のときは `unknown_operator` / `unknown_task` を既定値とする（データセットの保存先 `data/<operator>/<task>` が常に keyable になるよう、null コンポーネントを排除）。
- **`record_status` SSE**: record start / stop の状態遷移ごとに `record_status` イベントを発行する（下記 SSE 契約）。
- **`GET /api/v1/runs/{id}` は RunDetail を返す**: run 行に加えて、ディスク上のサイドカーを best-effort で同梱する — `manifest`（recorder の `manifest.json`）/ `validation`（`fast_validation` レポート）/ `dataset_stats`（`dataset_export` レポート）/ `loss`（`loss_report` レポート）。各ファイルが無ければ `null`（孤児 run でもクリーンに返る）。

## 収録設定のフル編集（`GET/PUT /api/v1/config/recording`）

UI（Config タブ）から `RECORDING_CONFIG` 全体を編集・永続化する。

- `GET` — ライブの収録設定（`app.state` 上の現値。直前の PUT を再起動なしで反映）と、そのファイルパスを `{ config, path }` で返す（未ロード時は `config: null`）。
- `PUT` — body `{ config }`。`config` を `RecordingConfig`（[config](config.md)）で型検証し、失敗時は **`422`**（違反フィールドを `details.errors` に返す）。成功時は **`RECORDING_CONFIG` のファイルへ YAML をアトミックに書き込み**（temp + `os.replace`。書き込み先は常に設定ファイルで、リクエスト由来のパスは使わない）、**メモリ上の設定をホットスワップ**する。
- 反映タイミング: `GET /api/v1/config` と**次回記録の `default_topics`（robot_name 等を含む）は即時**反映。recorder の QoS / monitor の expected_hz・許可リストは各サービスの**次回再起動時**に適用される（UI もその旨を表示する）。

## ジョブ実行（`POST /api/v1/jobs`、`dora_runner` へプロキシ）

- `dataset_export`: 対象 run が未知なら **`404`**、まだ記録中 / 停止中（`created` / `recording` / `stopping`）なら **`409`**（書き込み途中の bag を export しない）。
- `fast_validation`: `params.template` の **id（カタログのファイル stem。例 `airoa_hsr`）を Config カタログでフル template に解決**してから `dora_runner` へ転送する（dora_runner の template ストアは空起動のため、bare id は 404 になる）。id が空 / 不在なら現在の選択（active）にフォールバック。既に dict（フル template）ならそのまま通す。

## データセットエクスポート（`POST /api/v1/datasets/export(-all)`）

収録を**正本ステージング（`recorded/`）からデータセットツリー（`data/<operator>/<task>/<NNN>`）へ移動**する操作。`POST /jobs` の直接呼び出しではなく、orchestrator が `dataset_export` ジョブの完了を待ち、**run のライフサイクルまで含めて**面倒を見る。

- `POST /api/v1/datasets/export`（body `{ run_id }`）: 対象が `completed` でなければ **`409`**、`recorded/<run_id>` が無ければ **`409`**（export 済み等）。`dataset_export`（移動）を完了まで実行し、**成功した場合のみ run 行を削除**（移動済みなので `recorded/` のディレクトリ・兄弟ファイル・レポートサイドカーも掃除）。失敗（`502`）・タイムアウト（`504`）時は run を `recorded/` と一覧に残す。
- `POST /api/v1/datasets/export-all`: `recorded/` にファイルが残る完了 run を**全件** export。1 件の失敗でバッチは止めず、`{ exported: [...], failed: [{ run_id, error }], total }` を返す。
- 結果として**エクスポート済みの収録は Recordings 一覧から消える**（来歴は `<NNN>/dataset.json` に保存）。`GET /api/v1/datasets` で operator › task › NNN を一覧できる。

## SSE イベント契約（`GET /api/v1/events`）

- 形式: `id:`（単調増加の整数）/ `event:`（種別）/ `data:`（JSON）。
- 種別と payload:
  - `record_status`: `{ run_id, state, message_count, bytes }`
  - `metrics`: `topic_monitor` の周期 snapshot（[topic_monitor](topic_monitor.md) の出力スキーマ）
  - `alert`: `{ topic, metric, level, value, threshold }`
  - `job`: `{ job_id, run_id, pipeline, state, progress }`
- 再接続: クライアントは `Last-Event-ID` を送る。サーバは直近イベントをリングバッファ（既定 1000 件 / 5 分）に保持し未送分を再送。範囲外なら `event: resync` を送り、クライアントは全体を再取得する。

## 主要スキーマ（抜粋、OpenAPI 生成対象 / pydantic）

- settings（`GET/POST /api/v1/settings`）: `{ defaults: { encoding: "vp8"|"h264", expected_hz: { <pattern>: number } }, alerts: [ { topic, metric, op, threshold, cooldown_s, clear_after_s } ], retention_days: int, max_record_bytes: int }`。POST は部分更新。settings は `RECORDING_CONFIG` を実行時に上書き / 補完し、**次の記録セッション / monitor の再購読から反映**（進行中の記録には遡及しない）。
- 検証テンプレート:
  - `GET /api/v1/validation/templates` → `{ items: [ { name, version, required_topics: [ { name, type?: string } ] } ], next_cursor }`
  - `POST /api/v1/validation/templates` body = `{ name, version, required_topics: [ { name, type? } ] }` → `201` 同形
  - `POST /api/v1/validation/templates/generate` body = `{ run_id }` → `{ name, version, required_topics: [ ... ] }`（雛形）
- run（`GET /api/v1/runs/{id}` = RunDetail）: `{ run_id, state, started_at, ended_at?: string|null, operator?, task?, topics: [ { name, type, qos } ], compression, split?: object|null, error?: { code, message }|null, manifest?: object|null, validation?: object|null, dataset_stats?: object|null, loss?: object|null }`（末尾 4 つはディスク上サイドカー由来。不在で `null`）。
- job（`GET /api/v1/jobs/{id}/status`）: `{ job_id, run_id, pipeline, state, progress, logs_tail }`（[dora_runner](dora_runner.md)）。

## フレームワーク / 永続

- **FastAPI + uvicorn**（推奨。OpenAPI を自動公開）。
- 重い処理（検証・変換、stage3）は**非同期ジョブキュー**に載せ、request/response から切り離す。進捗は SSE 通知。
- 永続: **runs / jobs / settings は SQLite を正**、ファイル manifest は監査用。片方だけ更新される事故を避ける。
- 内部サービス呼び出しは timeout（既定 `3s`）+ retry 1 回。失敗は `status` / `events` に反映（`503`）。

## エラー / 規約 / ネットワーク

- API 共通規約（ステータスコード `400`/`404`/`409`/`422`/`503`/`507`、エラー形式、ページング、enum、型・時刻）は [config](config.md) に従う。
- bind は `BIND_HOST`（既定 `0.0.0.0`、**LAN 公開を許容**。信頼された LAN 前提・認証なし）。CORS は `CORS_ORIGINS`（LAN 公開時は該当ホストの origin を追加）。

## 設計ポイント

- **backend-driven**: pipeline 定義・フォーム schema・タブ構成を orchestrator が提供する（frontend はハードコードしない）。
- 映像（WebRTC）は frontend が `webrtc_streamer` に直接接続。それ以外は orchestrator が集約する。
- 共有設定は [config](config.md)。
