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
- 設定: `GET /api/v1/config`（frontend 実行時設定: endpoints / tabs / defaults / schemas）、`GET/POST /api/v1/settings`
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
- run（`GET /api/v1/runs/{id}`）: `{ run_id, state, started_at, ended_at?: string|null, topics: [ { name, type, qos } ], compression, split?: object|null, error?: { code, message }|null }`。
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
