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

- 記録: `POST /api/v1/record/prepare`（two-phase start — recorder を先に arm。**DB 行は作らない**: prepare 状態はメモリ上の 1 エントリのみで、応答の `run_id` は recorder が返したもの〔一致 re-prepare の keep-alive では既存 armed セッションの id〕を採用する。後続の一致する `start` がその id で行を作って引き継ぎ、不一致・未消費なら recorder 側の auto-disarm に任せる）、`POST /api/v1/record/start`、`POST /api/v1/record/stop`（armed のみで run が無ければ disarm も兼ねる）、`GET /api/v1/record/status`（recorder へプロキシ。**遅延 reconciliation を兼務**: DB 上 live な run を recorder が終了済みと報告していれば（例: `MAX_RECORD_BYTES`/`MAX_RECORD_SECONDS` の recorder 内自動停止）通常の stop 経路で completed に確定し、recorder が知らない live run は即 interrupted 化する — 再起動を待たない）
- Run: `GET /api/v1/runs`（カーソルページング）、`GET /api/v1/runs/{id}`（Console v2 Phase 2 で **各 run に `episode` サマリを additive に同梱**。下記「Batch / Episode」）
- Batch / Episode（**Console v2 Phase 2**。Collect の進行と Review の判断を永続化）: `POST /api/v1/batches`、`PATCH /api/v1/batches/{id}`、`GET /api/v1/batches?status=&robot=&operator=`、`GET /api/v1/batches/{id}`、`POST /api/v1/episodes`、`PATCH /api/v1/episodes/{id}`（下記「Batch / Episode」）
- プラン語彙カタログ: `GET /api/v1/plans` / `PUT /api/v1/plans` — Collect がバッチ/エピソードに刻む **project / task / condition の共有語彙**（Projects → Tasks → Conditions の1 JSON。`plan_catalog` 1行テーブルに保存し `updated_at` をサーバ側で刻印）。端末ごとのブラウザローカルコピーだと同じ物理条件が別文字列でラベルされ集計が割れるため、全端末を単一語彙に載せる（2026-07-14 バッチラベル裁定）。**Phase 2.5 の Plan モデルではない**（id/参照/目標本数は持たない。バッチは従来どおり文字列を保存）。未設定は `{ projects: null, updated_at: null }`（クライアントが手元のカタログで**シード**する）、明示的に空にした場合は `projects: []`+タイムスタンプ（シードで復活させない）。PUT は形を検証（`{ projects: [{ name, tasks: [{ name, conditions: [str] }] }] }`）し全置換・last-writer-wins
- Topic: `GET /api/v1/topics`（一覧。**情報源は `topic_monitor` の `GET /topics` discovery をプロキシ**: `name` / `type` / `publisher_count` / `subscriber_count` / `qos` / `last_seen`）、`GET /api/v1/topics/status`（monitor 由来の live metrics）
- イベント: `GET /api/v1/events`（**SSE 集約**。契約は下記）
- Pipeline / Job（stage3。詳細は [dora_runner](dora_runner.md)）: `GET /api/v1/pipelines`、`POST /api/v1/jobs`、`GET /api/v1/jobs/{id}/status`、`GET /api/v1/jobs/{id}/result`、`POST /api/v1/jobs/{id}/cancel`
- 検証テンプレート: `GET/POST /api/v1/validation/templates`、`POST /api/v1/validation/templates/generate`（run から雛形生成）
- ワンクリック検証プリセット: `GET /api/v1/validation/presets`（config 定義のプリセット＋未検証 run 一覧）
- 設定: `GET /api/v1/config`（frontend 実行時設定: endpoints / tabs / defaults（`ros_domain_id` を含む）/ stream / schemas）。〔`GET/POST /api/v1/settings` は**未実装**（将来）。現状は下の `PUT /api/v1/config/recording` が設定編集の入口〕
- 収録設定（フル編集）: `GET /api/v1/config/recording` → `{ config: <RecordingConfig dump>|null, path }`、`PUT /api/v1/config/recording`（body `{ config }`。下記「収録設定のフル編集」参照）
- Signals 既定表示 / アラート規則（単一ファイル・アスペクト編集）: `GET/PUT /api/v1/config/signals`（Review の既定表示。`config/<robot>/signals/default.yaml`。表示専用＝即時反映）／`GET/PUT /api/v1/config/alerts`（topic_monitor のアラート規則。`config/<robot>/monitoring/alerts.yaml`。monitor 再起動時に反映）。`GET` は `{ config, raw, path }`（alerts は `warnings` も）、`PUT` は body `{ config }`（フォーム）または `{ raw }`（生 YAML）。下記「Signals / アラート規則の編集」参照
- 設定カタログ: `GET /api/v1/config/options`、`POST /api/v1/config/select`（検証テンプレート等のカテゴリ別選択肢と現在の選択）、`GET /api/v1/config/robots/{robot}`（**任意のカタログ機体の設定を read-only で返す** — aspect 毎のパース済み内容+要約。ライブ系を切り替えずに他機体を雛形参照するため（Settings）。未知の機体・不正なパス成分は `404`）
- システム情報: `GET /api/v1/system` → `{ cpu: { model, cores }, gpu, cpu_percent, disk, gpu_percent }`（ホストの読み取り専用イントロスペクション。常に `200`）
  - `cpu` / `gpu`: 静的な情報（CPU モデル名・論理コア数は `/proc/cpuinfo`、GPU 名は `nvidia-smi`。取得不能時は各フィールド `null`）
  - `cpu_percent`: ホスト全体の CPU 使用率 `[0, 100]`（`/proc/stat` の集約 `cpu` 行を 2 スナップショット差分して算出＝真の busy%。ロードアベレージではない）。差分の基準がまだ無い初回サンプルや `/proc/stat` 不読時は `null`
  - `disk`: 収録データ用ディレクトリを含むファイルシステムの `{ path, total_bytes, free_bytes }`（`shutil.disk_usage`。app が知る `data_dir` を優先し、無ければ `/data` にフォールバック。いずれも存在しなければ `null`）
  - `gpu_percent`: GPU 使用率 `[0, 100]`（`nvidia-smi --query-gpu=utilization.gpu`）。GPU 非搭載・`nvidia-smi` 取得不能時は `null`（値をでっち上げない）
  - `cpu_percent` / `disk` / `gpu_percent` は時間変化するため約 2 秒キャッシュ（SSE 相当のポーリングでも安価）。`nvidia-smi` プローブはワーカースレッドで実行しイベントループをブロックしない
- ファイル配信: `GET /api/v1/files/{path}` — `data_dir` からの**相対パス**でファイルを配信（トラバーサルガード: `data_dir` 配下のみ。それ以外・不在は `404`）。`video_check` の mp4 プレビュー取得に使う
- データセット: `GET /api/v1/datasets`（一覧。`data/index.jsonl` カタログがあればそこから返し、不在・破損時は `data/<operator>/<task>/<NNN>/dataset.json` のツリー走査へ**自動フォールバック**。応答形は同一。`data_dir` 配下のみ読む）、`GET /api/v1/datasets/{operator}/{task}/{index}`（**エクスポート済みデータセットの詳細**。下記「データセットエクスポート」参照）、`DELETE /api/v1/datasets/{operator}/{task}/{index}`（**エクスポート済みデータセットの削除**。同節参照）、`POST /api/v1/datasets/export`（body `{ run_id }`）、`POST /api/v1/datasets/export-all`（`recorded/` 内の完了 run を**一括** export）、`POST /api/v1/datasets/index/rebuild`（`data/index.jsonl` をサイドカーから丸ごと再生成。`{ count }` を返す。カタログは派生・再構築可能で、正本はツリー上のサイドカー — 詳細は [config.md](config.md) の「運用」）
- 保持期間: `GET /api/v1/retention` — `RETENTION_DAYS` による**削除候補**（未エクスポート＝run 行が残る・終端状態・開始が N 日超）を返す（`{ days, candidates: [{ run_id, started_at, bytes, state, has_episode }], total_bytes }`。都度計算、best-effort サイズ）。**助言のみで自動削除しない**。削除は既存の確認付き `DELETE /api/v1/runs/{id}` のみ。`RETENTION_DAYS<=0` で候補は空（詳細は [config.md](config.md) の「運用」）
- `GET /healthz` / `GET /readyz`（`components: { recorder, monitor, streamer }` の疎通も返す）
- `GET /openapi.json`（OpenAPI を自動公開。クライアント自動生成に使える — 現状の frontend は手書きの型付きクライアント）

## Run ライフサイクル（orchestrator が一元管理）

1. `POST /api/v1/record/start` → orchestrator が **`run_id` を採番**し SQLite に run を作成（`state=created`）。
2. recorder の `POST /record/start`（`run_id` を渡す）を呼ぶ。成功で `state=recording`、失敗なら **run 行は残したまま `state=failed` に更新**（理由を記録。DB 行は削除しない）。
3. start 成功直後に recorder の `GET /record/metadata` を取得し、**確定した topics / type / QoS（`"all"` 展開結果を含む）を run 行へ同期**する。取得失敗時は `recording` のまま `error` に理由を記録して再試行する。
4. `POST /api/v1/record/stop` → recorder stop → 最終 metadata（`message_count` / `bytes` / `ended_at` / topics）を再同期して `state=completed`。同期不能のまま完了した場合は `state=completed` とし `error` に同期失敗を残す（reconciliation 対象）。確定後、**停止時クイックチェックを stop 応答の外で走らせ**、完了時に `quick_check` を run 行へ書き込む（下記「停止時クイックチェック」）。
5. **再起動時の reconciliation**: 起動時に `recording` / `stopping` の run を recorder の `GET /record/status` と突き合わせ、実体が無ければ `state=interrupted` に更新する。

- `run_id` は orchestrator が所有して recorder へ渡す。**SQLite が唯一の正**、recorder の `manifest.json` は監査用。
- run 行の `topics` / type / QoS は recorder の metadata 由来（orchestrator が上記タイミングで同期する）。
- run state の enum は共有 [config](config.md) に従う。
- **start 時の operator / task**: 空のときは `unknown_operator` / `unknown_task` を既定値とする（データセットの保存先 `data/<operator>/<task>` が常に keyable になるよう、null コンポーネントを排除）。
- **`record_status` SSE**: record start / stop の状態遷移ごとに `record_status` イベントを発行する（下記 SSE 契約）。
- **`GET /api/v1/runs/{id}` は RunDetail を返す**: run 行に加えて、ディスク上のサイドカーを best-effort で同梱する — `manifest`（recorder の `manifest.json`）/ `validation`（`fast_validation` レポート）/ `dataset_stats`（`dataset_export` レポート）/ `loss`（`loss_report` レポート）。各ファイルが無ければ `null`（孤児 run でもクリーンに返る）。

## 停止時クイックチェック（`quick_check` settlement）

録画停止時に orchestrator が **2 層のクイックチェックを一度だけ確定（settle）**し、run 行に `quick_check`（JSON）として永続化する。分担: topic_monitor = 常時のライブ検知、**orchestrator = 停止時の一度きりの確定**、dora_runner = 事後のディープ解析（quick_check には手を出さない）。**stop の HTTP 応答は現状以上に遅延させない**: run を終端状態（`completed` 等）に確定し `record_status` を発行したあと、確定処理を **stop 経路の外（バックグラウンドタスク）**で走らせ、完了時に run 行を `quick_check` で更新する。総予算は約 `4s`（各下流呼び出しに個別タイムアウト・no-retry）。タイムアウト時は**完了した分だけ**を `available` フラグを正直に落として永続化する（正直な degradation）。

- **Layer 0（MCAP を読まない、~ms）** — 停止時に一度だけ引く:
  - monitor `GET /metrics` スナップショット（per-topic `hz` / `expected_hz` / `rate_shortfall` / `gap_max_ms` / `dds_samples_lost`）。`expected_hz` は `RECORDING_CONFIG` の `expected_hz_patterns` を fnmatch 先勝ちで解決（monitor と同じ規則）。`dds_samples_lost` は **録画 START 時に取ったベースライン（monitor スナップショットを in-memory に保持、run_id キー）との差分**で全区間値にする（ベースライン取得は best-effort・短タイムアウト = start を遅延させない）。
  - monitor `GET /incidents?since_ns=0`（**リング全体 ≤500 を取得**）を引き、**録画ウィンドウ `[start, stop]` に重なるものだけをクライアント側でフィルタ**する（`fired_at_ns <= stop` かつ `cleared_at_ns` が `start` 以降 or `null`）。`since_ns=<録画開始>` を渡さないこと: monitor の `since_ns` フィルタは片側（`fired_at_ns >= since_ns OR cleared_at_ns >= since_ns`）で、**録画開始前に発火して継続中（`cleared_at_ns=null`）の incident を取りこぼす**ため。契約: `{ incidents: [ { id, topic, metric, severity: "danger"|"warning", rule_origin: "config"|"derived"|"default", fired_at_ns, cleared_at_ns: int|null, message } ] }`。タイムスタンプは epoch ns（`time.time_ns`）。
  - recorder の `integrity`（`ok`|`dropped`|`failed`|`unknown`。recorder の manifest 由来 = monitor とは独立に埋まるので、monitor 不達でも残る）。
  - backstop: `MAX_RECORD_SECONDS`/`BYTES` による自動停止ノート（recorder が manifest に `auto-stopped:` 接頭辞で残す。あれば同梱。informational で verdict には効かない）。
  - monitor が不達 / エンドポイント `404` のときは Layer 0 の monitor 由来部を `available: false` と正直に落とす（settlement は失敗させない。`integrity` は独立に残る）。
- **Layer 1（MCAP の summary のみ読む、<1s）** — 録画 bag の **summary/statistics セクションのみ**（per-channel メッセージ数・start/end）を読む。**メッセージ全走査はしない**。per-topic `avg_hz = count / duration` を算出して `expected_hz` と比較。欠落トピック（config の `default_topics` / 録画対象にあるが bag に無い）・空トピック（channel はあるが count 0）・duration を検出。**summary が無い（unclean stop）場合はフルスキャンにフォールバックせず** `summary_available: false` とし、強い needs_review シグナルとして扱う。bag 自体が無ければ `available: false`。
- **verdict**: 次のいずれかで `needs_review`、他は `good`。`reasons` に発火した**具体的な**理由を列挙（例: `/hsrb/hand_camera avg 8.9Hz < expected 30Hz`）。`good` は空配列。
  - `integrity != "ok"`（`unknown` / 取得不能も含む）
  - ウィンドウ内に **danger** 重大度の incident が発火（`warning` は記録するが単独では効かない）
  - いずれかのトピックの `avg_hz < 0.8 × expected_hz`
  - 必須トピックの欠落 / 空
  - summary が取得不能

**永続契約（FIXED — frontend が実装対象）**: `quick_check` を run 行に保存し（基底 `Run` フィールド = 一覧 / 詳細どちらにも載る）、run 詳細を返す全経路で公開する。settlement 完了までは `null`（機能導入前の古い run も `null`）。形:

```json
{
  "computed_at": "<iso8601>", "elapsed_ms": 123,
  "layer0": { "available": true, "integrity": "ok|dropped|failed|unknown|null",
    "topics": { "/x": { "hz": 29.7, "expected_hz": 30, "rate_shortfall": 0.01, "gap_max_ms": 40, "dds_samples_lost": 0 } },
    "incidents": [ /* /incidents のうちウィンドウに重なるもの */ ], "backstop": "auto-stopped: …|null" },
  "layer1": { "available": true, "summary_available": true,
    "topics": { "/x": { "message_count": 1780, "avg_hz": 29.6, "expected_hz": 30 } },
    "missing_topics": [], "empty_topics": [], "duration_s": 60.1 },
  "verdict": { "quality": "good|needs_review", "reasons": ["…"] }
}
```

- **episode の既定品質は `quick_check.verdict.quality` から導出**する（既存の D-2「integrity→品質」シームを**拡張**）。`POST /api/v1/episodes` で `quality` を**省略**すると、run の `quick_check.verdict.quality`（`good` | `needs_review`）を既定値とし `quality_source="quick_check"` を付ける。明示的な `quality` はオペレータの上書きとしてそのまま保存（`quality_source` は既定 `operator`）。run に `quick_check` が無ければ保守的に `needs_review`（未確定は good と見なさない）。
- **確定後の遅延再導出（save-before-settle レース対策）**: settlement 完了で run に `quick_check` を書き込んだ**直後**、その run に既に episode があり `quality_source == "quick_check"` のとき、その episode の `quality` を確定 verdict の値へ更新する（`updated_at` も更新）。これは settle 完了前に保存された episode が保守的な `needs_review` フォールバックのまま取り残されるのを補正するもの。`operator` / `validator` 由来の品質には**決して手を出さない**（人／ディープ解析の判断）。episode が無ければ no-op、既に一致していれば書き込まない。再導出の失敗は独立に握り潰し、確定済みの `quick_check` を settlement 失敗として誤報しない。episode 更新用の既存イベント／SSE 経路は無いため、新規のイベント配線は足さない（フロントは result パネルの `GET /runs/{id}` ポーリングで確定結果を取得する）。

## Batch / Episode（Console v2 Phase 2）

Collect の Batch/Episode 進行・タスク結果・品質判断を orchestrator に**永続化**し、Review が端末に依存せず実データを表示できるようにする（従来のブラウザ内ブリッジ `episodeBridge` を置換）。**既存の runs / jobs には手を入れない**。episode は run への参照を持つ別テーブルで、録画経路（record/start → stop → MCAP）は無変更 = 録画の安全性に影響しない。

- **データモデル**（orchestrator の既存 SQLite に 2 テーブル追加）:
  - `batches`: `batch_id`（`batch_YYYYMMDD_HHMMSS`）/ `robot` / `project` / `task` / `condition` / `operator` / `target_episodes`（既定 30）/ `status`（`active` | `completed` | `ended_early`）/ `ended_reason?` / `created_at` / `ended_at?` / `episodes_recorded`（**録画した episode の単調カウンタ。既定 0**）/ `batch_seq`（**（ロボット, ローカル日付）ごとの人間可読なバッチ番号。nullable**）。`project` は Plan 由来の文字列（**Plan 自体のモデル化は Phase 2.5 に先送り**）。
    - `episodes_recorded` は `POST /api/v1/episodes` ごとに +1 し、**run 削除の CASCADE でも減らさない**（`episode_count` はライブの件数で削除時に減るが、Collect の「N / 30」等の表示は撮った数を正とするためこの単調値を使う）。既存 DB へは additive migration で追加し、現在の episode 件数で backfill。
    - `batch_seq` は **バッチ作成時（＝初回録画時の遅延生成）に発番**する: `1 + MAX(batch_seq)`（同ロボット・同ローカル日付の既存バッチ。UTC の `created_at` を `date(created_at,'localtime')` でローカル日付に変換して突き合わせ）。**毎朝ローカル日付で 1 から／ロボットごとに独立**にリセットされ、Collect/Review/Datasets の唯一の人間可読番号になる（Collect=「Batch N」、Review/Datasets=「MM/DD · #N」。日付は `created_at` から導出＝新列不要）。空バッチは行を持たない=番号を消費しない。採番は store のロック下で read→insert が同一トランザクションのためレース安全。既存 DB へは additive migration で追加し、（ロボット, ローカル日付）グループごとに `created_at` 昇順で backfill。
  - `episodes`: `episode_id`（`ep_<uuid>`）/ `batch_id` / `run_id`（**UNIQUE** = 1 episode = 1 run）/ `index_in_batch` / `task_result`（`success` | `failure`）/ `failure_reason?` / `quality`（`good` | `needs_review` | `not_usable`）/ `quality_source`（`operator` | `quick_check` | `validator`。既定 `operator`）/ `review_status`（`pending` | `adopted` | `excluded`。既定 `pending`）/ `created_at` / `updated_at`。
  - FK はコード側で担保（SQLite の FK pragma に依存しない）。`DELETE /api/v1/runs/{id}` 時は該当 episode を**コードでカスケード削除**する。
  - `plan_catalog`（1 行テーブル。2026-07-14 追加）: `id`（`=1` CHECK）/ `payload`（Projects → Tasks → Conditions の JSON 全文）/ `updated_at`。`GET/PUT /api/v1/plans` の保存先（上記「公開 API」参照）。
- **エンドポイント**:
  - `POST /api/v1/batches` — バッチ開始。body `{ project, task, condition?, operator?, robot?, target_episodes=30 }` → `201`（`robot` 省略時は **active robot** で補完）。`batch_id` は同秒衝突時にサフィックス再採番。
  - `PATCH /api/v1/batches/{id}` — 途中終了（`status` / `ended_reason`）・`condition` 変更・**`target_episodes` 変更（1–500、範囲外は 422。2026-07-14）**。**終端 status（`completed` / `ended_early`）到達時に `ended_at` を一度だけスタンプ**。不整合な遷移は緩く許容（ハード拒否しない）。不在は `404`。
  - `GET /api/v1/batches?status=&robot=&operator=` — バッチ一覧（**新しい順**）。各要素に `batch_seq`・`episode_count`（ライブ件数）・`episodes_recorded`（単調カウンタ）と**コンパクトな episodes サマリ**（`index` / `run_id` / `batch_seq` / `task_result` / `quality` / `review_status`）を同梱（リロード時のアクティブバッチ復元に使う。Collect の件数表示は `episodes_recorded` を参照）。
  - `GET /api/v1/batches/{id}` — バッチ全体 ＋ **episodes（フル）**。不在は `404`。
  - `POST /api/v1/episodes` — Collect Save 時。body `{ batch_id, run_id, index_in_batch, task_result, failure_reason?, quality?, quality_source='operator' }` → `201`。batch / run が未知なら `404`、run に既に episode があれば **`409`**（`episode_exists`）。**`quality` は任意**: 省略時は run の `quick_check.verdict.quality` から既定を導出し `quality_source="quick_check"` を付ける（`quick_check` が無ければ保守的に `needs_review`）。明示指定はオペレータ上書きとしてそのまま保存（上記「停止時クイックチェック」参照）。**`index_in_batch` はクライアントのヒント**: `(batch_id, index_in_batch)` は UNIQUE 制約で保護され、衝突時（複数端末が同番号を採番）はサーバーがロック下で MAX+1 を再採番し**実際に保存した index を応答で返す**（クライアントは応答値を採用する）。
  - `PATCH /api/v1/episodes/{id}` — Review の Adopt/Exclude（`review_status`）・品質/結果の上書き。不在は `404`。書き込みごとに `updated_at` を更新。
- **runs への JOIN**: `GET /api/v1/runs` / `GET /api/v1/runs/{id}` は各 run に `episode` サマリ（`episode_id` / `batch_id` / `batch_seq` / `index_in_batch` / `task_result` / `failure_reason` / `quality` / `review_status`）を **additive に同梱**（無ければ `null`）。`batch_seq` は episode 行でなくバッチ側にあるため、join 時に `batch_id → batch_seq` を一括引きして付与する（Review/Datasets が 2 度目の往復なしで番号を表示できる）。既存フィールドは不変。一覧はバッチ一括取得で N+1 を回避。
- **SSE**: 既存 `record_status` / `resync` で足りるため**新イベントは追加しない**（必要になれば Phase 2b）。
- **Phase 2.5 TBD**: UX 仕様の Session > Batch > Episode のうち **Session は今回作らない**（運用実績を見て判断）。Plan（Projects/Tasks/Conditions）の DB 化・Settings からの編集保存も Phase 2.5。

## 収録設定のフル編集（`GET/PUT /api/v1/config/recording`）

UI（Settings タブ）から `RECORDING_CONFIG` 全体を編集・永続化する。

- `GET` — ライブの収録設定（`app.state` 上の現値。直前の PUT を再起動なしで反映）と、そのファイルパスを `{ config, path }` で返す（未ロード時は `config: null`）。
- `PUT` — body `{ config }`。`config` を `RecordingConfig`（[config](config.md)）で型検証し、失敗時は **`422`**（違反フィールドを `details.errors` に返す）。成功時は **`RECORDING_CONFIG` のファイルへ YAML をアトミックに書き込み**（temp + `os.replace`。書き込み先は常に設定ファイルで、リクエスト由来のパスは使わない）、**メモリ上の設定をホットスワップ**する。
- 反映タイミング: `GET /api/v1/config` と**次回記録の `default_topics`（robot_name 等を含む）は即時**反映。recorder の QoS / monitor の expected_hz・許可リストは各サービスの**次回再起動時**に適用される（UI もその旨を表示する）。

## Signals / アラート規則の編集（`GET/PUT /api/v1/config/{signals,alerts}`）

Settings > Data quality から、選択式カタログ（recording / stream / validation / validators）ではない**アクティブ機体の単一ファイル設定 2 種**を編集・永続化する（S1' / F2''）。いずれもカタログ経由でアクティブ機体のファイルを解決し（committed / local 両対応）、`PUT` は pydantic で検証（**未知キーは拒否**）してから `/recording` と同じ temp + `os.replace` でアトミックに書き込む。検証失敗は **`422`**（`details.errors`）でファイルは書き換えない。`GET` 応答は `{ config, raw, path }`（`raw` は on-disk の YAML 文字列＝Advanced 生 YAML エディタの初期値。未作成時は `null`）。`PUT` body は `{ config }`（フォーム）または `{ raw }`（生 YAML。frontend は YAML パーサを積まないためサーバ側で解析）で、書き込みは常に検証済みモデルの正規 YAML。

- **`signals`**（`config/<robot>/signals/default.yaml`）: Review の Signals セクションの既定表示（`hidden_field_patterns` / `default_topic` / `defaults[{msg_type, fields}]` / `fallback_fields >= 0`）。**表示専用＝即時反映**（Review の消費フック `signalDefaults.ts` が再取得。ホットスワップ不要）。ファイル未作成の機体では `GET` は組み込み既定（`header.*` を隠す・先頭 4 リーフ）を `config` に返し `raw: null`。
- **`alerts`**（`config/<robot>/monitoring/alerts.yaml`）: topic_monitor のアラート規則（`rules[{topic, metric, op, threshold, clear_after_s, cooldown_s, severity}]` ＋ 任意の `derived_rules`）。metric は `hz|bandwidth|gap|late|loss`、op は `lt|gt|le|ge`（monitor の `AlertRule` と同一集合＝有効な alerts.yaml が往復できる）。`metric: loss` は**受理するが応答 `warnings` で警告**（`loss_rate` は monitor で常に null のため発火しない）。**反映は topic_monitor 再起動時**（alerts.yaml は起動時に 1 回だけ読み込む。ライブ再読込経路は無い＝`topic_monitor/main.py`）。`GET`/`PUT` 応答は `warnings: string[]` を追加。

## ジョブ実行（`POST /api/v1/jobs`、`dora_runner` へプロキシ）

- `dataset_export`: 対象 run が未知なら **`404`**、まだ記録中 / 停止中（`created` / `recording` / `stopping`）なら **`409`**（書き込み途中の bag を export しない）。
- `fast_validation`: `params.template` の **id（カタログのファイル stem。例 `airoa_hsr`）を Config カタログでフル template に解決**してから `dora_runner` へ転送する（dora_runner の template ストアは空起動のため、bare id は 404 になる）。id が空 / 不在なら現在の選択（active）にフォールバック。既に dict（フル template）ならそのまま通す。

## データセットエクスポート（`POST /api/v1/datasets/export(-all)`）

収録を**正本ステージング（`recorded/`）からデータセットツリー（`data/<operator>/<task>/<NNN>`）へ移動**する操作。`POST /jobs` の直接呼び出しではなく、orchestrator が `dataset_export` ジョブの完了を待ち、**run のライフサイクルまで含めて**面倒を見る。

- `POST /api/v1/datasets/export`（body `{ run_id }`）: 対象が `completed` でなければ **`409`**、`recorded/<run_id>` が無ければ **`409`**（export 済み等）。`dataset_export`（移動）を完了まで実行し、**成功した場合のみ run 行を削除**（移動済みなので `recorded/` のディレクトリ・兄弟ファイルも掃除）。**run キーのレポートサイドカー（`data/report/*/<run_id>`: validation / loss / video_check の mp4 キャッシュ）は意図的に残す** — エクスポート後もデータセット詳細ビューがそれらを表示し続けられるようにするため（`DELETE /api/v1/runs/{id}` による明示削除では従来どおり掃除される）。失敗（`502`）・タイムアウト（`504`）時は run を `recorded/` と一覧に残す。
- `POST /api/v1/datasets/export-all`: `recorded/` にファイルが残る完了 run を**全件** export。1 件の失敗でバッチは止めず、`{ exported: [...], failed: [{ run_id, error }], total }` を返す。
- **ラベルはエクスポートを生き残る（`episode.json`）** — Console v2 Phase 2: run 行の削除は episode を CASCADE で消すため、export 時に **run 行を削除する前**に該当 episode（あれば）とそのバッチを読み、`dataset.json` の隣に `episode.json`（tmp+rename でアトミック書込）を書き出す。内容 = `episode_id` / `batch_id` / `batch_seq` / `index_in_batch` / `task_result` / `failure_reason?` / `quality` / `quality_source` / `review_status`＋バッチコンテキスト `batch: { batch_id, batch_seq, project, task, condition, operator, robot }`＋`exported_at`。**これがないと、失敗ラベル付きデータが未ラベルとして export されてしまう**。episode を持たない run は `episode.json` を書かない（空ファイルも作らない）。single / export-all の両経路が同じ処理を通る。
- **ルートカタログ（`data/index.jsonl`）** — export 成功時に 1 行追記（`dataset_dir` は `data_dir` 相対＋`schema_version: 1`＋上記ラベルの軽量サブセット）、`DELETE` 時に該当行を除いて再書き込み（tmp+rename でアトミック）。派生・再構築可能な最適化であり、正本はツリー上のサイドカー（`GET /api/v1/datasets` はカタログ優先＋不在・破損時はツリー走査へフォールバック。`POST /api/v1/datasets/index/rebuild` で再生成）。書込は best-effort — export は既に MCAP を移動済みのため、カタログ書込失敗が export を失敗させることはない。
- 結果として**エクスポート済みの収録は収録一覧（Review タブ）から消える**（来歴は `<NNN>/dataset.json` に保存）。`GET /api/v1/datasets` で operator › task › NNN を一覧できる。一覧の各行には `episode.json` の**軽量サブセット**（`task_result` / `failure_reason` / `quality` / `review_status` / `batch_seq` / `index_in_batch` / `batch_id` / `condition`。無ければ `null`）をカード表示用に同梱する（`dataset.json` と同じく行ごとに読む）。`batch_id`（グローバル一意。`batch_seq` は機体×ローカル日付で毎朝リセットされるため単独ではバッチを特定できない）と `condition`（`episode.json` のネストした `batch.condition` から平坦化）は、学習セット組成側が **index.jsonl / 一覧だけでバッチ丸ごと除外・condition 絞り込み**をできるようにするための追加（2026-07-14 バッチラベル裁定）。旧カタログ行は `null` のまま — `POST /api/v1/datasets/index/rebuild` でサイドカーから補完される。
- **`GET /api/v1/datasets/{operator}/{task}/{index}` はエクスポート後の RunDetail 相当**（DatasetDetail）を返す: `dataset.json`（来歴・`files` / `bytes` / `message_count`）に加え、移動された `session.json`（state / started_at / ended_at）・`manifest.json`（topics の name / type / QoS。無ければ session / dataset.json の名前のみへフォールバック）・**`episode.json`（`episode` フィールドとして同梱。無ければ `null`）**と、エクスポートを生き残った run キーのレポート（`validation` / `loss`）を best-effort で同梱する。応答の `path`（`<operator>/<task>/<index>` 相対パス）は、エクスポート後に `video_check` / `loss_report` ジョブを実行する際の `params.dataset_dir` にそのまま使える。パスコンポーネントは単一ディレクトリ名のみ許可（トラバーサル・予約名 `recorded`/`report`/`datasets` は `400`）、ディレクトリまたは `dataset.json` 不在は `404`。
- **`DELETE /api/v1/datasets/{operator}/{task}/{index}` はエクスポート後の `DELETE /runs/{id}` 相当**（`204`）: データセットディレクトリ（`episode.json` などのサイドカーごと）を削除し、空になった `<task>` / `<operator>` 親ディレクトリを掃除、さらにエクスポート時に意図的に残した run キーのレポートサイドカー（`data/report/*/<run_id>`）も**孤児になるためここで削除**する（同じ run_id の run 行がまだ存在する場合は残す）。パス規則は詳細と同じ（不正コンポーネント・予約名は `400`、ディレクトリまたは `dataset.json` 不在は `404` — `dataset.json` の無いディレクトリは削除対象にならない）。削除に失敗した場合は `500`（`dataset_delete_failed`）。

## SSE イベント契約（`GET /api/v1/events`）

- 形式: `id:`（単調増加の整数）/ `event:`（種別）/ `data:`（JSON）。
- 種別と payload:
  - `record_status`: `{ run_id, state, message_count, bytes, started_at }`（`started_at` は additive — start 遷移を見逃したページも進行中録画の経過を描ける）
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
- run（`GET /api/v1/runs/{id}` = RunDetail）: `{ run_id, state, started_at, ended_at?: string|null, operator?, task?, topics: [ { name, type, qos } ], compression, split?: object|null, error?: { code, message }|null, episode?: object|null, quick_check?: object|null, manifest?: object|null, validation?: object|null, dataset_stats?: object|null, loss?: object|null }`（`episode` は Phase 2 の JOIN。`quick_check` は停止時クイックチェックの確定結果〔基底 `Run` フィールドなので一覧にも載る〕。末尾 4 つはディスク上サイドカー由来。いずれも不在で `null`）。
- batch（`GET /api/v1/batches` の要素 = BatchSummary）: `{ batch_id, robot?, project, task, condition?, operator?, target_episodes, status, ended_reason?, created_at, ended_at?, episodes_recorded, batch_seq?, episode_count, episodes: [ { index, run_id, batch_seq?, task_result, quality, review_status } ] }`。`GET /api/v1/batches/{id}`（BatchDetail）は `episodes` がフル episode 配列。
- episode（`POST/PATCH /api/v1/episodes`）: `{ episode_id, batch_id, run_id, index_in_batch, task_result, failure_reason?, quality, quality_source, review_status, created_at, updated_at }`（`POST` の `quality` は任意 = 省略時 `quick_check` から導出。応答の `quality` / `quality_source` は確定値）。
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
