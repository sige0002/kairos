# api_orchestrator 仕様

> ステータス: 設計確定（v1）。`fig_const/apiオーケストラ.png` を基に、未記載事項を推奨設計として確定。日本語が正本（これを正とする）。英語版 `docs/specs/en/api_orchestrator.md` は自動生成ミラー（直接編集しない）。**認証は不要。**

**ジョブ管理 / 状態管理 / API ハブ**コンテナ。frontend が話す唯一の公開 API（**単一入口**。REST / SSE の制御・状態を集約する。例外として WebRTC の映像・signaling のみ frontend が `webrtc_streamer` へ直接接続）。`rosbag2_recorder` / `topic_monitor` / `webrtc_streamer` / `dora_runner` は内部サービスで、orchestrator が指示・集約する。

## 役割

- Run / ジョブのライフサイクル一元管理。
- backend-driven config（設定・スキーマをバックエンドが提供。`tabs` フィールドは v1 legacy — Console v2 のタブは frontend 固定で、表示には使われない）。
- 各サービスへの指示と結果集約・通知のハブ。

## 入力

- Frontend からの操作（記録 Start/Stop、Run 登録、Pipeline 実行）
- `topic_monitor` からの live metrics（SSE）
- `dora_runner` からのジョブ結果・ログ（stage3）

## 構成コンポーネント

- **Run Manager** / **Manifest Manager** / **Pipeline Registry** / **Result Aggregator** / **WebSocket・SSE Hub**（**Settings Manager** は将来枠・未実装。現状の設定編集は `PUT /api/v1/config/recording` が担う）
- feature ベースのルーター構成（`recording` / `topics` / `runs` / `events` / `pipelines` …）を推奨（疎結合）。

## 公開 API（`/api/v1`、無認証）

- 記録: `POST /api/v1/record/start`、`POST /api/v1/record/stop`、`GET /api/v1/record/status`（recorder へプロキシ）
- Run: `GET /api/v1/runs`（カーソルページング）、`GET /api/v1/runs/{id}`（Console v2 Phase 2 で **各 run に `episode` サマリを additive に同梱**。下記「Batch / Episode」）
- Batch / Episode（**Console v2 Phase 2**。Collect の進行と Review の判断を永続化）: `POST /api/v1/batches`、`PATCH /api/v1/batches/{id}`、`GET /api/v1/batches?status=`、`GET /api/v1/batches/{id}`、`POST /api/v1/episodes`、`PATCH /api/v1/episodes/{id}`（下記「Batch / Episode」）
- Topic: `GET /api/v1/topics`（一覧。**情報源は `topic_monitor` の `GET /topics` discovery をプロキシ**: `name` / `type` / `publisher_count` / `subscriber_count` / `qos` / `last_seen`）、`GET /api/v1/topics/status`（monitor 由来の live metrics）
- イベント: `GET /api/v1/events`（**SSE 集約**。契約は下記）
- Pipeline / Job（stage3。詳細は [dora_runner](dora_runner.md)）: `GET /api/v1/pipelines`、`POST /api/v1/jobs`、`GET /api/v1/jobs/{id}/status`、`GET /api/v1/jobs/{id}/result`、`POST /api/v1/jobs/{id}/cancel`
- 検証テンプレート: `GET/POST /api/v1/validation/templates`、`POST /api/v1/validation/templates/generate`（run から雛形生成）
- ワンクリック検証プリセット: `GET /api/v1/validation/presets`（config 定義のプリセット＋未検証 run 一覧）
- 設定: `GET /api/v1/config`（frontend 実行時設定: endpoints / tabs / defaults（`ros_domain_id` を含む）/ stream / schemas）。〔`GET/POST /api/v1/settings` は**未実装**（将来）。現状は下の `PUT /api/v1/config/recording` が設定編集の入口〕
- 収録設定（フル編集）: `GET /api/v1/config/recording` → `{ config: <RecordingConfig dump>|null, path }`、`PUT /api/v1/config/recording`（body `{ config }`。下記「収録設定のフル編集」参照）
- 設定カタログ: `GET /api/v1/config/options`、`POST /api/v1/config/select`（検証テンプレート等のカテゴリ別選択肢と現在の選択）
- システム情報: `GET /api/v1/system` → `{ cpu: { model, cores }, gpu, cpu_percent, disk, gpu_percent }`（ホストの読み取り専用イントロスペクション。常に `200`）
  - `cpu` / `gpu`: 静的な情報（CPU モデル名・論理コア数は `/proc/cpuinfo`、GPU 名は `nvidia-smi`。取得不能時は各フィールド `null`）
  - `cpu_percent`: ホスト全体の CPU 使用率 `[0, 100]`（`/proc/stat` の集約 `cpu` 行を 2 スナップショット差分して算出＝真の busy%。ロードアベレージではない）。差分の基準がまだ無い初回サンプルや `/proc/stat` 不読時は `null`
  - `disk`: 収録データ用ディレクトリを含むファイルシステムの `{ path, total_bytes, free_bytes }`（`shutil.disk_usage`。app が知る `data_dir` を優先し、無ければ `/data` にフォールバック。いずれも存在しなければ `null`）
  - `gpu_percent`: GPU 使用率 `[0, 100]`（`nvidia-smi --query-gpu=utilization.gpu`）。GPU 非搭載・`nvidia-smi` 取得不能時は `null`（値をでっち上げない）
  - `cpu_percent` / `disk` / `gpu_percent` は時間変化するため約 2 秒キャッシュ（SSE 相当のポーリングでも安価）。`nvidia-smi` プローブはワーカースレッドで実行しイベントループをブロックしない
- ファイル配信: `GET /api/v1/files/{path}` — `data_dir` からの**相対パス**でファイルを配信（トラバーサルガード: `data_dir` 配下のみ。それ以外・不在は `404`）。`video_check` の mp4 プレビュー取得に使う
- データセット: `GET /api/v1/datasets`（`data/<operator>/<task>/<NNN>/dataset.json` を走査した一覧。`data_dir` 配下のみ読む）、`GET /api/v1/datasets/{operator}/{task}/{index}`（**エクスポート済みデータセットの詳細**。下記「データセットエクスポート」参照）、`DELETE /api/v1/datasets/{operator}/{task}/{index}`（**エクスポート済みデータセットの削除**。同節参照）、`POST /api/v1/datasets/export`（body `{ run_id }`）、`POST /api/v1/datasets/export-all`（`recorded/` 内の完了 run を**一括** export）
- `GET /healthz` / `GET /readyz`（`components: { recorder, monitor, streamer }` の疎通も返す）
- `GET /openapi.json`（OpenAPI を自動公開。クライアント自動生成に使える — 現状の frontend は手書きの型付きクライアント）

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

## Batch / Episode（Console v2 Phase 2）

Collect の Batch/Episode 進行・タスク結果・品質判断を orchestrator に**永続化**し、Review が端末に依存せず実データを表示できるようにする（従来のブラウザ内ブリッジ `episodeBridge` を置換）。**既存の runs / jobs には手を入れない**。episode は run への参照を持つ別テーブルで、録画経路（record/start → stop → MCAP）は無変更 = 録画の安全性に影響しない。

- **データモデル**（orchestrator の既存 SQLite に 2 テーブル追加）:
  - `batches`: `batch_id`（`batch_YYYYMMDD_HHMMSS`）/ `robot` / `project` / `task` / `condition` / `operator` / `target_episodes`（既定 30）/ `status`（`active` | `completed` | `ended_early`）/ `ended_reason?` / `created_at` / `ended_at?` / `episodes_recorded`（**録画した episode の単調カウンタ。既定 0**）/ `batch_seq`（**（ロボット, ローカル日付）ごとの人間可読なバッチ番号。nullable**）。`project` は Plan 由来の文字列（**Plan 自体のモデル化は Phase 2.5 に先送り**）。
    - `episodes_recorded` は `POST /api/v1/episodes` ごとに +1 し、**run 削除の CASCADE でも減らさない**（`episode_count` はライブの件数で削除時に減るが、Collect の「N / 30」等の表示は撮った数を正とするためこの単調値を使う）。既存 DB へは additive migration で追加し、現在の episode 件数で backfill。
    - `batch_seq` は **バッチ作成時（＝初回録画時の遅延生成）に発番**する: `1 + MAX(batch_seq)`（同ロボット・同ローカル日付の既存バッチ。UTC の `created_at` を `date(created_at,'localtime')` でローカル日付に変換して突き合わせ）。**毎朝ローカル日付で 1 から／ロボットごとに独立**にリセットされ、Collect/Review/Datasets の唯一の人間可読番号になる（Collect=「Batch N」、Review/Datasets=「MM/DD · #N」。日付は `created_at` から導出＝新列不要）。空バッチは行を持たない=番号を消費しない。採番は store のロック下で read→insert が同一トランザクションのためレース安全。既存 DB へは additive migration で追加し、（ロボット, ローカル日付）グループごとに `created_at` 昇順で backfill。
  - `episodes`: `episode_id`（`ep_<uuid>`）/ `batch_id` / `run_id`（**UNIQUE** = 1 episode = 1 run）/ `index_in_batch` / `task_result`（`success` | `failure`）/ `failure_reason?` / `quality`（`good` | `needs_review` | `not_usable`）/ `quality_source`（`operator` | `quick_check` | `validator`。既定 `operator`）/ `review_status`（`pending` | `adopted` | `excluded`。既定 `pending`）/ `created_at` / `updated_at`。
  - FK はコード側で担保（SQLite の FK pragma に依存しない）。`DELETE /api/v1/runs/{id}` 時は該当 episode を**コードでカスケード削除**する。
- **エンドポイント**:
  - `POST /api/v1/batches` — バッチ開始。body `{ project, task, condition?, operator?, robot?, target_episodes=30 }` → `201`（`robot` 省略時は **active robot** で補完）。`batch_id` は同秒衝突時にサフィックス再採番。
  - `PATCH /api/v1/batches/{id}` — 途中終了（`status` / `ended_reason`）・`condition` 変更。**終端 status（`completed` / `ended_early`）到達時に `ended_at` を一度だけスタンプ**。不整合な遷移は緩く許容（ハード拒否しない）。不在は `404`。
  - `GET /api/v1/batches?status=` — バッチ一覧（**新しい順**）。各要素に `batch_seq`・`episode_count`（ライブ件数）・`episodes_recorded`（単調カウンタ）と**コンパクトな episodes サマリ**（`index` / `run_id` / `batch_seq` / `task_result` / `quality` / `review_status`）を同梱（リロード時のアクティブバッチ復元に使う。Collect の件数表示は `episodes_recorded` を参照）。
  - `GET /api/v1/batches/{id}` — バッチ全体 ＋ **episodes（フル）**。不在は `404`。
  - `POST /api/v1/episodes` — Collect Save 時。body `{ batch_id, run_id, index_in_batch, task_result, failure_reason?, quality, quality_source='operator' }` → `201`。batch / run が未知なら `404`、run に既に episode があれば **`409`**（`episode_exists`）。
  - `PATCH /api/v1/episodes/{id}` — Review の Adopt/Exclude（`review_status`）・品質/結果の上書き。不在は `404`。書き込みごとに `updated_at` を更新。
- **runs への JOIN**: `GET /api/v1/runs` / `GET /api/v1/runs/{id}` は各 run に `episode` サマリ（`episode_id` / `batch_id` / `batch_seq` / `index_in_batch` / `task_result` / `failure_reason` / `quality` / `review_status`）を **additive に同梱**（無ければ `null`）。`batch_seq` は episode 行でなくバッチ側にあるため、join 時に `batch_id → batch_seq` を一括引きして付与する（Review/Datasets が 2 度目の往復なしで番号を表示できる）。既存フィールドは不変。一覧はバッチ一括取得で N+1 を回避。
- **SSE**: 既存 `record_status` / `resync` で足りるため**新イベントは追加しない**（必要になれば Phase 2b）。
- **Phase 2.5 TBD**: UX 仕様の Session > Batch > Episode のうち **Session は今回作らない**（運用実績を見て判断）。Plan（Projects/Tasks/Conditions）の DB 化・Settings からの編集保存も Phase 2.5。

## 収録設定のフル編集（`GET/PUT /api/v1/config/recording`）

UI（Settings タブ）から `RECORDING_CONFIG` 全体を編集・永続化する。

- `GET` — ライブの収録設定（`app.state` 上の現値。直前の PUT を再起動なしで反映）と、そのファイルパスを `{ config, path }` で返す（未ロード時は `config: null`）。
- `PUT` — body `{ config }`。`config` を `RecordingConfig`（[config](config.md)）で型検証し、失敗時は **`422`**（違反フィールドを `details.errors` に返す）。成功時は **`RECORDING_CONFIG` のファイルへ YAML をアトミックに書き込み**（temp + `os.replace`。書き込み先は常に設定ファイルで、リクエスト由来のパスは使わない）、**メモリ上の設定をホットスワップ**する。
- 反映タイミング: `GET /api/v1/config` と**次回記録の `default_topics`（robot_name 等を含む）は即時**反映。recorder の QoS / monitor の expected_hz・許可リストは各サービスの**次回再起動時**に適用される（UI もその旨を表示する）。

## ジョブ実行（`POST /api/v1/jobs`、`dora_runner` へプロキシ）

- `dataset_export`: 対象 run が未知なら **`404`**、まだ記録中 / 停止中（`created` / `recording` / `stopping`）なら **`409`**（書き込み途中の bag を export しない）。
- `fast_validation`: `params.template` の **id（カタログのファイル stem。例 `airoa_hsr`）を Config カタログでフル template に解決**してから `dora_runner` へ転送する（dora_runner の template ストアは空起動のため、bare id は 404 になる）。id が空 / 不在なら現在の選択（active）にフォールバック。既に dict（フル template）ならそのまま通す。

## データセットエクスポート（`POST /api/v1/datasets/export(-all)`）

収録を**正本ステージング（`recorded/`）からデータセットツリー（`data/<operator>/<task>/<NNN>`）へ移動**する操作。`POST /jobs` の直接呼び出しではなく、orchestrator が `dataset_export` ジョブの完了を待ち、**run のライフサイクルまで含めて**面倒を見る。

- `POST /api/v1/datasets/export`（body `{ run_id }`）: 対象が `completed` でなければ **`409`**、`recorded/<run_id>` が無ければ **`409`**（export 済み等）。`dataset_export`（移動）を完了まで実行し、**成功した場合のみ run 行を削除**（移動済みなので `recorded/` のディレクトリ・兄弟ファイルも掃除）。**run キーのレポートサイドカー（`data/report/*/<run_id>`: validation / loss / video_check の mp4 キャッシュ）は意図的に残す** — エクスポート後もデータセット詳細ビューがそれらを表示し続けられるようにするため（`DELETE /api/v1/runs/{id}` による明示削除では従来どおり掃除される）。失敗（`502`）・タイムアウト（`504`）時は run を `recorded/` と一覧に残す。
- `POST /api/v1/datasets/export-all`: `recorded/` にファイルが残る完了 run を**全件** export。1 件の失敗でバッチは止めず、`{ exported: [...], failed: [{ run_id, error }], total }` を返す。
- **ラベルはエクスポートを生き残る（`episode.json`）** — Console v2 Phase 2: run 行の削除は episode を CASCADE で消すため、export 時に **run 行を削除する前**に該当 episode（あれば）とそのバッチを読み、`dataset.json` の隣に `episode.json`（tmp+rename でアトミック書込）を書き出す。内容 = `episode_id` / `batch_id` / `batch_seq` / `index_in_batch` / `task_result` / `failure_reason?` / `quality` / `quality_source` / `review_status`＋バッチコンテキスト `batch: { batch_id, batch_seq, project, task, condition, operator, robot }`＋`exported_at`。**これがないと、失敗ラベル付きデータが未ラベルとして export されてしまう**。episode を持たない run は `episode.json` を書かない（空ファイルも作らない）。single / export-all の両経路が同じ処理を通る。
- 結果として**エクスポート済みの収録は収録一覧（Review タブ）から消える**（来歴は `<NNN>/dataset.json` に保存）。`GET /api/v1/datasets` で operator › task › NNN を一覧できる。一覧の各行には `episode.json` の**軽量サブセット**（`task_result` / `quality` / `review_status` / `batch_seq` / `index_in_batch`。無ければ `null`）をカード表示用に同梱する（`dataset.json` と同じく行ごとに読む）。
- **`GET /api/v1/datasets/{operator}/{task}/{index}` はエクスポート後の RunDetail 相当**（DatasetDetail）を返す: `dataset.json`（来歴・`files` / `bytes` / `message_count`）に加え、移動された `session.json`（state / started_at / ended_at）・`manifest.json`（topics の name / type / QoS。無ければ session / dataset.json の名前のみへフォールバック）・**`episode.json`（`episode` フィールドとして同梱。無ければ `null`）**と、エクスポートを生き残った run キーのレポート（`validation` / `loss`）を best-effort で同梱する。応答の `path`（`<operator>/<task>/<index>` 相対パス）は、エクスポート後に `video_check` / `loss_report` ジョブを実行する際の `params.dataset_dir` にそのまま使える。パスコンポーネントは単一ディレクトリ名のみ許可（トラバーサル・予約名 `recorded`/`report`/`datasets` は `400`）、ディレクトリまたは `dataset.json` 不在は `404`。
- **`DELETE /api/v1/datasets/{operator}/{task}/{index}` はエクスポート後の `DELETE /runs/{id}` 相当**（`204`）: データセットディレクトリ（`episode.json` などのサイドカーごと）を削除し、空になった `<task>` / `<operator>` 親ディレクトリを掃除、さらにエクスポート時に意図的に残した run キーのレポートサイドカー（`data/report/*/<run_id>`）も**孤児になるためここで削除**する（同じ run_id の run 行がまだ存在する場合は残す）。パス規則は詳細と同じ（不正コンポーネント・予約名は `400`、ディレクトリまたは `dataset.json` 不在は `404` — `dataset.json` の無いディレクトリは削除対象にならない）。削除に失敗した場合は `500`（`dataset_delete_failed`）。

## SSE イベント契約（`GET /api/v1/events`）

- 形式: `id:`（単調増加の整数）/ `event:`（種別）/ `data:`（JSON）。
- 種別と payload:
  - `record_status`: `{ run_id, state, message_count, bytes }`
  - `metrics`: `topic_monitor` の周期 snapshot（[topic_monitor](topic_monitor.md) の出力スキーマ）
  - `alert`: `{ topic, metric, level, value, threshold }`
  - `job`: `{ job_id, run_id, pipeline, state, progress }`
- 再接続: クライアントは `Last-Event-ID` を送る。サーバは直近イベントをリングバッファ（既定 1000 件 / 5 分）に保持し未送分を再送。範囲外なら `event: resync` を送り、クライアントは全体を再取得する。

## 主要スキーマ（抜粋、OpenAPI 生成対象 / pydantic）

- settings（`GET/POST /api/v1/settings`。**未実装・将来枠**）: `{ defaults: { encoding: "vp8"|"h264", expected_hz: { <pattern>: number } }, alerts: [ { topic, metric, op, threshold, cooldown_s, clear_after_s } ], retention_days: int, max_record_bytes: int }`。当初設計では `RECORDING_CONFIG` を実行時に上書き / 補完し次の記録セッションから反映する想定だったが、現状は `PUT /api/v1/config/recording`（下記・アトミック書込＋ホットスワップ）で代替している。
- 検証テンプレート:
  - `GET /api/v1/validation/templates` → `{ items: [ { name, version, required_topics: [ { name, type?: string } ] } ], next_cursor }`
  - `POST /api/v1/validation/templates` body = `{ name, version, required_topics: [ { name, type? } ] }` → `201` 同形
  - `POST /api/v1/validation/templates/generate` body = `{ run_id }` → `{ name, version, required_topics: [ ... ] }`（雛形）
- ワンクリック検証プリセット:
  - `GET /api/v1/validation/presets` → `{ items: [ { id, name, description, pipeline, params, total, pending, pending_run_ids: [ run_id ] } ] }`。静的フィールド（`id` / `name` / `description` / `pipeline` / `params`）は機体の `validation_presets.yaml`（[config](config.md)）由来。動的フィールドはリクエスト毎に算出＝完了収録（`recorded/` に残る run）のうち **その pipeline の `report/<pipeline>/<run_id>/summary.json` がまだ無い**もの（`pending_run_ids`）。UI はこれを 1 クリックで一括実行する（`POST /api/v1/jobs` を run ごと）。読み取り専用（状態は変えない）。
- run（`GET /api/v1/runs/{id}` = RunDetail）: `{ run_id, state, started_at, ended_at?: string|null, operator?, task?, topics: [ { name, type, qos } ], compression, split?: object|null, error?: { code, message }|null, episode?: object|null, manifest?: object|null, validation?: object|null, dataset_stats?: object|null, loss?: object|null }`（`episode` は Phase 2 の JOIN。末尾 4 つはディスク上サイドカー由来。いずれも不在で `null`）。
- batch（`GET /api/v1/batches` の要素 = BatchSummary）: `{ batch_id, robot?, project, task, condition?, operator?, target_episodes, status, ended_reason?, created_at, ended_at?, episodes_recorded, batch_seq?, episode_count, episodes: [ { index, run_id, batch_seq?, task_result, quality, review_status } ] }`。`GET /api/v1/batches/{id}`（BatchDetail）は `episodes` がフル episode 配列。
- episode（`POST/PATCH /api/v1/episodes`）: `{ episode_id, batch_id, run_id, index_in_batch, task_result, failure_reason?, quality, quality_source, review_status, created_at, updated_at }`。
- job（`GET /api/v1/jobs/{id}/status`）: `{ job_id, run_id, pipeline, state, progress, logs_tail }`（[dora_runner](dora_runner.md)）。

## フレームワーク / 永続

- **FastAPI + uvicorn**（推奨。OpenAPI を自動公開）。
- 重い処理（検証・変換、stage3）は**非同期ジョブキュー**に載せ、request/response から切り離す。進捗は SSE 通知。
- 永続: **runs / jobs は SQLite を正**、ファイル manifest は監査用。片方だけ更新される事故を避ける（settings ストアは未実装。収録設定は `PUT /api/v1/config/recording` で設定ファイルへアトミックに永続化する）。
- 内部サービス呼び出しは timeout（既定 `3s`）+ retry 1 回。失敗は `status` / `events` に反映（`503`）。

## エラー / 規約 / ネットワーク

- API 共通規約（ステータスコード `400`/`404`/`409`/`422`/`503`/`507`、エラー形式、ページング、enum、型・時刻）は [config](config.md) に従う。
- bind は `BIND_HOST`（既定 `0.0.0.0`、**LAN 公開を許容**。信頼された LAN 前提・認証なし）。CORS は `CORS_ORIGINS`（LAN 公開時は該当ホストの origin を追加）。

## 設計ポイント

- **backend-driven**: pipeline 定義・フォーム schema・実行時設定を orchestrator が提供する（frontend はハードコードしない。タブ構成のみ Console v2 で frontend 固定に変更）。
- 映像（WebRTC）は frontend が `webrtc_streamer` に直接接続。それ以外は orchestrator が集約する。
- 共有設定は [config](config.md)。
