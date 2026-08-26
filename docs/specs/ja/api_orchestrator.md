# api_orchestrator 仕様

> ステータス: 設計確定（**v2 = capture store**）。`fig_const/apiオーケストラ.png` を基に、未記載事項を推奨設計として確定。日本語が正本（これを正とする）。英語版 `docs/specs/en/api_orchestrator.md` は自動生成ミラー（直接編集しない）。**認証は不要。**

**ジョブ管理 / 状態管理 / API ハブ**コンテナ。frontend が話す唯一の公開 API（**単一入口**。REST / SSE の制御・状態を集約する。例外として WebRTC の映像・signaling のみ frontend が `webrtc_streamer` へ直接接続）。`rosbag2_recorder` / `topic_monitor` / `webrtc_streamer` / `dora_runner` は内部サービスで、orchestrator が指示・集約する。

**v2 の中心的な変更**: 旧 `runs` と `episodes` の 2 テーブル・2 API は **`captures` 1 本**に統合された。1 つの capture が「録画の事実」と「operator の判断」の両方を持つので、一覧・review・削除・archive がすべて `capture_id` で addressable になる。データの配置・耐久性の規約は [capture_store](capture_store.md) が正本で、本書はその上に載る **API と状態管理**を述べる。

## 役割

- **capture / ジョブのライフサイクル一元管理**、および capture store の索引（`kairos.db`）の維持。
- backend-driven config（設定・スキーマをバックエンドが提供。`tabs` フィールドは v1 legacy — Console v2 のタブは frontend 固定で、表示には使われない）。
- 各サービスへの指示と結果集約・通知のハブ。

## 入力

- Frontend からの操作（記録 Start/Stop、Review 保存、削除、Pipeline 実行）
- `topic_monitor` からの live metrics（SSE）
- `dora_runner` からのジョブ結果・ログ（stage3）
- ディスク上のサイドカー（`object_manifest.json` / `record.json` / `lifecycle.jsonl`）— **索引の正はこちら**

## 構成コンポーネント

- **Capture Store**（`captures` / `replicas` / `datasets` / `dataset_members` テーブルと rebuild）/ **Pipeline Registry** / **Result Aggregator** / **SSE Hub** / **Reconciler**（**Settings Manager** は将来枠・未実装。現状の設定編集は `PUT /api/v1/config/recording` が担う）
- feature ベースのルーター構成（`record` / `captures` / `datasets` / `store` / `topics` / `events` / `jobs` …）。

## 公開 API（`/api/v1`、無認証）

- 記録: `POST /api/v1/record/prepare`（two-phase start — recorder を先に arm。**DB 行は作らない**: prepare 状態はメモリ上の 1 エントリのみで、応答の `run_id` / `capture_id` は recorder が返したもの〔一致 re-prepare の keep-alive では既存 armed セッションのもの〕を採用する。後続の一致する `start` がその id で行を作って引き継ぎ、不一致・未消費なら recorder 側の auto-disarm に任せる）、`POST /api/v1/record/start`、`POST /api/v1/record/stop`（armed のみで capture が無ければ disarm も兼ねる）、`GET /api/v1/record/status`（recorder へプロキシ — 応答に **`console_git_sha`**（orchestrator 自身のビルド識別。2026-08-05）を足し、recorder の `git_sha` と並べて**ロボット/コンソールの版ズレ**を UI が検知できるようにする。**遅延 reconciliation を兼務**: DB 上 live な capture を recorder が終了済みと報告していれば（例: `MAX_RECORD_BYTES`/`MAX_RECORD_SECONDS` の recorder 内自動停止）通常の stop 経路で completed に確定し、recorder が知らない live capture は即 interrupted 化する — 再起動を待たない）。`prepare` / `start` / `stop` は v1 の request/response の形を維持したうえで **`capture_id` を追加**した。
- **検証判定（verdict）とゲート（2026-08-05）**: capture の `verdict` は `unknown` / `pass` / `needs_review` の 3 値で、**保存せず毎回 `report/<pipeline>/<capture_id>/summary.json` から導出**する（v1 の gating pipeline は `fast_validation`）。索引に焼くと再実行でズレ、rebuild で失われるため。**`needs_review` の capture は dataset に入れられない**（`409 validation_failed`）— ただし override で人が通せる。**`unknown` はブロックしない**（検証を走らせないデプロイがデータセットを作れなくなるのは別の製品判断）。CaptureDetail に `verdict`、Capture 行に `validation_override`（理由）が載る。
- **Capture（v2 の中心。runs + episodes の置換）**:
  - `GET /api/v1/captures?state=&review_status=&task=&operator=&robot=&batch=&include_deleted=`（カーソルページング。**墓標は既定で除外**する — 行は削除後も残るが、既定の一覧は operator の作業対象であって「かつて存在した全て」の書庫ではない。`include_deleted=true` で含め、`state=discarded`（または `deleted`）を明示指定した場合は**そのとおりに返す**〔明らかに存在する state を指定したのに黙って空を返す方が混乱を招くため〕）。**一覧の要素は `topics` を持たず、代わりに `topics_count`（整数）を持つ** — topic 配列は 1 行の JSON の 86–91% を占め、どの一覧画面もそれを描画しない（E-27 実測: 5,000 capture × 100 topic で 200 件ページが 2.3 MiB → 189 KiB。50 capture × 30 topic の実測でも 310,811 B → 43,711 B の 7.1 倍）。`topics` は `GET /api/v1/captures/{id}` が返す。一覧行が topic について実際に表示するのは**本数だけ**なので、その 1 つの整数は一覧に載せる — 無ければ client は本数を出すためだけに 1 行 1 リクエストで detail を引くことになり、上の削減を打ち消す。`topics_count` は **`len(topics)` からモデル側で導出**する（列に保存せず、呼び出し側にも渡させない）。保存や引き渡しは 2 つの値がずれる経路そのものであり、**detail の配列と食い違う件数は件数が無いより悪い**（どちらが正しいか下流から判別できない）。**これは転送量とメモリの改善であって表示速度の改善ではない**（frontend 実測: settle 4,438 → 4,288 ms。壁時計を決めているのは 26 回の逐次リクエストでありバイト数ではない）。 その 26 回に対する手当てとして **`limit` の上限を 200 → 1,000 に引き上げた**（既定は 50 のまま）。5,000 capture なら 26 往復が 5 往復になる。既定を上げないのは、operator が待つ 1 ページが 5,000 行の応答になってはいけないため — 全件を歩くつもりの client だけが明示的にそう言う。
  - `POST /api/v1/captures/search` — body `{ query, cursor?, limit?, facets? }` のサーバー検索。`query` は `join`、`predicates[{field,operator: contains|equals,value}]`、`states?`、`review_statuses?`、`started_from?` / `started_to?`、`present_on_instance?`、`exclude_dataset_id?` を持つ。field は `any` / `operator` / `task` / `condition` / `run_id` / `capture_id` / `task_result` / `failure_reason` / `quality` / `review_status` / `robot` / `batch_id`。日時は timezone 付き RFC3339 を UTC に正規化した半開区間 `[started_from, started_to)`（範囲不正は `422`）。応答 `{items,next_cursor?,total,facets}` は同一 SQLite read transaction の snapshot で、一覧同様 `topics` を含まない。`condition` は `collection_context` が存在すればその明示 `null` も確定値として用い、legacy の context 無しだけ Batch に fallback する。facet は `operator` / `task` / `condition` / `task_result` / `failure_reason` / `quality` / `review_status` / `robot` / `batch_id` に限り、当該 field の predicate を除いた母集団を返す。
  - `POST /api/v1/capture-selections` — search と同じ `query` を ID 昇順の immutable snapshot として materialize し `{selection_id,matched_count,expires_at}` を返す。selection は期限内であれば Dataset bulk / Validation が同じ順序で再利用でき、期限切れ・不在は `capture_selection_expired` として再検索を要する。snapshot 後に作られた capture は入らない。
  - `GET /api/v1/captures/{id}` — CaptureDetail（replica state・`digest_state`・サイドカー・レポートを同梱）
  - `PATCH /api/v1/captures/{id}/review` — `base_revision` 必須の CAS 保存（下記「Review の保存」）
  - `POST /api/v1/captures/{id}/delete` — body `{ kind: "discard"|"delete", reason? }`（下記「削除」）
  - **`POST /api/v1/captures/{id}/validation-override`（2026-08-05）** — body `{ reason }`（**必須**。`null` で撤回）。検証が `needs_review` の capture を dataset に入れることを人の判断で許可する。ledger に `capture_validation_overridden` を追記してから列に書く（順序は削除と同じ §5 — 記録の無い許可を残さない）
  - `GET /api/v1/captures/{id}/archive/config` — このデプロイが archive 先として許す root（未設定なら UI は archive の導線自体を出さない＝必ず失敗するボタンを置かない）
  - `POST /api/v1/captures/{id}/archive` — capture 単位の archive（下記「archive」）
- Batch（**Collect の進行を永続化**）: `POST /api/v1/batches`、`PATCH /api/v1/batches/{id}`、`POST /api/v1/batches/lookup`、`GET /api/v1/batches?status=&robot=&operator=&limit=&offset=`、`GET /api/v1/batches/coverage?project_id=&project=&task_id=&task=&robot=&operator=&created_from=&created_to=`、`GET /api/v1/batches/{id}`。**`POST/PATCH /api/v1/episodes` は廃止** — episode が持っていた項目は capture 行そのものに載り、書き込みは `PATCH /api/v1/captures/{id}/review` が担う（下記「Batch」）。
- **ストア健全性**: `GET /api/v1/store/health`、`POST /api/v1/store/reconcile`、`POST /api/v1/store/repair`（下記「ストア健全性と SUSPECT」）
- **views**: `POST /api/v1/views/refresh`（`views/` symlink 木をコミット済み membership から再生成。旧 `datasets/export` 系の置換）
- プラン語彙カタログ: `GET /api/v1/plans` / `PUT /api/v1/plans` — Collect がバッチ/エピソードに刻む **project / task / condition の共有語彙**。canonical 形は `projects: [{ project_id, name, tasks: [{ task_id, name, conditions: [{ condition_id, name }] }] }]`。各段の ID は rename/reorder をまたいで安定し、Batch/Start context は ID と表示名を保存する。GET は `revision` を返す（未設定は `projects: null, revision: 0`）。PUT は全置換 body に `base_revision` 必須で、同値でなければ `409 plans_conflict`（`current_revision` / `base_revision`）となり、last-writer-wins は行わない。ラベルは trim+Unicode NFC、空白・`—`・同階層の重複、ID 重複を拒否する。旧 DB/sidecar の name/string 形は rebuild で決定的 ID を付け canonical sidecar に書き戻す。`failure_reasons` は Collect の Failure 理由チップ、`operators` は帰属ロスター（認証ではない）で、いずれも同じ revision の catalog に載り、PUT で省略すれば保存済みの値を保持する。各 task は `failure_shortcuts: { left, center, right }` を持ち、スロットは共有 `failure_reasons` 語彙のラベルか `null`（vendor 非依存な論理アクション LEFT / CENTER / RIGHT の名前付け。既定は全スロット未割り当て）。検証: 同一 task 内の重複理由は拒否（422）、割り当てられた理由は**今回の PUT が持てば提出・無ければ保存済みの** effective な語彙に属さないと `422 failure_shortcut_unknown_reason`（slot と reason を details で返す）。field 無し payload（追加前のカタログ）は読み取り時に全未割り当てへ正規化される（rebuild 耐性）。
- Topic: `GET /api/v1/topics`（一覧。**情報源は `topic_monitor` の `GET /topics` discovery をプロキシ**: `name` / `type` / `publisher_count` / `subscriber_count` / `qos` / `last_seen`）、`GET /api/v1/topics/status`（monitor 由来の live metrics）
- イベント: `GET /api/v1/events`（**SSE 集約**。契約は下記）
- Pipeline / Job（stage3。詳細は [dora_runner](dora_runner.md)）: `GET /api/v1/pipelines`、`POST /api/v1/jobs`、`GET /api/v1/jobs/{id}/status`、`GET /api/v1/jobs/{id}/result`、`POST /api/v1/jobs/{id}/cancel`
- Durable Validation Run: `POST /api/v1/validation/runs`、`GET /api/v1/validation/runs`、`GET /api/v1/validation/runs/{id}`、`POST /api/v1/validation/runs/{id}/cancel`、`POST /api/v1/validation/runs/{id}/retry-failed`（下記「Durable Validation Run」）
- 検証テンプレート: `GET/POST /api/v1/validation/templates`、`POST /api/v1/validation/templates/generate`（capture から雛形生成。body `{ capture_id }`）
- ワンクリック検証プリセット: `GET /api/v1/validation/presets`（config 定義のプリセット＋未検証 capture 一覧）
- 設定: `GET /api/v1/config`（frontend 実行時設定: endpoints / tabs / defaults（`ros_domain_id`・`video_playback_rate`〔Review プレビューの既定再生速度。env `VIDEO_PLAYBACK_RATE`、既定 4.0〕を含む）/ stream / schemas）。〔`GET/POST /api/v1/settings` は**未実装**（将来）。現状は下の `PUT /api/v1/config/recording` が設定編集の入口〕
- 収録設定（フル編集）: `GET /api/v1/config/recording` → `{ config: <RecordingConfig dump>|null, path }`、`PUT /api/v1/config/recording`（body `{ config }`。下記「収録設定のフル編集」参照）
- Stream 設定（フル編集）: `GET /api/v1/config/stream` → `{ config: <StreamConfig dump>|null, path|null }`、`PUT /api/v1/config/stream`（body `{ config }`。下記「Stream 設定のフル編集」参照）
- アラート規則（単一ファイル・アスペクト編集）: `GET/PUT /api/v1/config/alerts`（topic_monitor のアラート規則。`config/<robot>/monitoring/alerts.yaml`。monitor 再起動時に反映）。`GET` は `{ config, raw, path, warnings }`、`PUT` は body `{ config }`（フォーム）または `{ raw }`（生 YAML）。下記「アラート規則の編集」参照（旧 `GET/PUT /api/v1/config/signals` は Review 波形チャートの撤去に伴い 2026-07-15 に削除）
- 設定カタログ: `GET /api/v1/config/options`、`POST /api/v1/config/select`（検証テンプレート等のカテゴリ別選択肢と現在の選択）、`GET /api/v1/config/robots/{robot}`（**任意のカタログ機体の設定を read-only で返す** — aspect 毎のパース済み内容+要約。ライブ系を切り替えずに他機体を雛形参照するため（Settings）。未知の機体・不正なパス成分は `404`）
- システム情報: `GET /api/v1/system` → `{ cpu: { model, cores }, gpu, cpu_percent, disk, gpu_percent }`（ホストの読み取り専用イントロスペクション。常に `200`）
- 手動セットアップ診断: `POST /api/v1/system/setup-check`（録画は開始せず、recorder の start 前提条件・アクティブ設定の topic pattern と ROS graph publisher の対応・monitor の受信実績 / 解決済み QoS・streamer 到達性を並列に確認）。一部サービスが失敗しても `checks[]` / `topics[]` の部分結果を返し、各項目を `pass|warning|blocker|unknown`、全体を `ready|attention|blocked` で示す。画面表示時の自動実行ではなく、Settings からユーザーが明示的に実行する。
  - 4 本の内部 probe は並列で、各 4 秒を上限とする。半開接続を含めても応答整形の余裕を残して 5 秒以内に返す（timeout は該当項目の `warning` / `blocker` として部分結果化）。
  - `cpu` / `gpu`: 静的な情報（CPU モデル名・論理コア数は `/proc/cpuinfo`、GPU 名は `nvidia-smi`。取得不能時は各フィールド `null`）
  - `cpu_percent`: ホスト全体の CPU 使用率 `[0, 100]`（`/proc/stat` の集約 `cpu` 行を 2 スナップショット差分して算出＝真の busy%。ロードアベレージではない）。差分の基準がまだ無い初回サンプルや `/proc/stat` 不読時は `null`
  - `disk`: 収録データ用ディレクトリを含むファイルシステムの `{ path, total_bytes, free_bytes }`（`shutil.disk_usage`。app が知る `data_dir` を優先し、無ければ `/data` にフォールバック。いずれも存在しなければ `null`）
  - `gpu_percent`: GPU 使用率 `[0, 100]`（`nvidia-smi --query-gpu=utilization.gpu`）。GPU 非搭載・`nvidia-smi` 取得不能時は `null`（値をでっち上げない）
  - `cpu_percent` / `disk` / `gpu_percent` は時間変化するため約 2 秒キャッシュ（SSE 相当のポーリングでも安価）。`nvidia-smi` プローブはワーカースレッドで実行しイベントループをブロックしない
- ファイル配信: `GET /api/v1/files/{path}` — `data_dir` からの**相対パス**でファイルを配信（トラバーサルガード: `data_dir` 配下のみ。それ以外・不在は `404`）。`video_check` の mp4 プレビュー取得に使う
- データセット（**論理**。物理 move は全廃）: `GET /api/v1/datasets`、`POST /api/v1/datasets`（body `{ name, operator?, task? }`）、`GET /api/v1/datasets/{dataset_id}`（members 込み）、`DELETE /api/v1/datasets/{dataset_id}`、`POST /api/v1/datasets/{dataset_id}/members`（body `{ capture_id }`）、`DELETE /api/v1/datasets/{dataset_id}/members/{membership_id}`（下記「データセット（論理）」）
- 取り込み（外部 bag）: **`GET /api/v1/imports/scan?path=<dir>`（2026-08-05）** — フォルダを**1 階層だけ走査**（そのパス自身が bag ならそれ、でなければ直下のディレクトリ。**深さ 1 は裁定** — 操作者が与えたパスの再帰走査は home や NAS ルートへ踏み込みうるため）し、bag でも bag 候補（`.mcap` はあるが `metadata.yaml` が無い等）でもないフォルダは列挙せず（ただしその直下に bag があるものは `nested: [{path, name, bags}]` としてヒント返却する）、各候補に `importable` と、不可なら理由（`already_imported` / `import_no_metadata` …）＋ remedy を付けて返す。**1 バイトもコピーせずに「何が入って何が入らないか」を先に見せる**ための API（操作者が与えたパスの再帰走査は無制限のクロールになるので浅い走査に固定）。`POST /api/v1/imports`（body `{ source_path, move?, operator?, task?, robot? }` → `202 { import_id }`。source は**サーバ上のパス**（コンテナから見えるパス）〔bag は数 GB でブラウザアップロードの対象ではない〕。検証は同期・コピーは非同期）、`GET /api/v1/imports`、`GET /api/v1/imports/{id}`
- 転送（split 構成）: `GET /api/v1/transfer/status`、`POST /api/v1/transfer/pull`（下記「転送（split 構成）」）
- 保持期間: `GET /api/v1/retention` — `RETENTION_DAYS` による**削除候補**を返す（`{ days, candidates: [{ capture_id, run_id, started_at, bytes, state, review_status }], total_bytes }`。都度計算、best-effort サイズ）。**助言のみで自動削除しない**。削除は確認付きの `POST /api/v1/captures/{id}/delete` のみ。`RETENTION_DAYS<=0` で候補は空。**v2 で候補の定義を変更**: 「行が存在する＝未エクスポート」という旧定義は、行が消えなくなった以上意味を成さないので全廃した。新しい候補は「**どの dataset からも参照されておらず、`review_status` が `pending` か `excluded` のまま N 日以上経過した capture**」（詳細は [config.md](config.md) の「運用」）
- 生成ファイル整理: `POST /api/v1/report-storage/preview` / `POST /api/v1/report-storage/cleanup` — Settings から `report/<pipeline>/<capture_id>/` の派生物を条件付きで分析・削除する（下記「生成ファイルの整理」）。任意パスは受け取らず、`RETENTION_DAYS` とも独立。
- `GET /healthz` / `GET /readyz`（依存 3 service は並列 probe。`components: { recorder, monitor, streamer }` を返し、recorder 不可は HTTP 503 + `unavailable`、任意の monitor / streamer 不可は HTTP 200 + `degraded`。`/healthz` は liveness として 200 を維持）
- `GET /openapi.json`（OpenAPI を自動公開。クライアント自動生成に使える — 現状の frontend は手書きの型付きクライアント）

### 廃止した API（互換エイリアス無し）

alpha 版につき互換レイヤは置かない。**どれも何もしない**が、返るコードは一律ではない: 経路が完全に消えたものは `404`、**残っている別ルートとパスだけが衝突するものは `405`**（例 `POST /api/v1/datasets/export` は `GET|DELETE /api/v1/datasets/{dataset_id}` に `dataset_id="export"` として一致し、POST が登録されていないので Method Not Allowed になる）。**重要なのはコードの種類ではなく、旧ルートがもう何も行わないこと。**

| 廃止 | 置換 |
|---|---|
| `GET/DELETE /api/v1/runs`、`GET /api/v1/runs/{id}`、`DELETE /api/v1/runs/{id}` | `GET /api/v1/captures`、`GET /api/v1/captures/{id}`、`POST /api/v1/captures/{id}/delete` |
| `POST/PATCH /api/v1/episodes`、`PATCH /api/v1/episodes/{id}` | `PATCH /api/v1/captures/{id}/review` |
| `GET/DELETE /api/v1/datasets/{operator}/{task}/{index}` | `GET/DELETE /api/v1/datasets/{dataset_id}` |
| `POST /api/v1/datasets/export`、`POST /api/v1/datasets/export-all`（**`405`**） | `POST /api/v1/datasets/{id}/members` ＋ `POST /api/v1/views/refresh` |
| `POST /api/v1/datasets/index/rebuild` | 不要（`data/index.jsonl` ごと廃止。索引は起動時 rebuild が担う） |

## Capture ライフサイクル（orchestrator が一元管理）

1. `POST /api/v1/record/start` → orchestrator が **`run_id`（表示名）を採番**し、recorder の `POST /record/start` を呼ぶ。**`capture_id` は recorder が発行**して応答で返す。`collection_context` は `{ batch_id, batch_seq, project_id, task_id, condition_id, project, task, condition, robot, operator }`（全 nullable、未知フィールド保持）の Start 時スナップショットであり、`batch_id` を指定した場合は Batch の存在・`active` 状態・context との一致を start 前に検証する。不一致・終了済み・不在は録画を始めずエラーにする。`batch_id=null` でも labels を持つ録画は許可する。
   `operator` / `task` は **255 バイト（UTF-8）を超えると `400 label_too_long`**（`prepare` も同じ）。これらはパスにならないが、dataset が自分の `operator` / `task` を未設定にしたとき **views の木が capture 側の値を借りる**（`COALESCE(d.operator, c.operator)`）ので、dataset 側だけを縛ると木を壊す経路が残る（→ capture_store §6）。
2. 応答の `capture_id` で `captures` 行を作る（`state=recording`）。成功した capture 行は Start 時に `collection_context.batch_id` を関連付け、context は DB index と Capture API に露出する。recorder が拒否した場合、**recorder が capture を名指ししていればその id で `failed` の行を返す**。名指ししていなければエラーをそのまま伝播させ、recorder が書いた失敗 start サイドカー（`objects/<capture_id>.failed.json`）を次の rebuild が行にする。
3. start 成功直後に recorder の `GET /record/metadata` を取得し、**確定した topics / type / QoS（`"all"` 展開結果を含む）を capture 行へ同期**する。取得失敗時は `recording` のまま `error` に理由を記録して再試行する。
4. `POST /api/v1/record/stop` → recorder stop → 最終 metadata（`message_count` / `bytes` / `ended_at` / topics）を再同期して `state=completed`。確定後、**停止時クイックチェックを stop 応答の外で走らせ**（下記）、さらに **digest ジョブを投入**する（下記「digest ジョブ」）。

   **stop は必ず「止める」**: 冪等性は「recording を主張する DB 行が無ければ何もしない」ではない。行は欠けたり別状態になったりする（start の行が未コミット、クラッシュ、reconcile の競合）ので、`stop` は行が無いときに **recorder の実状態を問い合わせる**:
   - recorder が非稼働 → 従来どおりの冪等 no-op（直近 capture を返す／capture が皆無なら 404）
   - recorder が録画中で**その capture の行がある** → その行を採用し、通常の停止・確定経路を通す
   - recorder が録画中で**行が無い**（orphan）→ **その capture の行を manifest から復元して**通常の停止・確定経路へ乗せる。`kairos.db` を録画中に消して再起動した場合がこれで（rebuild の規則 1 が live capture を意図的に除外するため行が存在しない）、以前は/*別の*/直近 capture を `200` で返していた — 操作者から見て「Stop が成功し、直前のテイクが返ってきた」という自信のある誤答。manifest すら読めず復元できない場合は、**別の take を返さず** `409 stop_capture_unfiled` で当該 `capture_id` を名指しする（recorder は止める — bag が伸び続ける方が悪い）。

   採用・orphan 停止のどちらも WARNING でログする（ここに到達した時点で DB と recorder が乖離している）。これを欠くと、止まっていないのに `200` を返し、コンソールは録画中のテイクのラベル付けへ進み、`MAX_RECORD_SECONDS` の自動停止だけが唯一の終端になる。
5. **再起動時の整合**: 起動時に `recording` / `stopping` の capture を recorder の `GET /record/status` と突き合わせ、実体が無ければ `state=interrupted` に更新する。

- **`capture_id` は recorder が所有**し、orchestrator は受け取って索引する（`run_id` は orchestrator が採番する表示名）。
- **サイドカーが正、DB は索引。** `object_manifest.json` / `record.json` / `lifecycle.jsonl` から `kairos.db` を全再構築できる（[capture_store](capture_store.md) §8.2）。v1 の「SQLite が唯一の正、manifest は監査用」は**撤回**。
- capture 行の `topics` / type / QoS は recorder の metadata 由来（orchestrator が上記タイミングで同期する）。
- capture state の enum は [capture_store](capture_store.md) §8.1 と共有 [config](config.md) に従う。
- **start 時の operator / task**: 空のときは `unknown_operator` / `unknown_task` を既定値とする。v2 ではパスの構成要素ではなくなったが、`views/` の木と一覧のグルーピングが常に keyable であるよう null を排除する。**予約名**（`objects` / `views` / `.trash` / `.incoming` / `report` / `catalog` / `lifecycle.jsonl` / `instance.json` / `kairos.db`）の検査は、それらがパス構成要素になる **dataset 作成時**に行う（`POST /api/v1/datasets` の `name` / `operator` / `task` → `400 reserved_name`）。 同じ場所で**長さ**も検査する: `name` / `operator` / `task` はいずれも **UTF-8 で 255 バイト（NAME_MAX）以下**で、超えると `400 label_too_long`（`details.field` で該当フィールドを名指しし、入力そのものは返さない）。文字数ではなくバイト数なのは、それがファイルシステムの単位だから — 絵文字 200 字は 800 バイト、漢字 200 字は 600 バイトで、`name` の既存の 200 **文字**上限では表現できない。なお木の側でも `views` の再生成は置けないメンバを **skip して報告**する（古い設置の manifest は誰も検査していないため。→ capture_store §6）。
- **`record_status` SSE**: record start / stop の状態遷移ごとに `record_status` イベントを発行する（下記 SSE 契約）。
- **`GET /api/v1/captures/{id}` は CaptureDetail を返す**: capture 行に加えて、ディスク上のサイドカーとレポートを best-effort で同梱する — `manifest`（`object_manifest.json`）/ `record`（`record.json`）/ `validation`（`fast_validation` レポート）/ `loss`（`loss_report` レポート）。各ファイルが無ければ `null`。

### 取り込み時のラベル指定（`operator` / `task` / `robot`）

`POST /api/v1/imports` の body に任意で 3 つ渡せる。省略時は従来どおり**無ラベル**で入る。

- **合成する `object_manifest.json` に直接刻む**（§3.3）。`record.json` の §4.3 override ブロックは
  **使わない**。import は capture の**出生 manifest を書く経路**なので、ここで operator を名乗るのは
  recorder が `/record/start` のリクエストから刻むのと同じ「記録された事実」の記入であり、
  override（＝封印後の訂正）ではない。無かった値に対して「前の値が誤っていた」と主張しないため。
- この選択のおかげで **rebuild 生存は manifest 経由で自然に成立**し、§4.3 との合成も正しくなる —
  取り込み後に Review で編集すると override が**この値の上に**乗り、**その編集をクリアすると
  取り込み時に宣言した値へ戻る**（null ではなく）。一度入力した値が訂正で食い潰されない。
- **一括指定は「同じ body を対象 bag の数だけ POST する」**。取り込み実行の入口はこの 1 本だけで、
  UI の一括取り込みも bag ごとに 1 リクエストを送る形で実装されている。
- バリデーションは §4.3 と同じ（`400 unsafe_label` / `400 label_too_long`）で、**取り込み開始前**に
  行う。拒否時は import レコードも capture も作られず、`objects/` にも source にも何も起きない
  （`move=true` でも source は無傷）。空文字・空白のみは「未指定」として扱う。

## Review の保存（`PATCH /api/v1/captures/{id}/review`）

旧 `POST/PATCH /api/v1/episodes` の置換。**サイドカー先行 + CAS**（規約は [capture_store](capture_store.md) §4.1）:

1. `base_revision` が現在の `captures.review_revision` と一致しなければ **`409 review_conflict`**。クライアントはリロードして適用し直す — **マージはしない**。
2. `record.json` を `revision = base_revision + 1` で atomic write。失敗 → **`500 review_sidecar_write_failed`、DB は無変更**（何も保存されていないので、同じ `base_revision` でそのまま再試行できる）。
3. DB を CAS 更新。`rowcount=0` なら **`409`**。書いたサイドカーは巻き戻さない。

- body: `{ base_revision, task_result?, failure_reason?, quality?, quality_source?, review_status?, batch_id?, index_in_batch?, operator?, task?, robot? }`。Start 時の `collection_context.batch_id` が非 null なら、`batch_id` はその固定値と同じ場合だけ受理し、別 Batch への変更・明示 clear は `409` で拒否する。Start 時に `batch_id=null` だった capture だけは、初回 Review 保存時に snapshot の `robot` / `operator` / `project` / `task` / `condition` が完全一致する active Batch へ関連付けられる。以後は変更・clear 不可。既存の同一 `batch_id` は terminal capture の review でも保存できる。
- **`operator` / `task` / `robot` はラベル編集**（規約は [capture_store](capture_store.md) §4.3）。主用途は
  **取り込み bag のラベル付け**（ラベルを持たずに生まれるので後から人が付けるしかない）だが、通常録画の
  訂正にも使う。CAS・mutex・サイドカー先行はすべて他の review フィールドと同一経路。
  - **明示 `null`（および空文字・空白のみ）はクリア** → manifest が記録した値に戻る。取り込み bag では
    記録が無いので `null` に戻る。**省略は変更なし**（既存の override は保たれる）。
  - override は `record.json` の `labels` に入り、**manifest は書き換えない**。`kairos.db` を消して
    再起動しても編集は残る（rebuild が manifest の上に `labels` を適用する）。
  - `/` `\\`・制御文字・`.` / `..` は **`400 unsafe_label`**、255 バイト超は **`400 label_too_long`**。
    拒否されたリクエストは**何も適用しない**（同一 body 内の他フィールドも含む）。
  - `operator` / `task` の編集は `views/` の再生成をスケジュールする（dataset が両方を持たないとき
    `views/` は capture の値にフォールバックするため）。`robot` はパス構成要素ではないので何もしない。
- **旧 `POST /episodes` の副作用の移設先がここ**: `batches.episodes_recorded` の単調加算と auto-pull の起動は「**その capture への初回 review 保存**」で起きる。初回 review の CAS とカウンタ更新は同一 SQLite transaction で行い、sidecar 成功後に部分的な増分を残さない。
- 墓標・非在の capture への保存は `409`（`capture_deleting` / `capture_deleted` / `capture_not_present`）。

## 削除（`POST /api/v1/captures/{id}/delete`）

body `{ kind: "discard"|"delete", reason? }`。**`discard` は `reason` 必須**（`400 reason_required`）— 破棄は不可逆で、ledger の 1 行がその後に残る唯一の説明になるため。

手順・墓標・reaper の規約は [capture_store](capture_store.md) §7。API から見た要点:

- **応答は「`.trash` へ移り墓標が確定した時点」で返る。** 物理削除（reaper）はその後にバックグラウンドで走る。この分割が肝で、operator の操作は墓標で耐久化され、reaper が失敗しても「`unlink` でハングしたリクエスト」ではなく「`trashed` のまま見える replica」が残る。
- `409 capture_busy` — ジョブが lease を持っている（応答は owner と失効時刻を名指しする）。
- `409` — `recording` / `stopping` 中。
- `400` — `dataset_members` から参照中（先に member を外す）。
- `503 delete_unavailable` — `objects/` と `.trash/` が別ファイルシステム。**ルートは登録されたまま残り、要求ごとにこの応答を返す**（黙って消えるのではなく理由を述べて断る。同じ理由は `GET /api/v1/store/health` の `delete_unavailable_reason` にも出る）。archive も source 削除を伴うので同じ扱い。
- 削除は `report/<pipeline>/<capture_id>/` も回収する。**行は消さない**（墓標）ので、「どこへ行ったのか」は後から常に答えられる。

## archive（`POST /api/v1/captures/{id}/archive`）

capture 単位で外部ストレージへ退避する。**copy → sha256 verify → ledger(`capture_archived`) → source 削除**（trash 経由）の順序を守る。

- **`202` + サーバ側実行 + 進捗ポーリング**（2026-08 改修）。多 GB のコピーはどんな proxy タイムアウトよりも長く、リクエスト内で完走させると最悪の分裂 — サーバは archive を完了して source を削除したのに、クライアントは 504 の「失敗」を見る — を起こすため。`POST` は同期の拒否（active / lease 保持 / dataset member / 不正・重なり・非空 destination）だけを行ってから `202 {capture_id, destination, state:"running"}` を返し、実行は背景ラン（走行中の再 POST は `409 archive_in_progress`）。
- `GET /api/v1/captures/{id}/archive` — 進捗。`{state: "running"|"complete"|"failed", bytes_done, bytes_total, error?, result?}` で、終端エントリは次のランが置き換えるまで読める。ラン登録はメモリのみ（再起動後は `404 archive_not_found`）— データの耐久性は ledger の仕事で、失われるのは進捗ビューだけ。`result` は従来の完了応答（per-file hashes 込み）そのもの。
- destination は `KAIROS_ARCHIVE_ROOTS` に対して検証してから 1 バイトもコピーしない — このエンドポイントは**最後に source を消す**ので、無制限な destination 文字列がシステム上もっとも危険な入力になる。
- **重なりの拒否は許可リストとは別の検査**（前者を通ったことは後者の証拠にならない）。検査するのは**解決後の書き込み先**（`<destination>/<capture_id>`）で、許可ルートそのものではない — したがって **`data_dir` を含むルートを許可すること自体は禁止していない**（`KAIROS_ARCHIVE_ROOTS=/data` は operator がやりそうな設定であり、許可リストだけでは自分自身の上へコピーしてから source を消す経路が通ってしまう）。`realpath` で両側を解決し（symlink での偽装を防ぐ）、**両方向の包含**を見る。違反は `400 destination_inside_data_dir`。
- **非空の destination は `409 destination_not_empty`**（コピーのプリミティブ側で拒否する）。
- ledger の `capture_archived` イベントは **per-file の `{path, size, sha256}`** と `collection_context`（未知フィールドを含む）を持つ。source が消えた後は manifest も一緒に消えるので、これが無いと「N バイトが /mnt/nas へ行った」としか言えず、数年後に「そのコピーはまだ無事か」や「その収録時の文脈は何か」に答えられない。ledger-only rebuild は同じ context を復元する。
- **dataset member の capture は archive も拒否**（delete と同じ `400`）。`views/` の symlink が宙に浮くため、先に member から外す。唯一の免除は §6.1 の dataset archive ランナー自身（下記）で、**当該 run の dataset の membership に限る**。

## dataset archive（`POST /api/v1/datasets/{id}/archive`・§6.1）

dataset の終端遷移。capture archive を dataset に持ち上げたもので、行き先の検証（許可リスト＋解決後 dataset_dir への双方向重なり検査）と搬出順序（copy → verify → ledger → source 削除）は per-capture と同一。

- `POST /api/v1/datasets/{dataset_id}/archive` — body `{ destination?, path?, mode?, reason? }` → **`202`**（開始/再開兼用）。`mode` は `move`（既定・源を削除・専有 member 必須）か `copy`（封印のみ・源不変・共有 member 合法 — 合成した集合の標準）。`path` は root 配下の**operator が選ぶ相対パス**（最終要素が dataset のフォルダ。UI は views 形状で先埋め）。絶対パス・空は `400 invalid_destination`、`..` 等のエスケープは最終ディレクトリの realpath 再検証で `400 destination_not_allowed`、既存エクスポートとの衝突は `409 destination_not_empty` または `409 destination_claimed`。省略時はサーバが `<destination>/<operator>/<task>/<name>` を合成する（成分は views と同じ sanitize）。copy は `delete_unavailable` の環境でも実行できる（何も消さないため）。新規開始と再開の直前に、選択 root が実在する directory で耐久書き込みできることを小さな probe file の作成・fsync・削除で確認する。
  - 開始前の拒否: `404 dataset_not_found` / `409 dataset_archived`（終端） / `409 dataset_empty` / `409 dataset_member_shared`（他 dataset にも属す member を **details.conflicts に全件列挙**） / `409 dataset_not_archivable`（busy / 不在の member を **details.blockers に各自の理由付きで全件列挙** — N 件の操作を 1 件ずつ突き返して N 往復させない、という意図的な集約） / `409 destination_not_empty` / `409 destination_claimed`（行き先を既に別の dataset が保持している。`details.held_by` にその dataset_id） / `400` 系は capture archive と同じ（`archive_not_configured` / `invalid_destination` / `destination_not_allowed` / `destination_inside_data_dir`） / `503 delete_unavailable`・`ledger_unwritable`・`archive_destination_unavailable`（root が未 mount / 非 directory / 書き込み不可。CAS と started event より前なので dataset は active のまま）。
  - 再開: status が `archiving` で run が走っていなければ再 POST が冪等に続きから再開する。destination / mode は**省略するか、記録と一致**（違えば `409 archive_destination_mismatch` / `409 archive_mode_mismatch`）。走行中は `409 archive_in_progress`。
- `GET /api/v1/datasets/{dataset_id}/archive` — 進捗。耐久フィールド（status / destination / archive_started_at / archived_at）は行由来で再起動を生き延び、`running` / `current_capture_id` / `current_bytes` / `error` はプロセスメモリで正直にリセットされる。**`archiving` かつ `running: false` が原則「再開可能」**で、UI はこれを Resume として描く。ただし `cancel_blocker: archive_canceled` は ledger 上で cancel 済みだが DB 反映待ちの状態であり、Resume を出さない。さらに `cancelable` / `cancel_blocker` は、halted かつ完了 member が 0 件で、行き先に完了ファイルが無いことをサーバが確認できたかを示す。判定に必要な started / canceled / sealed / member 完了は 1 回の ledger snapshot から導出し、1 秒間隔の poll で append-only ledger を重複走査しない。`error.code` にはランナーが停止した理由が入る（`ledger_unreadable` = ledger が読めずランは何も判断できないので停止した。開始前の拒否ではなくランの停止なので上の列挙には含まれない。他に `bytes_unaccounted` / `capture_not_found` / `internal_error` など）。`GET /datasets/{id}` の拡張ではなく別 endpoint なのは、1 秒間隔のポーリングが detail キャッシュを暴れさせないため。
- `POST /api/v1/datasets/{dataset_id}/archive/cancel` — **走行中の stop ではない**。`archiving`・`running: false`・完了 member 0 件・未封印・行き先に完了ファイル無しの試行だけを解除する。先に `dataset_archive_canceled` を ledger へ append し、次に行を `active` へ戻して destination / mode / started_at の claim を解放する。行き先の file は削除しない。条件外は `409 archive_not_cancelable` / `archive_in_progress` / `archive_cancel_unsafe` で、部分完了を rollback と見せず Resume だけを許す。ledger append 後に DB reset が失敗した場合は `503 archive_cancel_catalog_pending` とするが、cancel は耐久的に成立済みであり、同じ attempt の Resume と runner は `archive_attempt_canceled` として拒否する。
- status ≠ `active` の dataset への member 追加・削除は `409 dataset_not_active`、`DELETE /datasets/{id}` は `409 dataset_archiving` / `409 dataset_archived` — **archived の行は移行ログの照会キャッシュであり消させない**。逆向きに、archive 済み capture は `409 capture_archived`、非 active dataset の member は `409 capture_archiving` で新たな dataset に入れない。

## 転送（split 構成・`/api/v1/transfer/*`）

ロボットと録画 PC が別ホストの構成で、完成した capture を録画 PC 側へ引き寄せる経路。実体の rsync は importer サイドカー（`deploy/sync/`、`compose/recording.yaml` にのみ存在し 127.0.0.1 に bind する）が行い、orchestrator がその唯一の呼び出し元になる。

- `GET /api/v1/transfer/status` → `{ available, auto_pull_on_save }`。`available` は importer の `/healthz` 到達性で、これが**そのまま frontend にとっての split 判定信号**になる（単一ホスト構成では importer が存在しないので false）。
- `POST /api/v1/transfer/pull` → `202`。body の **`capture_id` は任意**:
  - **指定あり** → importer へ `{"capture_id": …}` を転送し、その capture だけを引く。
  - **省略** → 「完成している capture を全部引く」の意味になり、importer へは**明示的な `{"all": true}` として転送する**。**空の body を送ってはならない** — importer 側は空 body を `400` で拒否する仕様で、これは意図的な設計である。キーを 1 つ落としただけの要求が、狙い撃ちの pull からロボット全体のスイープへ**降格することを構造的に禁じる**ためで、スイープは常に明示的に要求されたときだけ起きる。
- **完了（到着）はこの API では通知されない**（ack は fire-and-forget）。frontend が見るのは capture の **replica state** で、reconciler が届いたディレクトリを採用した時点で `present_unverified` に変わる。v1 の `bag_local` 真偽値は廃止した — 「ここにある / 無い」しか言えず、**届かなかったコピーと意図的に消したコピーを区別できない**ため。
- `GET /api/v1/transfer/pull/{capture_id}` — **失敗チャネル**（2026-08 追加）。202 は importer が ssh に触れる前に返るので完了信号にはなり得ず、rsync が死んだ pull は importer のコンテナログ以外から見えなかった。importer が per-pull に `queued → running → ok | failed` を追跡し（exit code と 1 行の理由付き）、この endpoint がそれをプロキシする。UI は転送中この状態を読み、`failed` でスロットを失敗表示に落とす（到着確認は従来どおり replica state）。pull が知られていなければ `404`（importer 再起動でメモリ上の追跡は消える — 耐久な答えは replica state）。importer 側は加えて (a) **実行中の pull も dedup 対象**（再クリックが同一ファイルへの 2 本目の `--append-verify` rsync を積まない）、(b) スクリプトをプロセスグループごと kill（timeout が bash だけ殺して rsync 孫を残さない）、(c) ssh に `ConnectTimeout` / `ServerAlive*`、rsync に `--timeout=60`（半開 TCP が直列 worker を 1 時間塞がない）。
- importer は `.incoming/<capture_id>` に staging し、完了後に `os.replace` で `objects/` へ入れる。したがって `objects/` に見えている capture が部分コピーであることはない（[capture_store](capture_store.md) §2）。
- **auto-pull**: `transfer.auto_pull_on_save` が有効なとき、**その capture への初回 review 保存**の後に orchestrator が上記の pull を 1 件分投げる。既定は無効で、明示的な opt-in が無い限り何も転送しない。

## ストア健全性と SUSPECT（`/api/v1/store/*`）

capture 一覧には**決して現れない 2 つの最悪の状態**を可視化するためのエンドポイント群:

- rebuild が読めなかった manifest — その capture には行が無い（[capture_store](capture_store.md) §8.2 規則 4 が「無い」ことにするのを禁じている）ので、一覧に出しようがない。
- 一度に大量のコピーが消えたために適用を拒否した reconciler パス — このときカタログは**正常に見える**のに、ディスクはそうではない。

- `GET /api/v1/store/health` → `{ instance_id, state: "ok"|"suspect", suspect_reason?, suspect_at?, delete_available, delete_unavailable_reason?, rebuilt_at?, rebuild_summary?, corrupt: [{capture_id?, path, reason}], corrupt_source: "rebuild"|"reconcile", corrupt_observed_at?, warnings: [], dismissible_warnings: [], last_reconcile_at?, last_reconcile? }`。`dismissible_warnings` は global banner でローカル acknowledgement を許す `warnings` の部分集合で、現在は batch counter の lower-bound 通知だけを含む。dataset archive destination conflict や batch identity collision など、それ以外の rebuild 警告は含めず永続表示する。
  - corrupt リストは 1 本で、**最新の「完走した」スキャンが勝つ**。観測できなかったパス（marker 不一致・ledger 不読）は、保持しているリストを**クリアせずそのまま保つ**（見えなかったことを「全部きれいだった」と報告しない）。閾値でブロックされたパスも、見た内容は報告する。
- `POST /api/v1/store/reconcile` — 整合パスを今すぐ 1 回走らせて結果を返す（背景ループと同じパス。マウントを直した operator が間隔を待たずに済むように、またテストが sleep でなく決定的に駆動できるように公開している）。
- `POST /api/v1/store/repair` — SUSPECT を解除する operator の承認。**volume marker が読めないときは `409 volume_unidentified` で拒否する** — ラッチは「ボリュームごと消えた」と「ファイルが消えた」を区別できないことを理由に存在するので、どのボリュームを承認しているのか名指しできない承認は承認ではない。解除後は `approved=True` で 1 パス走らせる（通常パスを走らせ直すと同じ閾値で再ラッチし、Repair が何もしないボタンになるため）。

## digest ジョブ

停止後に per-file sha256 を計算し、`object_manifest.json` を**単一の atomic write で 1 回だけ**封印する（`files` / `manifest_digest` / `digest_state=complete`）。完了で `replicas.state → present_verified`。

- 起動条件は 2 つ**両方**の確認: (a) `captures.state` が terminal (b) recorder がその capture を保持していない（`live_capture_ids` に無い）。**検証前に `present_verified` へ昇格させない。**
- 実行中は `digest_state=pending` として UI に出る（「検証済み」と「検証中」を混ぜない）。
- クラッシュ後は reconciler が pending を再投入する（途中結果は捨てて最初からやり直す）。
- `objects/<id>` に触れる前に lease を取り、最終書き込みの直前にロック下で `captures.state` を再確認する（`delete_pending`/`discarded`/`deleted` ならスキップ）。

## 停止時クイックチェック（`quick_check` settlement）

録画停止時に orchestrator が **2 層のクイックチェックを一度だけ確定（settle）**し、capture 行に `quick_check`（JSON）として永続化する。分担: topic_monitor = 常時のライブ検知、**orchestrator = 停止時の一度きりの確定**、dora_runner = 事後のディープ解析（quick_check には手を出さない）。**stop の HTTP 応答は現状以上に遅延させない**: capture を終端状態（`completed` 等）に確定し `record_status` を発行したあと、確定処理を **stop 経路の外（バックグラウンドタスク）**で走らせ、完了時に capture 行を `quick_check` で更新する。各下流呼び出しに個別タイムアウト — monitor 読みは `3s`＋retry 1（2026-08-11, sweep S4: 旧 1.2s/no-retry は単一ホスト LAN の仮定で、split では 1 往復の遅さが verdict を黙って情報の少ない fallback に落としていた。背景タスクなので operator を待たせない）、MCAP summary 読みは `1.5s`。START 時のベースライン取得だけは start 経路上なので `2s`・no-retry のまま。タイムアウト時は**完了した分だけ**を `available` フラグを正直に落として永続化する（正直な degradation）。

settle を積むのは stop 経路だけではない — **terminal manifest を採用したあらゆる経路**が同じ確定を走らせる: `GET /record/status` の遅延 reconciliation、新規 start 時の stale live 行の整理、orchestrator 再起動時の interrupt、そして**定期 reconciler の採用パス**（無人運用で上限自動停止に最初に到達するのはこの経路）。stop 以外の経路では入力を live recorder ではなく**当該 capture 自身のサイドカー**から取り、ウィンドウ終端は `now()` ではなく **`ended_at`** を使う（数分〜数時間後の照合が、収録後の monitor incident を窓に取り込まないため）。

- **Layer 0（MCAP を読まない、~ms）** — 停止時に一度だけ引く:
  - monitor `GET /metrics` スナップショット（per-topic `hz` / `expected_hz` / `rate_shortfall` / `gap_max_ms` / `dds_samples_lost`）。`expected_hz` は `RECORDING_CONFIG` の `expected_hz_patterns` を fnmatch 先勝ちで解決（monitor と同じ規則）。`dds_samples_lost` は **録画 START 時に取ったベースライン（monitor スナップショットを in-memory に保持、`capture_id` キー）との差分**で全区間値にする（ベースライン取得は best-effort・短タイムアウト = start を遅延させない）。
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

**永続契約（FIXED — frontend が実装対象）**: `quick_check` を capture 行に保存し（基底 `Capture` フィールド = 一覧 / 詳細どちらにも載る）、capture を返す全経路で公開する。settlement 完了までは `null`。形:

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

- **既定品質は `quick_check.verdict.quality` から導出**する（既存の D-2「integrity→品質」シームを**拡張**）。`PATCH /api/v1/captures/{id}/review` で `quality` を**省略**すると、capture の `quick_check.verdict.quality`（`good` | `needs_review`）を既定値とし `quality_source="quick_check"` を付ける。明示的な `quality` はオペレータの上書きとしてそのまま保存（`quality_source` は既定 `operator`）。`quick_check` が無ければ保守的に `needs_review`（未確定は good と見なさない）。
- **確定後の遅延再導出（save-before-settle レース対策）**: settlement 完了で capture に `quick_check` を書き込んだ**直後**、その capture が既に review 済み（`review_revision > 0`）で `quality_source == "quick_check"` のとき、`quality` を確定 verdict の値へ更新する。settle 完了前に保存された review が保守的な `needs_review` フォールバックのまま取り残されるのを補正するもの。`operator` / `validator` 由来の品質には**決して手を出さない**（人／ディープ解析の判断）。
  - **この訂正も §4.1 の通常経路を通り、`revision` を進める。** その結果クライアントが `409` を受けるのは正しい挙動で、「手元の review はもう最新ではない」という事実をそのまま伝えている。settle 中に operator が編集していれば `409` になり、**その人の判断が勝つ**（訂正は諦める）。
  - 再導出の失敗は独立に握り潰し、確定済みの `quick_check` を settlement 失敗として誤報しない。専用の SSE 経路は足さない（フロントは result パネルの `GET /api/v1/captures/{id}` ポーリングで確定結果を取得する）。

## Batch

Collect の Batch 進行を orchestrator に**永続化**し、Review が端末に依存せず実データを表示できるようにする（ブラウザ内ブリッジ `episodeBridge` は削除済み）。

**v2 で `episodes` テーブルは無くなった。** episode が持っていたフィールド（`task_result` / `failure_reason` / `quality` / `quality_source` / `review_status` / `batch_id` / `index_in_batch`）は **capture 行そのもの**に載り、書き込みは `PATCH /api/v1/captures/{id}/review` が担う。1 run = 1 episode という UNIQUE 制約も、1 capture が両方の役割を持つことで構造的に不要になった。

- **データモデル**:
  - `batches`: `batch_id`（`batch_YYYYMMDD_HHMMSS`）/ `robot` / **canonical `project_id` / `task_id` / `condition_id`**（custom・旧行は `null` を許容）/ `project`（**nullable**）/ `task`（**nullable**） / `condition` / `operator` / `target_episodes`（既定 30）/ `status`（`active` | `completed` | `ended_early`）/ `ended_reason?` / `created_at` / `ended_at?` / `episodes_recorded`（**録画した本数の単調カウンタ。既定 0**） / `episodes_recorded_is_floor`（**その値が rebuild 由来の下限かどうか。既定 false**）/ `batch_seq`（**（ロボット, ローカル日付）ごとの人間可読なバッチ番号。nullable**）。ID も文字列ラベルと同じ immutable provenance で、非空 Batch では変更・clear を拒否し、ledger/rebuild で保存する。
    - capture の `batch_id` は Start 時の `collection_context` で関連付ける。`episodes_recorded` は**その capture への初回 review 保存**ごとに +1 し、**capture の削除でも減らさない**（`episode_count` はライブの件数で削除時に減るが、Collect の「N / 30」等の表示は撮った数を正とするためこの単調値を使う）。
  - **バッチ行は ledger から rebuild される**（[capture_store](capture_store.md) §8.2 規則 6・§5）。`batch_created` / `batch_updated` / `batch_ended` が正本で、`project` / `task` / `robot` / `condition` / `operator` / `target_episodes` / `batch_seq` / `status` はそこから戻る。replay は冪等（値はイベントから読み、行から計算し直さない）。`batch_updated` の provenance label の明示 `null` は clear として記録されるので、rebuild 後も clear のまま残る（フィールド自体が無い旧イベントは変更なし）。**このイベントより古い ledger にはこれらの行が 1 つも無い**ので、その設置ではバッチ行は戻らず、capture がその `batch_id` を名指ししたまま残る — 孤児として rebuild 時に警告で報告される。これは欠落ではなく決定（遡って埋める材料が存在しないため。→ capture_store §8.2 規則 6）。**`episodes_recorded` だけは event から戻せない**（review 保存という出来事の単調カウンタであり、ledger が記録するのは事実）。replay は代わりに**そのバッチを名指ししている capture 行を数え直し**、`episodes_recorded_is_floor: true` を立てる — これは**下限**（review 済みで後に削除された capture は数えられない）。以前は 0 に戻していたが、0 は下限ですらない誤りだった。rebuild で下限化されたバッチ数は store health の警告に出る。capture 側の `batch_id` / `index_in_batch` は `record.json` から復元されるため、「どの capture がどのバッチの何番だったか」は残る。
    - 上記の capture 関連付けは `record.json` だけに依存しない。manifest の `collection_context.batch_id` が非 null ならそれを優先し、null の場合だけ `record.json.batch_id` へ fallback する。`record.json` は review 情報と `index_in_batch` を復元する。counter floor の再計数対象は `review_revision > 0` の capture に限る。
    - `batch_seq` は **バッチ作成時（＝初回録画時の遅延生成）に発番**する: `1 + MAX(batch_seq)`（同ロボット・同ローカル日付の既存バッチ。UTC の `created_at` を `date(created_at,'localtime')` でローカル日付に変換して突き合わせ）。**毎朝ローカル日付で 1 から／ロボットごとに独立**にリセットされ、Collect/Review/Datasets の唯一の人間可読番号になる（Collect=「Batch N」、Review/Datasets=「MM/DD · #N」。日付は `created_at` から導出＝新列不要）。空バッチは行を持たない=番号を消費しない。採番は store のロック下で read→insert が同一トランザクションのためレース安全。既存 DB へは additive migration で追加し、（ロボット, ローカル日付）グループごとに `created_at` 昇順で backfill。
  - review 系フィールドは `captures` 行にある: `batch_id` / `index_in_batch` / `task_result`（`success` | `failure`）/ `failure_reason?` / `quality`（`good` | `needs_review` | `not_usable`）/ `quality_source`（`operator` | `quick_check` | `validator`）/ `review_status`（`pending` | `adopted` | `excluded`。既定 `pending`）/ `review_revision`（CAS 用。未 review = 0）。`collection_context` も capture の immutable な収録来歴として index する。**正本は `record.json`**、DB はそのキャッシュ（[capture_store](capture_store.md) §4）。
  - FK はコード側で担保（SQLite の FK pragma に依存しない）。capture の削除は**行を消さない**（墓標）ので、v1 の CASCADE 削除に相当する処理は無い。
  - `plan_catalog`（1 行テーブル）: `id`（`=1` CHECK）/ canonical Projects → Tasks → Conditions JSON の `payload` / `updated_at` / 単調 `revision`。未設定は行なし（revision 0）。CAS 比較・更新は Store 内の同一 SQLite transaction で行う。`catalog/plan_catalog.json` sidecar も revision と canonical ID を保持する。
- **エンドポイント**:
  - `POST /api/v1/batches` — バッチ開始。body `{ project?, task?, condition?, operator?, robot?, target_episodes=30 }` → `201`（`robot` 省略時は **active robot** で補完）。`batch_id` は同秒衝突時にサフィックス再採番。 **`project` / `task` は省略可**（`null` で保存）— plan カタログが空の設置では名乗るべき project が存在せず、必須にすると client が表示用のプレースホルダ（`—`）を実ラベルとしてカタログに焼き込むしかなくなる。無いものは `null` と言う。
  - `PATCH /api/v1/batches/{id}` — body `{ robot?, project?, task?, condition?, operator?, target_episodes?, status?, ended_reason? }`。`robot` / `project` / `task` / `condition` / `operator` は収録来歴を表す provenance label で、**capture が 1 件でも関連付けられた、または `episodes_recorded > 0` の Batch では実変更・明示 `null` clear を `409 batch_labels_frozen` で拒否する**。空 Batch だけは変更と明示 `null` clear ができ、フィールド省略は維持、同値更新は成功する。途中終了（`status` / `ended_reason`）・**`target_episodes` 変更（1–500、範囲外は 422。2026-07-14）**はこの制約の対象外。**終端 status（`completed` / `ended_early`）到達時に `ended_at` を一度だけスタンプ**。不整合な遷移は緩く許容（ハード拒否しない）。不在は `404`。
  - `GET /api/v1/batches?status=&robot=&operator=` — バッチ一覧（**新しい順**）。各要素は `batch_seq`・`episode_count`（ライブ件数）・`episodes_recorded`（単調カウンタ）を持つ。**capture ごとの行は持たない** — 以前は全バッチの全 capture のコンパクトなサマリを同梱していたが、`GET /api/v1/batches/{id}` が `captures` を完全な形で返すので二重かつ劣化したコピーだった（E-27 実測: 50 バッチ × 100 capture で 817 KiB・71.5 ms・バッチ 1 件につき 1 クエリ → 12 KiB・6.0 ms・全件 1 クエリ）。リロード時のアクティブバッチ復元は当該バッチの detail を引く。**ページングは任意**（`limit` 1–500 / `offset` 0 以上。範囲外は `422`）— **既定は全件で、省略時の応答は従来と同一**（並び順も同じ）。窓は SQL の `LIMIT`/`OFFSET` で切り、全件読んでからスライスはしない。**既定 limit は置かない**のが要点で、この一覧は絞り込み無しで集計されて coverage 表示に使われるため、既定値があると「完全な数字」として見せている総計を黙って切り詰める。小さくて完全な方が、ページングされて静かに足りないより良い — 切り詰めるかどうかは呼ぶ側が明示的に選ぶ。窓を要求した呼び出し側が続きの有無を判断できるよう、応答には**フィルタ適用後の総件数** `total` が入る（`total` は**ページではなく一覧全体**の件数。省略可能フィールドなので、既存クライアントは無視してよい）。
  - `POST /api/v1/batches/lookup` — body `{batch_ids:string[]}` の page-scoped metadata lookup。trim 後に重複を除き最大 1,000 ID、未知 ID は応答から省き、既知の `Batch` 行を**入力順**で `{items}` として返す。大量の Batch 全件取得を、capture page の表示ラベル取得に使わない。
  - `GET /api/v1/batches/coverage` — **指定 scope 内の condition 別カバレッジを SQL で集計**して返す。scope は `{ project_id?, project?, task_id?, task?, robot?, operator?, created_from?, created_to? }` で、指定した軸を**すべて AND**する。文字列は trim され、空白だけの指定は広域検索にせず `422`。`task` または `task_id` のどちらかは必須なので、旧 `?task=<name>` caller はそのまま互換である。IDを指定したscopeは ID列とのANDであり、IDが `null` の legacy Batch は含めない（legacyを含めるときは name-only scope を使う）。日時は UTC RFC3339 の半開区間 `[created_from, created_to)`（不正・逆転は `422`）。応答は `{ task?, scope, rows: [{ condition_id?, condition, recorded, is_floor }] }`。`recorded` は該当バッチの `episodes_recorded`（単調カウンタ）の**和**、`is_floor` は**項に 1 つでも floor があれば true**（和は下限になる）。`condition_id` と `condition` の組で group するため、同名でも別 canonical condition は混ぜない。`condition` が `NULL` / 空文字 / **`—`** のバッチは除外する。**plan 語彙との ∪（録画ゼロの condition を 0 行として並べる）はクライアントの責務**で、サーバは**観測された集計だけ**を返す。
  - `GET /api/v1/batches/{id}` — バッチ全体 ＋ **`captures`（フル capture 配列）**。不在は `404`。
  - **保存は `PATCH /api/v1/captures/{id}/review`**（Collect の Save）。`batch_id` は Start 時関連付けを変更できず、`index_in_batch` / `task_result` / `failure_reason` / `quality` / `review_status` を保存する。**`index_in_batch` はクライアントのヒント**で、衝突時（複数端末が同番号を採番）はサーバーがロック下で再採番し**実際に保存した値を応答で返す**（クライアントは応答値を採用する）。
- **capture への同梱**: `batch_seq` は capture 行でなくバッチ側にあるため、一覧を返すときに `batch_id → batch_seq` を一括引きして付与する（Review/Datasets が 2 度目の往復なしで番号を表示できる）。一覧はバッチ一括取得で N+1 を回避。
- **SSE**: 既存 `record_status` / `resync` で足りるため**新イベントは追加しない**。
- **Phase 2.5 TBD**: UX 仕様の Session > Batch > Episode のうち **Session は今回作らない**（運用実績を見て判断）。Plan（Projects/Tasks/Conditions）の DB 化・Settings からの編集保存も Phase 2.5。

## 収録設定のフル編集（`GET/PUT /api/v1/config/recording`）

UI（Settings タブ）から `RECORDING_CONFIG` 全体を編集・永続化する。

- `GET` — ライブの収録設定（`app.state` 上の現値。直前の PUT を再起動なしで反映）と、そのファイルパスを `{ config, path }` で返す（未ロード時は `config: null`）。
- `PUT` — body `{ config }`。`config` を `RecordingConfig`（[config](config.md)）で型検証し、失敗時は **`422`**（違反フィールドを `details.errors` に返す）。成功時は **`RECORDING_CONFIG` のファイルへ YAML をアトミックに書き込み**（temp + `os.replace`。書き込み先は常に設定ファイルで、リクエスト由来のパスは使わない）、**メモリ上の設定をホットスワップ**する。
- 反映タイミング: `GET /api/v1/config` と**次回記録の `default_topics`（robot_name 等を含む）は即時**反映。recorder の QoS / monitor の expected_hz・許可リストは各サービスの**次回再起動時**に適用される（UI もその旨を表示する）。

## Stream 設定のフル編集（`GET/PUT /api/v1/config/stream`）

UI（Settings > Robots）から `STREAM_CONFIG`（`columns` + `panes[].topic`。**現行コンソールが読むのは `panes` のみ** — Collect のカメラペインの初期化元。`columns` はファイル形式として保持されるが v2 レイアウトでは未使用で、UI もそう明言する）を編集・永続化する。`/recording` と同型のミラー。

- `GET` — `{ config, path, error }`。`config: null` はファイル不在/不正で、**`error` が両者を区別する**（null=不在・保存で新規作成、メッセージ=存在するが壊れている・保存は置換 — エディタは警告してから編集させる。ディスク側で直されたファイルはここで再採用される）。`path: null` は**アクティブ機体に config dir 自体が無い**ことを意味する（stream ファイルが無いだけの機体は慣例パス `stream/default.yaml` を作成先として得る — 起動経路と select 経路で挙動が揃う）。
- `PUT` — body `{ config }`。`StreamConfig`（`columns` 1–4・`panes[].topic`、未知キー拒否）で型検証し、失敗は **`422`**（`details.errors`）。成功時は**アクティブな stream ファイル**（robot / aspect 選択で付け替わる。リクエスト由来のパスは使わない）へアトミックに書き込み、メモリ上の設定をホットスワップする。ファイル不在からの初回保存はファイルを**新規作成**する。`path: null`（config dir なし）への PUT は **`404 config_not_found`**。
- 反映タイミング: **即時**。レイアウトは `GET /api/v1/config` の `stream` ブロックとしてリクエスト毎に読まれるだけで、ROS サービスは起動時コピーを持たない（recording と違い再起動の但し書きが不要）。

## アラート規則の編集（`GET/PUT /api/v1/config/alerts`）

Settings > Data quality から、選択式カタログ（recording / stream / validation / validators）ではない**アクティブ機体の単一ファイル設定**を編集・永続化する（F2''）。カタログ経由でアクティブ機体のファイルを解決し（committed / local 両対応）、`PUT` は pydantic で検証（**未知キーは拒否**）してから `/recording` と同じ temp + `os.replace` でアトミックに書き込む。検証失敗は **`422`**（`details.errors`）でファイルは書き換えない。`GET` 応答は `{ config, raw, path }`（`raw` は on-disk の YAML 文字列＝Advanced 生 YAML エディタの初期値。未作成時は `null`）。`PUT` body は `{ config }`（フォーム）または `{ raw }`（生 YAML。frontend は YAML パーサを積まないためサーバ側で解析）で、書き込みは常に検証済みモデルの正規 YAML。（旧 `signals` アスペクト＝Review 波形チャートの既定表示は、チャート撤去に伴い 2026-07-15 にエンドポイント・`config/<robot>/signals/` ごと削除。）

- **`alerts`**（`config/<robot>/monitoring/alerts.yaml`）: topic_monitor のアラート規則（`rules[{topic, metric, op, threshold, clear_after_s, cooldown_s, severity}]` ＋ 任意の `derived_rules`）。metric は `hz|bandwidth|gap|late|loss`、op は `lt|gt|le|ge`（monitor の `AlertRule` と同一集合＝有効な alerts.yaml が往復できる）。`metric: loss` は**受理するが応答 `warnings` で警告**（`loss_rate` は monitor で常に null のため発火しない）。**反映は topic_monitor 再起動時**（alerts.yaml は起動時に 1 回だけ読み込む。ライブ再読込経路は無い＝`topic_monitor/main.py`）。`GET`/`PUT` 応答は `warnings: string[]` を追加。

## ジョブ実行（`POST /api/v1/jobs`、`dora_runner` へプロキシ）

- **ジョブのキーは `capture_id`**（§10.5）。`POST /api/v1/jobs` の body は `{ capture_id, pipeline, params? }`。`dataset_dir` param は廃止した（ソース解決は `objects/<capture_id>` 一本）。
- **capture lease をここで取る**（[capture_store](capture_store.md) §7.1）: dora_runner は意図的に lease 非認知（capture を読んで report を書くだけで、削除のことを何も知らない）なので、カタログと削除経路の両方を持つ orchestrator が代わりに取る。投入時に取得、**status / result のポーリング観測ごとに更新（renew-on-poll）**、終端を観測したら owner スコープで解放。lease が生きている間、discard / delete は `409 capture_busy` を返す。
  - shared reader lease と archive/delete の exclusive writer lease は同じ SQLite `BEGIN IMMEDIATE` で仲裁する。writer が先なら新規 job は remote create 前に `409 capture_busy`、reader が先なら archive/delete が拒否されるため、copy/rename の途中に新しい worker が source を読み始める窓を作らない。
  - **TTL が保証するのは「誰かが観測している間」だけ。** 実行中のジョブは UI が status をポーリングするので守られるが、**キュー待ちは守らない** — 誰もポーリングしないまま待たされたジョブは lease を失い、delete が勝つ。そのジョブは後で `.trash` へ移ったディレクトリに対してきれいに失敗する（遅い正常終了であって破損ではない）。docstring も含め、この保証は正確に述べること。
  - **cancel と lease**（2026-08 改修）: dora_runner の cancel は協調式になり（[dora_runner](dora_runner.md) の API 節）、`running` の job への cancel 応答は `running` + `cancel_requested: true` のまま — `canceled` は**実作業が実際に死んだとき**にだけ観測される。lease の解放は従来どおり終端状態の観測時なので、この変更により「cancel ラベルで lease が解放され、走行中ジョブの capture が `.trash` へ rename される」経路（timing sweep S1-2）は閉じた。UI の「blocked delete → cancel → retry」も、cancel した job が終端に達するのを（有界に）待ってから retry する。
  - 墓標の capture への投入は `409`（`capture_deleting` / `capture_deleted`）。
- 対象 capture が未知なら **`404`**、まだ記録中 / 停止中なら **`409`**（書き込み途中の bag を読ませない）。
- **バイトがこの設置に無い capture への投入は `409 capture_not_local`**（2026-08-11, sweep S1-5 併記）: replica 行（§8）が `present_*` 以外（転送待ち・archive 済み・missing 観測済み）を言っているときは、dora_runner の中で数分後に裸の "no capture found" で死なせず、operator が行動できる状態名（`replica_state`）を挙げて投入時に断る。判断は**カタログの replica 行**であってファイルシステムの stat ではない（`rm -rf` 直後の未検出は従来どおり遅い失敗のまま — 投入毎の stat は明瞭さと引き換えにレースを持ち込むだけ）。replica 行が**無い** capture は通す（replica 導入前の古いカタログを検証から締め出さない）。
- `GET /jobs/{id}/result` の **`artifacts` はデータルート相対に正規化**して返す: dora_runner はコンテナ絶対パス（例 `/data/report/<pipeline>/<capture_id>/plot.png`）を報告するが、orchestrator が `data_dir` 配下のものを相対化するので、各 artifact はそのまま `GET /api/v1/files/{path}` で取得できる。これが**プラグインが UI 無改修で画像（プロット等）を表示させる可視化チャネル**（[dora_plugins.md §2.5](dora_plugins.md)）。`data_dir` 外の絶対パス・元から相対のパスは無変換。

## 生成ファイルの整理（`POST /api/v1/report-storage/*`）

capture を保持する運用でも増え続ける `report/<pipeline>/<capture_id>/` を、Settings > System から分析・手動削除する。`GET /api/v1/system` の定期ポーリングへ再帰走査を混ぜず、ユーザー操作時だけ専用 API を呼ぶ。自動 GC は行わない。

- リクエストは `{ categories, older_than_days, pipeline, capture_scope }`。`categories` は `preview`（`video_check`）/ `analysis`（それ以外の非 validation pipeline）/ `validation`（`fast_validation` / `full_validation`）、`older_than_days: 0` は全期間、`pipeline` は `null` または単一 pipeline id、`capture_scope` は `source_available` / `orphaned` / `all`。**パスは一切受け取らない**。サーバが設定済み `data_dir` 以下を走査し、削除単位も `report/<pipeline>/<capture_id>/` に固定する。symlink は走査・削除対象外。
- `preview` は report 全体量、選択容量・ファイル数・report set 数・capture 数、pipeline 別内訳、gating validation を消して `unknown` に戻る capture 数、orphan / source 不在数、実行中のため保護した数、走査エラー数を返す。条件変更後は再 preview しない限り UI の削除ボタンを有効にしない。
- `cleanup` は同じ条件を**実行直前に再走査**して削除し、実削除容量・件数、保護数、失敗した `(pipeline, capture_id, message)`、残量を返す。部分失敗を成功に見せない。
- live lease のある capture は preview / cleanup とも対象外。cleanup は削除単位ごとに capture の排他 Writer Lease を取得し、通常 job の開始前 Lease と永続 Validation Run の監督 Leaseを同じ DB transaction で仲裁する。これにより、preview 後に job が始まる競合でも、job または cleanup のどちらか一方だけが先へ進む。ファイル走査・削除自体は thread pool で行い API event loop を塞がない。
- `source_available` は元 capture がこの端末にあり再生成できるもの、`orphaned` は現行 capture が無い（墓標を含む）もの。capture 行はあるが元バイトが端末に無い report は `all` でのみ選択でき、UI が再生成不能の可能性を警告する。
- validation report は単なる cache ではない。gating pipeline の `summary.json` を消すと verdict は `unknown` へ戻るため、UI の既定対象から外し、影響件数の表示と追加確認を必須にする。capture 本体・ledger・dataset membership は変更しない。
- 完了 job の履歴は揮発データとして残すが、`GET /jobs/{id}/result` は cleanup 済みで存在しない `report/` artifact を一覧から除外し、成功済み job に 404 リンクを残さない。
- `RETENTION_DAYS` は capture 本体の削除候補を示す既存ポリシーであり、この API の生成物条件には流用しない。
- `fast_validation`: `params.template` の **id（カタログのファイル stem。例 `airoa_hsr`）を Config カタログでフル template に解決**してから `dora_runner` へ転送する（dora_runner の template ストアは空起動のため、bare id は 404 になる）。id が空 / 不在なら現在の選択（active）にフォールバック。既に dict（フル template）ならそのまま通す。
- dora_runner への `POST /jobs` は任意の `idempotency_key` を受ける。同じ key と同じ `capture_id` / pipeline / params は同じ job を返し、異なる payload は `409 idempotency_conflict`。status の `execution_active` は worker が実際に bytes へ触れ得るかを示す加算フィールドで、`false` が明示されるまで（旧 runner の欠落 `null` を含む）終端ラベルだけで lease を解放しない。

## Durable Validation Run

- Run は capture DB とは別の `validation_runs.db` に永続するサーバ所有の outbox であり、ブラウザ reload・orchestrator restart・capture DB rebuild をまたいで復元する。`state` は `creating` / `running` / `cancel_requested` / `finished`、各 child は submission と remote job の状態・結果・試行履歴を持つ。過去試行は履歴で、run の完了・retry 判定は capture ごとの最新試行だけから導く。
- create body は `{ pipeline, params?, request_id, capture_ids? | selection_id? }`。`request_id` は**必須 UUID**で、同じ intent の response-loss retry は同じ Run を返す。異なる payload は `409 validation_run_idempotency_conflict`。`capture_ids`（1–1000）と `selection_id` は排他的である。selection は `POST /api/v1/capture-selections` の順序付きスナップショットを server-side で展開する。空の selection は child の無い未完了 Run を作らず `409 no_validation_targets`。現行 Run 応答は child のページングを持たないため、解決結果が **1000 件超**なら新規 Run を `409 validation_run_too_large`（`matched_count` / `max:1000`）で拒否し、UI は filter を絞るよう案内する。新規 selection が欠落・期限切れなら `409 capture_selection_expired`、ただし既存 `request_id` の retry は期限後も保存済み Run を返す。応答 Run は `selection_id?` と materialized child IDs を含む。
- intent の commit 後、`202` 応答の**前**に network を待たず local capture lease を deadline まで確保するので、最初の supervisor tick 前の discard/delete も `409 capture_busy` になる。送信 preflight に失敗した child は同じ provisional lease を解放して `submission_failed` を保存する。remote create は child `submission_key` を dora idempotency key として使い、初回送信前に解決済み pipeline / params を child へ固定する。応答喪失後も byte-equivalent な payload を再送し、active template の変更で別 job に化けない。create 応答後は job ID を status poll より先に永続化する。
- supervisor は起動時に deadline 内の local lease だけを再取得し、network reconcile は background で bounded concurrency に行う。HTTP 4xx のみを確定 submission failure とし、transport / 5xx は結果不明として同じ idempotency key で再照合する。確認済み live status は deadline/lease を延長し、`execution_active: true` は terminal label より優先して lease を保持する。runner 到達不能・create 応答不明が positive activity evidence のないまま deadline を越えれば `runner_unreachable` / `submission_unknown_timeout` を保存して lease を解放するため、runner 障害が capture を永久に lock しない。terminal でも `execution_active: null` は bounded safety window を使い、明示 `false` のときだけ即時解放する。
- terminal status 後の result 取得失敗は Run を完了扱いにせず再取得し、有界期限後だけ `result_unavailable_timeout` として確定する。この failure も `retry-failed` の対象になる。cancel は durable intent に記録して supervisor が retry する協調要求で、child の実作業停止までは完了を偽装しない。finished Run への cancel は finished のまま冪等成功する。`retry-failed` は finished Run の失敗・cancel・result unavailable な最新 child にだけ新 attempt を追加し、最新 success または実行中 child を重複投入しない。

## データセット（論理）

**物理 move と実体コピーは全廃した。** dataset は **DB 行 + ledger イベント**だけで、収録の実体は `objects/<capture_id>` から一歩も動かない。これで「移動の途中で電源が落ちた」という状態が構造的に消え、1 つの capture を複数の dataset に入れることも、dataset から外して録画一覧に戻すことも、バイトを触らずにできる。

- `POST /api/v1/datasets` — body `{ name, operator?, task? }` → `201`。`dataset_id` は UUIDv7。ledger に `dataset_created`。
- `PATCH /api/v1/datasets/{dataset_id}` — body `{ name?, operator?, task? }` → `200`。**ラベル編集**（review 保存と同じ patch 意味論: 省略 = 維持、明示 null = クリア。name はクリア不可 `400 invalid_name`）。ledger に `dataset_updated`（変更後の完全なラベル集合）、views/ は追随して再生成。非 active は `409 dataset_not_active`。無変更の PATCH は ledger に何も書かない。
- `GET /api/v1/datasets` — 一覧（`member_count` 込み）。`GET /api/v1/datasets/{dataset_id}` — members（`membership_id` / `capture_id` / `display_index`）込み。
- `POST /api/v1/datasets/{dataset_id}/members` — body `{ capture_id }` → `201`。`display_index` はサーバが採番し、**欠番を別の recording に再利用しない**（high-water mark は ledger から復元できる）。ただし**同じ capture の再追加は、ledger からかつての自分の番号を取り戻す**（誤 remove の登録し直しが新テイクに見えないため）。ledger に `dataset_member_added`。**ledger が読めないときは `503 ledger_unreadable`** — かつての番号は ledger にしか無く、空の履歴として扱うと退役番号を別の recording に配ってしまうので、推測せず拒否する（ledger 系 503 の一員。archive ランナーが同じ理由で停止したときも、進捗の `error.code` は同じ `ledger_unreadable`）。
- `POST /api/v1/datasets/{dataset_id}/selection-recipes` — filtered Bulk Add の完了 run を append して `201`。body は `kind: filtered_bulk`、`join`、閉じた field 集合の `conditions`、`matched` / `attempted` / `succeeded` / `failed`、`catalog_truncated`。server が `recipe_id` / `recorded_at` を付与し、`attempted = succeeded + failed` を検証する。active だけが書ける（非 active は `409 dataset_not_active`）。`selection_recipes` は Dataset 応答に配列で含め、`dataset_selection_recorded` ledger event は dataset labels と recipe を併記するため lost-head replay でも復元できる。旧 ledger/DB は空配列として互換。
- `POST /api/v1/datasets/{dataset_id}/membership-bulk-runs` — body `{selection_id,request_id}` で materialized capture selection を durable background membership run として開始し `202`。`request_id` は dataset 内で冪等であり、同じ ID を別 selection に再利用すると `409 idempotency_conflict`。`GET /api/v1/datasets/{dataset_id}/membership-bulk-runs/{run_id}` は `pending` / `running` / `completed` / `partial` / `failed_receipt` と `matched_count` / `attempted` / `succeeded` / `failed` / `pending` / item failures を返し、途中件数も item rows から集計する。`POST .../{run_id}/retry` は成功済みを再追加せず failed（または receipt 失敗）だけを非同期再キューして `202`、実行中は `409 bulk_run_not_retryable`。member 追加は dataset が active であることを insert と同じ transaction 境界で再確認し、archive の member snapshot 変更と競合すれば late member を入れない。正常再起動後は pending/running の durable run を再開する（schema rebuild は run の復元を約束せず、membership ledger が正本）。停止開始時は worker が item 境界で協調停止して durable claim を `pending` に戻し、成功済み item はそのままなので次回 resume/retry で再追加しない。各 pass の完了時に `bulk_run_id` / `attempt` / `cumulative: true` と**完全な `selection_query`**（states/review/date/replica/dataset 除外を含む）付き recipe を一度だけ ledger-first で記録する。membership または recipe の DB commit 後・ledger append 前に crash した場合も、起動時に既存行から欠けた ledger event を補完してから成功 receipt を確定する。receipt append が失敗しても成功 membership は rollback せず `failed_receipt` として正直に残り retry できる。archive がこの window に入っても内部 receipt 修復は許可される。terminal receipt 記録後は completed run の item rows を compact し、期限切れ selection items も後続 cleanup で削除する。views refresh は run ごとに集約する。
  - **現行の性能上限（SLA ではない）**: member 追加の ledger event は replay 互換のため現状 1 成功につき 1 行である。隔離 SQLite 計測では 1,000 件 3.771 秒、10,000 件 43.486 秒（約 4.35 ms/member、100,000 件は線形外挿で約 7.25 分）。したがって UI は同期完了を装わず上記 status を poll する。chunk ledger 形式への変更は将来の性能作業であり、この契約では約束しない。
- `DELETE /api/v1/datasets/{dataset_id}/members/{membership_id}` → `204`。ledger に `dataset_member_removed`。
- `DELETE /api/v1/datasets/{dataset_id}` → `204`。ledger に `dataset_deleted`。**capture のバイトには触れない。**
- **安定 ID は `dataset_id` / `membership_id`**（名前は編集可能、`display_index` は表示用）。UI の URL 状態もこの 2 つで持つ。
- **member の capture は delete も archive も拒否する**（`400`）。`views/` の symlink が宙に浮くため、先に member から外す。
- **終端遷移**は上記「dataset archive」（§6.1）: 通常は `datasets.status` が `active → archiving → archived` を歩き、非 active の dataset は member 集合が凍結される。完了 member 0 件の halted attempt を ledger に記録して cancel する場合だけ `archiving → active`、`archived` は終端。
- **`views/` の再生成**（`POST /api/v1/views/refresh`）: `views/<operator>/<task>/<dataset_name>/<NNN> -> objects/<capture_id>` の symlink 木を、**コミット済みかつ `status='active'` な dataset の `dataset_members` 行のみ**から作り直す（archiving/archived は宣言として木から消える — §6.1）。世代ディレクトリ + `os.replace` による symlink 差し替えで原子的に行うので、**`views` が存在しない瞬間も、半分だけ出来た木を読む瞬間も無い**。所有者は orchestrator 1 つ（dora_runner は依頼するだけ）。木は全消し・再生成が可能な派生物で、正本は DB 行と ledger。

## SSE イベント契約（`GET /api/v1/events`）

- 形式: `id:`（単調増加の整数）/ `event:`（種別）/ `data:`（JSON）。
- 種別と payload:
  - `record_status`: `{ capture_id, run_id, state, message_count, bytes, started_at }`（`started_at` は additive — start 遷移を見逃したページも進行中録画の経過を描ける）。**受信側は同一 capture 内の巻き戻しを破棄すること**: 1 つの capture の状態は `created → armed → recording → stopping → 終端` としか進まないので、遅れて届いた低位イベントは新情報ではなく古い情報である。`recording` への巻き戻しはコンソールに「この画面が駆動していない録画が走っている」と誤認させ、停止済みのテイクの上に takeover カードを出す。`capture_id` が異なる場合は巻き戻しではない（前の capture の終端直後に新しい capture が `recording` になるのは正常）。
  - `metrics`: `topic_monitor` の周期 snapshot（[topic_monitor](topic_monitor.md) の出力スキーマ）
  - `alert`: `{ topic, metric, level, value, threshold }`
  - `job`: `{ job_id, capture_id, pipeline, state, progress }`
- 再接続: クライアントは `Last-Event-ID` を送る。サーバは直近イベントをリングバッファ（既定 1000 件 / 5 分）に保持し未送分を再送。**保証できない位置なら `event: resync`** を送り、クライアントは全体を再取得する。保証できない位置は 3 通り（2026-08-12 に後ろ 2 つを追補 — 従来は空リングに黙って空 replay を返し、**orchestrator 再起動を跨いだブラウザが resync を受け取れず全キャッシュが古いまま**になっていた）: ①リング最古より古い（バッファから溢れた）、②**このプロセスが発行した最大 ID より先**（同一プロセスではあり得ない＝再起動の痕跡。ID は 1 から振り直される）、③空リングに対して発行済み最大 ID より手前（取り逃したイベントが age で消えた）。唯一保証できる空リング位置＝発行済み最大 ID と一致（完全 caught-up・静穏で age-out しただけ）は resync せず空 replay。**ID の採番は起動時刻ミリ秒を起点**とする（int のまま再起動を跨いで単調 — 旧 boot の ID が新 boot のカウンタに追い越されて「別プロセスのイベントを通常 replay として受け取る」世代衝突を構造的に排除する）。また**遅い購読者のキュー溢れ**（最古 drop）は無言にせず、そのキューの次配信の前に `resync` を注入する。

## 主要スキーマ（抜粋、OpenAPI 生成対象 / pydantic）

- settings（`GET/POST /api/v1/settings`。**未実装・将来枠**）: `{ defaults: { encoding: "vp8"|"h264", expected_hz: { <pattern>: number } }, alerts: [ { topic, metric, op, threshold, cooldown_s, clear_after_s } ], retention_days: int, max_record_bytes: int }`。当初設計では `RECORDING_CONFIG` を実行時に上書き / 補完し次の記録セッションから反映する想定だったが、現状は `PUT /api/v1/config/recording`（下記・アトミック書込＋ホットスワップ）で代替している。
- 検証テンプレート:
  - `GET /api/v1/validation/templates` → `{ items: [ { name, version, required_topics: [ { name, type?: string } ] } ], next_cursor }`
  - `POST /api/v1/validation/templates` body = `{ name, version, required_topics: [ { name, type? } ] }` → `201` 同形
  - `POST /api/v1/validation/templates/generate` body = `{ capture_id }` → `{ name, version, required_topics: [ ... ] }`（雛形）
- ワンクリック検証プリセット:
  - `GET /api/v1/validation/presets` → `{ items: [ { id, name, description, pipeline, params, total, pending, pending_capture_ids: [ capture_id ] } ] }`。静的フィールド（`id` / `name` / `description` / `pipeline` / `params`）は機体の `validation_presets.yaml`（[config](config.md)）由来。動的フィールドはリクエスト毎に算出＝終端状態の capture のうち **その pipeline の `report/<pipeline>/<capture_id>/summary.json` がまだ無い**もの（`pending_capture_ids`）。UI はこれを 1 クリックで一括実行する（`POST /api/v1/jobs` を capture ごと）。読み取り専用（状態は変えない）。
- capture（`GET /api/v1/captures/{id}` = CaptureDetail）: `{ capture_id, run_id?, source_instance_id?, state, started_at?, ended_at?, operator?, task?, robot?, collection_context?, topics: [ { name, type, qos } ], compression, split?, error?: { code, message }|null, message_count?, bytes?, quick_check?: object|null, task_result?, failure_reason?, quality?, quality_source?, review_status, review_revision, batch_id?, index_in_batch?, deleted_at?, delete_kind?, delete_reason?, archived_at?, archive_destination?, lease_owner?, lease_expires_at?, replica?: Replica|null, digest_state, memberships: [ { membership_id, dataset_id, dataset_name?, display_index } ], manifest?, record?, validation?, loss? }`。`collection_context` は Start 時に manifest へ固定した収録来歴で、一覧・detail とも同じ値を露出する。
  - `replica`: `{ instance_id, state, path?, manifest_digest?, verified_at?, updated_at? }`。`state` の語彙は [capture_store](capture_store.md) §8.1。**`null` は「このマシンにまだコピーが無い」**（split 構成の正常な状態）であって、エラーではない。
  - `digest_state`（`pending` | `complete`）は列ではなくローカル replica 行からの導出値（`present_verified` ⇔ `complete`）。
  - 末尾 4 つはディスク上サイドカー / レポート由来で、不在なら `null`。
- batch（`GET /api/v1/batches` の要素 = BatchSummary）: `{ batch_id, robot?, project_id?, task_id?, condition_id?, project, task, condition?, operator?, target_episodes, status, ended_reason?, created_at, ended_at?, episodes_recorded, episodes_recorded_is_floor, batch_seq?, episode_count }`。`GET /api/v1/batches/{id}`（BatchDetail）は `captures` がフル capture 配列。一覧の包み（BatchListResponse）は `{ items, total? }` — `total` は**フィルタ適用後の総件数**で、ページではなく一覧全体を数える。
- batch coverage（`GET /api/v1/batches/coverage`）: `{ task?, scope, rows: [{ condition_id?, condition, recorded, is_floor }] }`。`condition` は文字列（未設定バッチは行にならない）、`recorded` は整数、`is_floor` は真偽。**観測された condition だけが並ぶ**ので、行が 0 件でも scope の task はまだ 1 本も録っていないという正しい答え。
- capture 一覧の要素（`GET /api/v1/captures` = CaptureListItem）: 上の CaptureDetail から **`topics` を除き、`topics_count`（整数、`len(topics)` と常に一致）を加えた形**。サイドカー由来の 4 つ（`manifest` / `record` / `validation` / `loss`）と `verdict` も持たない（それらは detail 専用）。包みは `{ items, next_cursor? }`。`topics` を含む単一 capture 応答（detail・review 保存・record start/stop）は従来どおり **`topics` フル + `topics_count`** を返す。
- review 保存（`PATCH /api/v1/captures/{id}/review`）: body `{ base_revision, task_result?, failure_reason?, quality?, quality_source?, review_status?, batch_id?, index_in_batch? }` → 更新後の Capture。
- store health（`GET /api/v1/store/health` = StoreHealth）: 上記「ストア健全性と SUSPECT」参照。
- job（`GET /api/v1/jobs/{id}/status`）: `{ job_id, capture_id, pipeline, state, progress, logs_tail }`（[dora_runner](dora_runner.md)）。

## フレームワーク / 永続

- **FastAPI + uvicorn**（推奨。OpenAPI を自動公開）。
- 重い処理（検証・変換、stage3）は**非同期ジョブキュー**に載せ、request/response から切り離す。進捗は SSE 通知。
- 永続: **capture の正はディスク上のサイドカー**（`object_manifest.json` / `record.json` / `lifecycle.jsonl`）で、**SQLite はそこから全再構築できる索引**。起動時に DB が無い・スキーマ版が違う・`KAIROS_REBUILD` が立っていれば rebuild する（[capture_store](capture_store.md) §8.2）。`jobs` は揮発として rebuild 対象外、`validation_templates` / `plan_catalog` は `catalog/*.json` へサイドカー二重化して復元する。settings ストアは未実装（収録設定は `PUT /api/v1/config/recording` で設定ファイルへアトミックに永続化する）。
- **起動シーケンス**: identity（`instance.json`。壊れていれば起動失敗 — 新しい id は全 replica を孤児にする）→ 不変条件（`objects`/`.trash`/`.incoming` の同一 FS 検査、`.ledger-slack` の確保）→ 必要なら rebuild（**ledger が読めなければ起動を中止**。ledger は manifest に優先するので、それ無しに rebuild すると operator が破棄した capture を全部復活させる）→ **delete-resume（rebuild の有無にかかわらず毎回）**。
- 内部サービス呼び出しは timeout（既定 `3s`）+ retry 1 回。失敗は `status` / `events` に反映（`503`）。**例外は recorder への `POST /record/stop`**: retry 無し・長い予算（`75s`）。recorder の停止は SIGINT 30s → SIGTERM 30s → SIGKILL 5s とエスカレーションし、チェーンを最後まで歩いた停止（約 65 秒）も**成功した停止**（interrupted で確定）なので、それを 503 に切らず待ち切る。**`POST /record/start` / `/record/prepare` も例外**（retry 無し）: 予算は固定 25 秒ではなく**ライブ config から導出**する（2026-08-11, sweep S2-3）— 床 18 秒（spawn＋出力 dir 待ち＋resume 往復＋rclpy 初期化の余裕）＋ `start_delay_s` ＋ `subscription_ready_timeout_s` ＋ `post_discovery_delay_s`、下限 25 秒。固定 25 秒は既定 config に対して余裕 0.5 秒しかなく、文書化された設定（カメラ暖機の `start_delay_s: 10`）で**全 cold start が 503**＋起動中の録画に failed 行、という壊れ方をしていた。

## エラー / 規約 / ネットワーク

- API 共通規約（ステータスコード `400`/`404`/`409`/`422`/`503`/`507`、エラー形式、ページング、enum、型・時刻）は [config](config.md) に従う。
- bind は `BIND_HOST`（既定 `0.0.0.0`、**LAN 公開を許容**。信頼された LAN 前提・認証なし）。CORS は `CORS_ORIGINS`（LAN 公開時は該当ホストの origin を追加）。

## 設計ポイント

- **backend-driven**: pipeline 定義・フォーム schema・実行時設定を orchestrator が提供する（frontend はハードコードしない。タブ構成のみ Console v2 で frontend 固定に変更）。
- 映像（WebRTC）は frontend が `webrtc_streamer` に直接接続。それ以外は orchestrator が集約する。
- 共有設定は [config](config.md)。
