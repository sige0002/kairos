# frontend 仕様

> ステータス: 設計確定（**v2 = Console v2**、2026-07-13 マージ）。v1（機能タブ構成）から**役割タブ構成**へ全面再編した。日本語が正本（これを正とする）。英語版 `docs/specs/en/frontend.md` は手動更新ミラー（日本語の変更に追随させる）。**認証は不要。**

backend-driven な軽量 Web UI（Vite + React + TypeScript）。タブは技術機能単位（v1: Live / Graph / Probe / Recordings / Validation / Datasets / Config）ではなく、**「誰の・どの仕事か」**単位の 6 タブ: **Collect / Review / Datasets / Validation / Monitor / Settings**。

## 役割

| タブ | 誰の仕事 | 内容 |
|---|---|---|
| Collect | オペレーター | 収録の実行・即時判断・改善 |
| Review | ML エンジニア | 収録品質とラベルの判断、データセットへの搬出 |
| Datasets | ML エンジニア | エクスポート済みデータセットのカタログ・（将来）構築 |
| Validation | ロボットエンジニア | pipeline 実行・検証の標準化 |
| Monitor | ロボットエンジニア | 通信・信号・システム診断 |
| Settings | ロボットエンジニア | 機体設定・計画（Plans）と影響範囲 |

中核概念: **収録品質（quality）とタスク結果（task result）は別軸**（タスク失敗 ≠ 低品質。失敗データもラベル付きで学習に使う）。収録は **Batch > Episode** 階層で進行し、orchestrator に永続化される（[api_orchestrator.md](api_orchestrator.md) 「Batch / Episode」。Session 階層は **TBD**: Phase 2.5）。

## 実装

- ベース: **Vite + React + TypeScript**。
- 状態管理: **Zustand**（UI 状態）+ **TanStack Query**（サーバ状態。SSE イベントをキャッシュに反映）。ルーティングは URL クエリ（`?tab=<id>`）ベース。
- チャート: **uPlot** に統一（軸目盛り・crosshair・重畳・ズーム）。UI: **Tailwind CSS**（コンポーネントは自前）。
- ライブ映像: **WebRTC**（`webrtc_streamer` の `/stream/offer` に接続）。
- テスト: **Vitest + Testing Library**。

## 入力

- WebRTC 映像（`webrtc_streamer`。既定は同一オリジン `/webrtc` 経由で frontend の nginx がリバースプロキシ。`WEBRTC_PUBLIC_URL` で上書き可）
- 数値フィールドのサンプルストリーム（`topic_probe`。同一オリジン `/probe` 経由。Monitor の Signals ビューが使う）
- REST / SSE（`api_orchestrator` `/api/v1`）

## タブとナビゲーション

- **タブは frontend 固定の 6 枚**（`V2_TABS`）。v1 の「backend の `tabs` レジストリ駆動」は**廃止** — `GET /api/v1/config` の `tabs` フィールドは互換のため残るが、v2 は表示・順序に使わない。
- **旧タブ id は全てリダイレクト**して deep link を保つ: `live`→`collect`、`graph`/`probe`→`monitor`、`runs`→`review`、`dataset`→`datasets`、`config`→`settings`。
- 各タブは URL でアドレス可能（`?tab=<id>`）。**`?tab=<id>&solo=1` はそのタブだけをタブバー無しで描画**する（タブ毎の ↗ ボタンで別ウィンドウに開ける。複数チャートを並べたい時のマルチウィンドウ手段）。
- **ヘッダ（全タブ共通）**: 6 タブ・**ROS_DOMAIN_ID バッジ**・**接続チップ**（SSE の接続状態）・**OP チップ** = クリックで operator 名を設定（localStorage 永続。以後の全録画で `/record/start` の `operator` として送信）。

## 画面構成

### Collect — 収録の実行と即時判断

- **コンテキストバー**: Robot（実選択・Settings と同じ機体カタログ）／Project・Task・Condition（Plans 由来のピッカー＋Custom 自由入力）／**Batch 番号**／Episode 進行「n / target」。
  - **Plans カタログ（Projects → Tasks → Conditions）はサーバ同期**（2026-07-14）: `GET/PUT /api/v1/plans` と once-per-load で照合する — サーバ未設定ならこのブラウザのカタログを**シード**、未同期のローカル編集（dirty フラグ、リロードを生き残る）があればそれを push、それ以外はサーバ側を採用。オフライン時はブラウザローカルのカタログがそのまま立ち、編集は次回編集/ロードで再 push される。condition を選択式に保つことでラベル語彙が端末間で割れない（バッチラベル裁定）。
  - Batch 番号は**サーバ発番の `batch_seq`**（機体×ローカル日付ごとに毎朝 1 から）。バッチ未作成の間は「next #N · assigned on first recording」の**予測表示**（本日の最大 seq + 1）とし、初回録画でサーバ値に確定する。「計画バッチ数」の分母は置かない（実体がないため）。
- **Batch / Episode 進行はサーバ永続**: バッチは初回録画時に遅延作成（`POST /api/v1/batches`）。空バッチは行を持たず番号を消費しない。リロード・タブ切替は `GET /api/v1/batches?status=active` で復元。
- **Batch menu** の作用（End early / Reset は**録画を消さない**）:
  - Pause / Resume（現状ローカルのみ。サーバ化は **TBD**: Phase 2.5）／End batch early（`status=ended_early`＋理由）／Reset（空バッチなら**完全 no-op**、録画ありなら現バッチを閉じて次の録画から新番号）／Change condition（PATCH）／Report issue。
- **録画操作**: Start / Stop。arming ゲート（subscription 確立待ち。「N matched · N missing」ノート）、failed-start バナー（**平易文言先行・生コードは従行** — `already_recording` 等はオペレーター語に写像）、**recorder cache/drop 検出バナー**（`dropped_messages`＋cache 設定のヒント、当該 run にゲート）。**キーボード**: `R`=Start / `S`・`Space`=Stop / `Esc`=arming Cancel / `?`=ショートカット一覧（入力欄フォーカス中は無効・ボタンラベルに `· R` 等のヒント）。フェーズ遷移毎にフォーカスは次の主操作へ移る（body に落ちない）。
- **録画状態はサーバが真実**（`GET /record/status` の 5s ポーリング。HCD 修正 2026-07-14）: このブラウザが開始していない/見失った録画が走っていれば **RECORDING IN PROGRESS カード**（run / 経過 / サイズ / operator / topics、確認モーダル付き `Stop & save`、`Open in Monitor →`）が READY の代わりに出る。SYSTEM STATUS の Recorder 行も同一クエリ由来 = 「READY なのに 409」の矛盾は構造的に発生しない。停止で回収されたテイクは下記「未保存テイク回収」に現れる。録画トピックの解決は v1 と同じ（selected / configured / all。選択は Monitor の Rec 列と連動し、「REC N topics」チップから Monitor へ飛べる。空選択では Start 無効）。
- **エピソードの保存**: Stop → 実イベントゲート（stop API 解決 → integrity 読取。固定タイマー廃止・stop 失敗は SAVING に留まり `Retry stop`）→ 結果パネル。**Success は既定選択**で、クリーンな成功は `Save — success` 1 操作（Enter 可）。Failure は ✕ から理由必須の分岐。**Quality は実 integrity から自動導出**（clean→`Good · auto`、drop/failed→`Needs review · auto`＋実 drop 件数）で、`change` から 3 択（good / needs_review / not_usable）で任意上書き — **上書き時のみ `quality_source='operator'`、非上書きは `'quick_check'`**（来歴を偽らない）。保存は `POST /api/v1/episodes` で、**サーバ 201 確定後にレシート** `Saved — Episode n of Batch m · {operator}`（strip チップに一時リング）。Discard は確認モーダル付きの**実削除**（`DELETE /api/v1/runs/{id}`）。
- **未保存テイク回収**: Stop〜Save 間で離脱しても、リロード時に「Unsaved take from {time} — {N} MB, {duration}」の amber バナー（`Label it` / `Discard` / `Later`）で回収できる（completed かつ episode 無しの直近 run を検出）。
- 件数「n / target」は**単調カウンタ `episodes_recorded`**（撮った数が正。Review 側の削除で減らない。品質内訳と乖離した場合は脚注で明示）。
- **エピソード strip はチップを真のエピソード番号（`index_in_batch`）に置く**（2026-07-14 修正）: 配列位置で描くと Review の export/削除で後続チップが左に詰まり、直近エピソードが「not recorded」に見える 1 ずれが出る。録画済み番号のうち現存しない番号は破線チップ+「recorded earlier; no longer listed (exported or deleted in Review)」で正直に区別する。サーバが `index_in_batch` を振り直した保存（端末間衝突）は応答値をローカルチップにも採用。**サーバ復元は同一バッチに限りマージ**: サーバが知らないローカル保存（bridge のみ・POST 未達）を落とさない（落とすと保存直後のチップが not recorded に戻る）。別バッチへの復元ではローカルの件数を持ち込まない。
- **カメラ**: WebRTC プレビュー。ペイン追加/削除（上限 4）。メインは解像度プリセット選択、サブは低解像度（240/360p）に強制 cap。**遅延 / fps はプレビュー映像内・右上のオーバーレイチップ**（タイル毎の実測値・閾値色。映像外へは置かない）。接続前のプレースホルダには状態の理由を明記（空欄を故障に見せない）。
- **Quick check**（停止直後の品質サマリ）は表示枠のみで**実判定は TBD（Phase 3）**。確定済みの設計: 「収録中に貯めた監視統計の清算」2 層 — Layer 0 = monitor / recorder が収録中に持つ統計（件数・drop・gap・expected_hz 比。stop 時点で確定）、Layer 1 = MCAP の summary section のみ読む（O(index)）。**≤5 秒・split 構成でも転送ゼロ**で成立させる。
- **Advice** は固定 1 件のモック（hold still ~1s）。**生成ロジックは TBD（Phase 3）**。方針のみ確定: Live advice は orchestrator SSE の集約メトリクスを入力、Deep advice は転送後の MCAP（dora は DDS に触らない）。
- 1920×1080 から 1366×768 まで**ノースクロール**で収まる（コンパクト密度切替）。

### Review — 品質とラベルの判断、エクスポート

- 完了収録の一覧＋詳細。各行は run と episode の JOIN（`GET /api/v1/runs`）で **Batch「MM/DD · #N」/ Task result / Quality / レーン**のチップを表示。operator 等でフィルタ可能。**一覧はカーソルを最後まで追従**（200件で黙って切れない）し、ヘッダに実データ集計チップ（`n ready · n needs check · n excluded` / `n success · n failure`）。表示番号は**永続 `index_in_batch`**（削除で振り直らない）。判断ボタン（Mark OK / Exclude / Export CTA）は**スクロール外の固定バー**。
- **例外レビューモデル**: quality が good（または operator 確認済み）の episode は **READY**（追加クリック不要）。**NEEDS CHECK**（quality 非 good かつ未判断）だけが作業キューで、「Mark OK — include」か Exclude で解消する。既定の並びは NEEDS CHECK → READY → EXCLUDED。判断は `PATCH /api/v1/episodes/{id}`（`review_status`）。
- **Export は本タブが唯一の入口**（一機能一箇所）: 「**Export ready (n)…**」が READY の完了収録を一括エクスポート（**移動**。[api_orchestrator.md](api_orchestrator.md) データセットエクスポート）。「Include task-failed (labeled)」トグルは既定 ON（失敗データを一律除外しない）。**パイプライン strip**（Recorded → Reviewed → Ready → Export → In dataset）が現在地と次アクションを示し、READY 到達直後はインラインの Export CTA を出す。
- **削除は 2 段階**: Exclude =「Excluded — kept on disk」（非破壊・ラベルのみ）→ 除外済みの項目だけに「Delete from disk…」（run_id・サイズ・不可逆を確認。一括「Delete excluded (n)…」は逐次実行し失敗を正直に報告）。EXCLUDED や確定済みの例外からは「↩ Return to review」で pending に戻せる（可逆）。
- **詳細 inspection**: manifest / validation / loss_report テーブル / オンデマンド mp4「Video check」プレイヤー / 各 JSON ブロック。`fast_validation` の実行も詳細から可能。
- split 構成向けの **MCAP 転送列・「録画 PC へ転送」ボタン**は実装済みだが**フラグで無効**（既定 off。単一 PC 構成では表示しない）。**TBD**: orchestrator が remote recorder 参照から split を自己申告する信号と、転送ジョブ（recorder の読み取り専用配信 `GET /runs`・`GET /runs/{id}/files/{name}`＋orchestrator の pull / checksum / DB 登録 / SSE 進捗）の実装。転送は**手動 pull のみ**（自動スケジューラは作らない）・**転送と検証は別ボタン**（auto-chain しない）が確定済み。

### Datasets — エクスポート済みデータセットのカタログ

- **カタログ専用**。export 操作は置かない（「Recordings are reviewed and exported in Review → Go to Review」の誘導のみ）。v1 の無判断一括ダンプ（Export all）は**意図的に廃止**し、Review 経由に一本化した。
- 一覧: `GET /api/v1/datasets` の operator › task › NNN ツリー。各カードに **episode ラベルチップ**（`episode.json` 由来: batch / task result / quality / review status）＋ **condition の 1 行**（カタログ行の `condition`。tooltip にグローバル一意の `batch_id`。無ければ非表示 — 値をでっち上げない）。**ラベルの無い旧 export は「legacy (pre-label)」として淡色表示**する。**一覧は左カラム内で独立スクロール**（グリッド行を `minmax(0,1fr)` で viewport に固定・ヘッダはピン留め。件数が増えても過去のデータセットに必ず到達できる）。
- 詳細 = DatasetDetail（メタデータ / トピック一覧 / loss report / mp4 Video check / dataset.json・episode.json 等の JSON）。Sidecars セクションには **episode.json ブロックも並ぶ**（エクスポートを生き残ったラベル+バッチコンテキストをその場で閲覧。2026-07-14 ユーザー要望）。loss / video のジョブは `params.dataset_dir` でエクスポート先の MCAP を読む。
- **Delete**（確認モーダル・Recordings の削除と同 UX）で `DELETE /api/v1/datasets/{op}/{task}/{index}`。
- **Build**（LeRobot v3 等への変換）と **Recipe 型データセット構築は未実装（TBD: Phase 3）** — UI は淡色の枠のみで、動くコントロールに見せない。

### Validation — pipeline 実行・標準化

v1 の機能をそのまま維持し、レイアウトのみ v2 化。

- **pipeline 非依存**: pipeline 選択（`GET /api/v1/pipelines` の enabled 全件）→ **対象選択（grouped）**: `Runs (before export)`（主経路）＋ `Datasets (exported)`（エクスポート済みの再検証。`params.dataset_dir` で実行。dataset 対応 pipeline のみ enable、非対応は「applies to runs」注記で disable。空状態はグループ毎に正直表示）→ **パラメータフォーム**（`schemas.pipeline_forms[<id>]` から自動生成）→ 実行（`POST /api/v1/jobs`）。結果は**汎用レンダラ**が `summary.json` を shape 非依存で描く（PASS/FAIL バッジ・message・metrics の key-value ツリー・artifacts・raw JSON）。**プラグイン追加時に本タブへ手を入れる必要はない**（[dora_plugins.md §2.5](dora_plugins.md)）。
- 同梱 `fast_validation` のみ template の必須トピック一覧に対する専用チェックリストを持つ。結果は CSV でダウンロード可能。
- **一括実行**: 「All completed runs」で選択 pipeline を完了収録すべてに投入（run ごとに `POST /api/v1/jobs`）。run 別の進捗リスト（live state、完了で PASS/FAIL）。
- **ワンクリック検証プリセット**: `GET /api/v1/validation/presets` のプリセットボタン（`pipeline`＋固定 `params`）。**未検証の完了収録**（`pending_run_ids`）へ一括実行。「N pending」表示・0 件は「up to date」で無効化。定義は機体設定 `config/<robot>/validation_presets.yaml`（[config.md](config.md)）。
- `dataset_export` pipeline は Review の Export と同じ**移動**の programmatic 版として残る。タブ内に「Validation only — export stays in Review.」を明示（Export の一機能一箇所は不変）。
- lifecycle チップ（Experimental → Standard の昇格）は**見た目のみ（TBD: 実体化は将来）**。

### Monitor — 通信・信号・システム診断

v1 の Graph / Probe / Live 健全性パネルの統合先。サブナビ（§11 順）は **Overview / Topics / Signals / System / Events / Logs**。6 サブビュー全て実データで実装（取得不能値は「—」・空グラフ／空リストは理由を明示）。既定表示は Overview。

- **コンテキスト帯**: 録画中は REC・run_id・経過時間、それ以外は STANDBY（`record_status` 由来の実表示）。
- **Overview ビュー**（診断ランディング・既定）: 録画コンテキスト、トピック健全性の集計（`ok`/`warning`/`danger`/`inactive` 件数＋要注意トピック名 → クリックで Topics にチャート）、発火中インシデント要約（実 alert バッファ）、`GET /api/v1/system` の簡易スナップショット、Topics/Signals へのジャンプ。
- **Topics ビュー**:
  - **チャートパネルの追加 / 削除（上限 4）**。パネル毎にメトリクス（**Frequency / Bandwidth / Max gap / Rate vs expected**）とトピック重畳（上限 6）を選択。時間窓（30s / 1m / 5m）と **Freeze charts / Live**（旧 Pause）はグローバル — 凍結はチャート限定（`Charts frozen · table still live.` を明示。テーブルは意図的に live 継続）。窓は開いてからの蓄積なので、蓄積が窓未満の間は `{window} window (n so far)` と正直に表示。チャート高さは**実測スロット追従**（固定高が overflow-hidden な親にクリップされ低値域が見えなくなる不具合の根治）。**録画の REC / STOP マーカー**を全パネルに重畳。Frequency には expected_hz の参照線。**latency / loss はメニューに置かない** — 非破壊 monitor では測れない（per-run の loss は Review の事後解析で提供）。
  - **トピック表**: discovery の全トピック＋live metrics（Hz / 帯域 / gap、status ドット `inactive`/`danger`/`warning`/`ok`/`unknown`、閾値超過時の shortfall バッジ＋理由 tooltip。shortfall は observed であり真の loss ではない）。**Rec チェックボックス列** = 次回録画の対象選択（記録途中の変更ではない）。設定済みトピックは事前チェック。機体切替で config 既定に再シード。チャートの系列選択とは独立。
- **Signals ビュー**（v1 Probe の移植）: `topic_probe` 由来の**数値フィールド**を (topic, field) 単位で重畳プロットする汎用プロッタ。トピック → 数値フィールド（配列は `[0..N]` 展開）を選び、**異トピック × 複数フィールドを重畳**。サンプルレート選択（1/5/10/30Hz・既定 10Hz）・窓・Pause。**decode は隔離コンテナ `topic_probe` が担い、録画・監視に波及しない**（[topic_probe.md](topic_probe.md)）。
- **System ビュー**（全面）: ホスト実測（CPU% / GPU% / ディスク使用量・`GET /api/v1/system`。取得不能値は「—」）＋ ROS_DOMAIN_ID・サービスエンドポイント（`GET /api/v1/config`）＋ **コンポーネント健全性**。健全性はブラウザから誠実に観測できる信号のみで表す＝ orchestrator=ライブ SSE 開通、monitor=`bridge` イベント。recorder / streamer の個別 readiness は orchestrator の**サーバ側 `/readyz`**（Docker healthcheck 用）で判定されブラウザオリジンには露出しない旨を明記する（`/readyz` は同一オリジンに proxy されないため fetch しない）。Overview / Topics 右レールには簡易 **System カード**を埋め込む。
- **Events**: SSE `alert` を **incident 単位（topic × metric）で 1 行に集約** — 発火中は `firing · since {t}` で現在値を in-place 更新、解消で `cleared · {t}`（muted）へ反転、再発火は `×n`。Overview / Topics 右レールの **Events カード**が集約表示、**Events ビュー**（全面）は topic 部分一致＋状態（firing/cleared/all）フィルタと注記（履歴は Monitor を開いてからのセッションローカル）を持つ。config ルールの無いトピックも monitor の既定 DANGER incident（持続 ~10s）で拾う = **テーブルの DANGER と Events は矛盾しない**（[topic_monitor.md](topic_monitor.md)）。
- **Logs ビュー**: 受信した SSE ライフサイクルイベント（record_status / alert / job）のセッションローカルなタイムライン（種別チップ＋テキストフィルタ、上限 ~500 のリングバッファ）。「このページを開いてから／完全なログは `docker compose logs`」と正直に表示。metrics は高頻度ノイズのため記録しない。

### Settings — 機体設定・計画

- **Robots**: 機体一覧（committed `config/<robot>/` と gitignored `config/local/<robot>/`）と選択（`POST /api/v1/config/select` で recording / stream を hot-swap。recorder QoS / monitor expected_hz は再起動後 — UI にもその旨を表示。**録画中のアクティブ化は「Stop and switch?」確認モーダル**）。**非アクティブ機体は read-only で設定を閲覧可能**（`GET /api/v1/config/robots/{robot}`。「Read-only — {robot} is not the active robot.」バナー＋雛形として読める disabled JSON）。**aspect**（recording / stream / validation / validators）の option 選択。recording config は JSON で編集・永続化（`PUT /api/v1/config/recording`。**インライン検証**: 不正 JSON は Save 無効＋平易エラー。録画中の保存は「次の録画から適用」の情報バナー）。機体の新規作成は不可 — `+ Add robot` は消えるトーストでなく**次の一歩を示す常設 explainer**（`config/<robot>/` フォルダ作成＋既存機体の雛形参照）を開く。レール下部は出典の無い版数表示を廃し **active robot の実値**。
- **Projects & tasks（Plans）**: Project / Task / Condition の定義を編集。Collect のピッカーと**共有ストア**で即時反映し、**サーバーに永続化**（`PUT /api/v1/plans`。2026-07-14 — 全端末で単一のラベル語彙を共有。オフライン時は localStorage が立ち dirty 編集は後で再 push。Plan の**モデル化**（id/参照/目標本数）は引き続き Phase 2.5）。
- **Recording**: アクティブ機体の recording config を**フォーム優先**で表示（`GET /api/v1/config/recording`：compression / start gate〔`start_paused`〕/ cache〔`max_cache_size_mb`〕と default_topics 表〔expected Hz・QoS override バッジ〕）。生 JSON エディタは「Advanced」に格下げ（既定折りたたみ・`PUT /api/v1/config/recording`）。
- **Data quality**（読み取り専用）: `GET /api/v1/config/robots/{robot}` の aspects 内容から、expected Hz 参照レート＋ monitor の warn/danger 閾値（`monitor.warn_shortfall`/`danger_shortfall`）＋アクティブ validation テンプレートの必須トピックを表示。明示的な閾値アラート規則は API 非露出の `config/<robot>/monitoring/alerts.yaml` にある旨を明記（レスポンスの `robot`＝機体ディレクトリ id を使い、存在するパスを指す）。
- **Validation**: validation / validators aspect 選択（`POST /api/v1/config/select`）＋ワンクリックプリセット一覧（`GET /api/v1/validation/presets`・pending 件数）。実行は Validation タブへリンク（1 機能 1 箇所）。
- **System**（読み取り専用）: デプロイ事実（ROS_DOMAIN_ID・エンドポイント・data dir/storage・コンポーネント健全性）。誠実な version ソースがクライアントに無いため version 行は省略。RMW/DDS は API 非露出のため注記のみ。
- **honest placeholder**: **Dataset profiles**（Phase 3 の recipe モデル待ち）と **Users & permissions**（同一 LAN・無認証スコープのため管理対象なし）は、理由を述べる placeholder のみ（dead な操作は置かない）。

## データフロー（SSE × キャッシュ）

- 単一の SSE ストリーム（`GET /api/v1/events`）を購読し、イベント種別ごとに TanStack Query キャッシュへ反映する。コンポーネントはキーを購読して再描画。
- SSE 切断は UI（ヘッダの接続チップ）に明示し、自動再接続する（`Last-Event-ID`）。

## 出力（呼ぶ API）

- 記録: `POST /api/v1/record/start` / `stop`
- Batch / Episode: `POST /api/v1/batches`、`PATCH /api/v1/batches/{id}`、`GET /api/v1/batches?status=active`、`POST /api/v1/episodes`、`PATCH /api/v1/episodes/{id}`
- Run: `GET /api/v1/runs`（episode JOIN 込み）、`GET /api/v1/runs/{id}`（RunDetail）、`DELETE /api/v1/runs/{id}`
- Topic / システム: `GET /api/v1/topics/status`、`GET /api/v1/events`（SSE）、`GET /api/v1/system`
- 設定: `GET /api/v1/config`、`GET/PUT /api/v1/config/recording`、`GET /api/v1/config/options`、`POST /api/v1/config/select`
- ファイル: `GET /api/v1/files/{path}`（video_check mp4）
- データセット: `GET /api/v1/datasets`、`GET/DELETE /api/v1/datasets/{op}/{task}/{index}`、`POST /api/v1/datasets/export(-all)`（UI からの入口は Review の Export ready）
- ジョブ: `GET /api/v1/pipelines`、`POST /api/v1/jobs`（`fast_validation` / `loss_report` / `video_check`。エクスポート後は `params.dataset_dir` 付き）、`GET/POST /api/v1/validation/templates`、`GET /api/v1/validation/presets`
- プローブ（orchestrator 経由でない直接接続はこの 2 系統のみ）: `/probe`（topics / fields / SSE サンプルストリーム）、`/webrtc`（offer / ICE）

## 設計方針

- **正直原則**: 測れないものは表示しない（latency / loss の偽装禁止・shortfall≠loss）。値をでっち上げない — 取得できない値・未実装の判定は「—」やモック明示で示す。品質（quality）とタスク結果（task result）を混同しない。
- **非侵入**: 監視表示は monitor の raw / no-decode + best_effort 由来。ペイロード decode は `topic_probe` に隔離。
- **画面あたりの image subscription 予算**: プレビューはタブ表示中のみ購読し離脱で解放、サブカメラは低解像度強制、集約値カード（System 等）は orchestrator の API 値のみで新規 subscription を作らない。同時フル解像度は 1 本まで。
- 実パスを持たない / pipeline をハードコードしない / schema・設定は backend が渡す。
- エンドポイントは `GET /api/v1/config` 取得完了まで描画を待つ（render gate）。ハードコード fallback は dev のみ。
- 記録中は危険操作（二重 start、topic / run_id 変更）を抑止する。破壊的操作（Discard / Delete / Reset / End early）は確認モーダル＋Cancel を必ず持つ。
- 時系列チャートは uPlot に統一。
- 共有設定は [config](config.md)。

## TBD 一覧

- Quick check の実判定（2 層設計は確定・Phase 3）／Advice 生成ロジック（Phase 3）
- Dataset Recipe・Build（Phase 3）
- Validation lifecycle（Experimental → Standard）の実体化
- split 転送ジョブと Review 転送 UI の実配線（split 自己申告の信号を含む）
- Session 階層・Plan モデル化（id/参照/目標本数 — カタログ自体のサーバー保存は 2026-07-14 に実装済み）・Batch Pause のサーバー化（Phase 2.5）
- アクセシビリティ（WCAG 2.2 AA）
