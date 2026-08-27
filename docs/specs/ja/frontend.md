# frontend 仕様

> ステータス: 設計確定（**v2 = Console v2 + capture store**）。v1（機能タブ構成）から**役割タブ構成**へ全面再編し、さらに全画面を runs/episodes から **captures** へ載せ替えた。日本語が正本（これを正とする）。英語版 `docs/specs/en/frontend.md` は自動生成ミラー（直接編集しない）。**認証は不要。**

backend-driven な軽量 Web UI（Vite + React + TypeScript）。タブは技術機能単位（v1: Live / Graph / Probe / Recordings / Validation / Datasets / Config）ではなく、**「誰の・どの仕事か」**単位の 6 タブ: **Collect / Review / Datasets / Validation / Monitor / Settings**。

## 役割

| タブ | 誰の仕事 | 内容 |
|---|---|---|
| Collect | オペレーター | 収録の実行・即時判断・改善 |
| Review | ML エンジニア | 収録品質とラベルの判断、データセットへの投入 |
| Datasets | ML エンジニア | 論理データセットの編成・カタログ・（将来）構築 |
| Validation | ロボットエンジニア | pipeline 実行・検証の標準化 |
| Monitor | ロボットエンジニア | 通信・信号・システム・**ストア健全性**の診断 |
| Settings | ロボットエンジニア | 機体設定・計画（Plans）と影響範囲 |

中核概念: **収録品質（quality）とタスク結果（task result）は別軸**（タスク失敗 ≠ 低品質。失敗データもラベル付きで学習に使う）。収録は **Batch > Episode** 階層で進行し、orchestrator に永続化される（[api_orchestrator.md](api_orchestrator.md) 「Batch」。Session 階層は **TBD**: Phase 2.5）。

**v2（capture store）で全画面に効く変更**:

- **すべての画面が `captures` API を読む。** `/api/v1/runs` と `/api/v1/episodes` の呼び出しは 1 つも残っていない。v1 の機能タブ（`RunsTab` / `DatasetTab` / `inspect`）とブラウザ内ブリッジ `episodeBridge` は**削除済み**。
- **testid は `capture_id`（dataset member は `membership_id`）でキーする。** 行番号やバッチ内位置ではキーしない — 2 つのバッチが同じ番号を持ったときに衝突するため。
- **Availability チップ**（下記）が、収録の実体が「今このマシンにあるか」を全画面で 1 つの語彙で表す。
- **削除は Discard と Delete の 2 つの別ダイアログ**（下記）。
- Monitor に **Store health パネル**が加わった（rebuild / corrupt / SUSPECT / Repair）。

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
- 各タブは URL でアドレス可能（`?tab=<id>`）。**`?tab=<id>&solo=1` はそのタブだけをタブバー無しで描画**する（タブ毎の ↗ ボタンで別ウィンドウに開ける。複数チャートを並べたい時のマルチウィンドウ手段）。Solo は URL の tab を初期表示として優先し、Collect では保存済み operator の hydration 完了後に batch 復元を始める。Collect から別タブへ移動しても `solo=1` を保つ。
- **表示文言は application state ではない**: quality / task result / review lane / eligibility reason / tab は、domain・view-model・URL・API・分岐では language-neutral な安定 code / ID を使う。オペレーター向けの英語（将来の翻訳を含む）は描画境界で format する。翻訳済み文字列を state、key、route ID、API 値、分岐条件に使わない。Task / Condition / Operator / failure reason のようなユーザー入力は翻訳・code 化しない。
- **ヘッダ（全タブ共通）**: 6 タブ・**ROS_DOMAIN_ID バッジ**・**接続チップ**（SSE の接続状態）・**OP チップ** = クリックで operator 名を設定（localStorage 永続。以後の全録画で `/record/start` の `operator` として送信）。Solo Collect にも OP チップを置く。

## 全画面で共有する部品（v2）

### Presentation primitives の境界

`src/components/ui.tsx` は、複数画面で同じ**意味・操作・アクセシビリティ**を持つ見た目だけを扱う。Button / IconButton、Modal、Card、Badge、Notice、単一入力の Field / 複数入力の FieldGroup と native input/select/textarea、SettingsSection はここを再利用する。内容はすべて呼び出し側が `ReactNode` として渡し、部品にオペレーター向け英語を固定しない。これによりテーマ、focus、disabled、destructive、折返しを全タブで同じ契約に保つ。

- 共有する: 同じ操作契約を持つ標準コントロール、通知の tone / live region、field の label/help/error、Settings の見出し・補助説明・action 枠。複数入力をまとめる `FieldGroup` は安定した `id` を渡し、fieldset と help/error をプログラム上も関連付ける。単一入力を `FieldGroup` で包んで個別の label を代用しない。
- 共有しない: capture の削除、import、Collect の録画制御、pipeline 実行など、文言・確認条件・失敗回復・状態遷移が異なるワークフロー。これらは画面側に置き、必要な表示プリミティブだけを組み合わせる。
- 新しい標準コントロールを追加する前に既存プリミティブを確認する。feature 内で focus ring、disabled 表示、status panel、icon-only の accessible name を複製しない。例外は画面固有の密度または interaction を同じ場所に説明する。

### Availability チップ

`capture.replica.state` と `capture.digest_state` から**唯一の判定関数**で導き、Review / Datasets / Validation が同じチップを描く。「使えるか」（`usable`）はこのチップの導出値で、ジョブ実行・プレビュー・archive の共通の前提条件になる。

| replica.state | 表示 | 意味 |
|---|---|---|
| `null`（行が無い） | not here yet | このマシンにまだコピーが無い。**split 構成では正常**（review の後にロボットから引く）。エラーではない |
| `present_verified` | verified | ここにあり digest 一致を確認済み |
| `present_unverified` + `digest_state=pending` | verifying | ここにあるが検証中 |
| `present_unverified` | here | ここにある |
| `trashed` | in trash | `.trash` にある（reaper 待ち） |
| `absent_managed` | removed | kairos が意図して消した |
| `missing_unmanaged` | missing | **kairos の外で消えた。**警告 |
| `corrupt` | corrupt | サイドカーが読めない。警告 |
| 未知の値 | unknown | このコンソールが知らない state。**警告として出す**（新しいサーバかもしれない＝バイトの所在は未確認扱い） |

**`verifying` と `verified` を混ぜない**のが要点。まだ検証していないものを「検証済み」と表示すれば、その表示は何も意味しなくなる。

### 削除の 2 ダイアログ（Discard / Delete）

**意図的に共通コンポーネントにしていない。** 文言・必須項目・確認の重さが違うものを 1 つの部品にまとめると、片方の変更がもう片方に漏れる。

| | Discard (not uploaded) | Delete |
|---|---|---|
| 用途 | 未送信データの破棄 | 通常の削除 |
| reason | **必須**（空欄では確定ボタンが無効） | 任意 |
| 文言 | 「元に戻せない・復元は無い」を明示 | 「ファイルは消えるが、カタログには記録が残るので行き先は答えられる」 |
| 件数・容量 | 対象件数とバイト数を必ず出す（不明なら `(size unknown)`） | 同左 |

- reason 必須の理由もその場に書く: 「lifecycle ledger に残る。ファイルが消えたあとは、この 1 行がなぜ消したかの唯一の記録になる」。
- **split 構成では両方にロボット残置の但し書きを出す**（`GET /api/v1/transfer/status` の `available` から split を判定）。discard 側は「このデプロイは別のロボットで録画している。破棄されるのは**この録画 PC 上のコピー**で、ロボット側にコピーが残っている可能性があり、kairos はそれを削除しない」と正直に言う。
- 一括実行は逐次で、進捗（`{done}/{n}`）を出し、**失敗は capture ごとに正直に報告**する。実行中は Cancel を塞ぐ。
- `409 capture_busy` は lease の所有者と失効時刻を名指しして返す。ダイアログは `details.holders` の**保持ジョブを全件（件数・job_id・失効時刻）並べ**、`lease_expires_at` を「何もしなければこの時刻に自然解除」として添えたうえで、**「Cancel those jobs and retry」**を出す — 待つことしか選べない状態を残さない（リースが削除を拒むのだから、削除側からリースへ手が届く必要がある）。押すと各 job へ逐次 `POST /jobs/{id}/cancel` し（拒否された job はその言葉で名指しし、残りは続行）、**削除を 1 回だけ自動再試行**する。**再試行が再び 409 なら最新の holders に表示を更新して止まる**（ループさせない — 1 周ごとに誰かの作業を消すため）。ボタンは「実行中の検証／プレビュー生成を止める＝その作業は失われる」ことを明記する。job 以外の保持者（転送・digest）はキャンセル対象外である旨も出す。

## 画面構成

### Collect — 収録の実行と即時判断

- **コンテキストバー**: Robot（実選択・Settings と同じ機体カタログ）／Project・Task・Condition（Plans 由来のピッカー＋Custom 自由入力）／**Batch 番号**／Episode 進行「n / target」。
  - **Plans カタログ（Projects → Tasks → Conditions）はサーバ同期**: 各段は canonical `project_id` / `task_id` / `condition_id` と表示名を持つ。Collect は選択済み Plan の ID と表示名を Batch / Start context に固定し、Custom・未一致は ID を `null` とする（近い候補を推測しない）。localStorage の旧 name/string 形は決定的 ID に正規化して保存する。同期は GET の `revision` と PUT の必須 `base_revision` による CAS で、409 conflict 時はローカル draft を保持し自動再送しない。Settings は conflict を表示し、明示の **Use server catalog** でだけ server copy を採用する。各応答は送信 generation に照合するため古い成功応答が新しい dirty edit を消さない。
  - Batch 番号は**サーバ発番の `batch_seq`**（機体×ローカル日付ごとに毎朝 1 から）。バッチ未作成の間は「next #N · assigned on first recording」の**予測表示**（本日の最大 seq + 1）とし、初回録画でサーバ値に確定する。「計画バッチ数」の分母は置かない（実体がないため）。
- **Batch / Episode 進行はサーバ永続**: Start は Batch 確保（必要なら `POST /api/v1/batches`）の成功を待ってから `collection_context` を送る。空バッチは行を持たず番号を消費しない。リロード・タブ切替は operator hydration 完了後、`status=active`・active robot・operator の**全てで絞った** batch だけを復元する（番号予測だけは robot 範囲で読む）。該当が複数なら newest を勝手に選ばず、復元しない旨を常設表示する。
- **Batch menu** の作用（End early / Reset は**録画を消さない**）:
  - Pause / Resume（現状ローカルのみ。サーバ化は **TBD**: Phase 2.5）／End batch early（`status=ended_early`＋理由）／Reset（空バッチなら**完全 no-op**、録画ありなら現バッチを閉じて次の録画から新番号）／Change condition（PATCH）／**Change target（2026-07-14）**: バッチの計画本数 `target_episodes` を 1–500 で変更（PATCH。次バッチにも引き継ぎ。録画済み数以下へ下げると即完了になる旨を事前明示）。**strip のチップ数・「n / target」・完了判定は全て target 連動**（UI の 30 固定を撤去 — API が持っていたのに UI が無視していた値）。End / Reset は recorder の停止確認と Batch PATCH の両方が server confirmation を返すまで local の終端・reset・成功表示・モーダル close に進まない。失敗時は batch を維持して Retry を示す。target 変更・次 batch 開始・target 到達による completion も、対応する server confirmation 後だけ成功表示・local 確定する。**context と Batch identity が不一致**なら、空 Batch は relabel して再試行し、録画済み Batch は rollover して新しい Batch を確保する。**Report issue は永続の receipt を保存できる経路ができるまで表示しない**。
- **録画操作**: Start / Stop。Batch API 障害時も Start 自体は妨げず、`batch_id=null` と現在の context labels を送って録画できる。その場合は Batch 進行を成功表示せず、理由と再試行可能性を表示する。**pre-arm（two-phase start, 2026-07-14）**: `recording.pre_arm`（既定 on）のロボットでは、タブ表示中かつ phase が ready/result の間 `POST /record/prepare` で recorder を armed に保つ（`disarm_at` の手前で keep-alive re-prepare。ベストエフォート — 失敗は表示せず Start が従来のフル同期パスに落ちるだけ）。prepare の context は仮情報であり、actual Start の metadata が manifest に採用される。armed 中は Start ボタン脇に「pre-armed · instant start」チップ、SYSTEM STATUS の Recorder 行に `ARMED` を表示（どちらも**サーバー報告の state を読む** — prepare を送った事実からは点灯しない）。Required data 行も armed の購読スナップショットで録画前から実測が出る。arming ゲート（subscription 確立待ち。「N matched · N missing」ノート）、failed-start バナー（**平易文言先行・生コードは従行** — `already_recording` 等はオペレーター語に写像）、**recorder cache/drop 検出バナー**（`dropped_messages`＋cache 設定のヒント、当該 capture にゲート）。**Audio feedback（2026-08-27、#44）**: Settings > Audio で端末ごとに opt-in（master 既定 off）し、Sound / Voice、音量、英語（既定）/日本語、voice、イベント別 Sound / Voice、イベントごとの phrase と Preview、failure reason ごとの Preview、Reset を設定する。対象は confirmed Start / Stop、Success 保存、Failure 選択、Failure reason 保存、Retake 成立、Save 完了、無効外部操作、Collect error。音は操作元タブでだけ鳴らし、reload・takeover・初回 status 取得では鳴らさない。Start は当該タブが開始した `capture_id` が `state=recording` かつ live と確認された瞬間、Stop は terminal かつ live 不在と確認された瞬間だけ鳴らす。Sound は短い Web Audio cue、Voice は Settings で事前生成して preload 済みの WAV だけを使い、Collect event 中に TTS 推論しない。Voice は user gesture で prime した同じ永続 media element を post-await 再生にも使う。Voice は同時再生せず `Error > Invalid > Retake > Failure reason > Failure/Success > Start/Stop > Save` で高優先を割り込み、同等以下の stale voice は捨てる。emit は呼出時の live settings と mount 状態を再確認し、master または Voice を off / reset すると再生中の Voice も停止して stale callback から再開しない。asset 不在、生成失敗、autoplay block、再生例外、壊れた browser-local 設定は Voice を skip し、録画・停止・保存・retake と既存 visual / `role=alert` を一切変えない。Collect のスピーカー popover は同じ browser-local master/volume の高速入口として残す。**キーボード**: `R`=Start / `S`・`Space`=Stop / `Esc`=arming Cancel / `?`=ショートカット一覧（入力欄フォーカス中は無効・ボタンラベルに `· R` 等のヒント）。フェーズ遷移毎にフォーカスは次の主操作へ移る（body に落ちない）。
  - **既定と保存範囲**: 音声フィードバックの正本は各ブラウザの `localStorage` の `kairos.audio-feedback.v2` であり、サーバの Plans / robot YAML / 他端末へは同期しない（storage 不可時もその mount 中の in-memory 設定で動く）。既定は master off、Sound / Voice はともに on、音量 0.45、English / `en-us`、Voice asset は空。イベント既定は Start / Stop / Save / Invalid が Sound のみ、Success / Failure / Retake / Error が Sound + Voice、Failure reason が Voice のみ。設定の version が不正または壊れていれば、この既定へ戻す。言語、voice、または server の engine を変えると asset URL と準備済み engine は空にし、失敗理由の語彙を変えるとその変更済み phrase に合う asset は無い。いずれも影響した Voice は `Prepare voice assets` を再実行するまで鳴らない。話者選択は provider の一意な voice/style ID を含み、再準備した asset は選択中の ID を content address と synthesis の両方に使う。これは音声の復旧手順であり、Collect の操作可否を変えない。
- **外部オペレータアクション（2026-08-23、状態別 mapping は 2026-08-27）**: 手が離せない操作（テレオペ等）向けの vendor 非依存な 3 つの論理入力 LEFT / CENTER / RIGHT（特定のフットペダル製品・ドライバ・SDK に一切紐付かない。汎用 HID マクロデバイスに同じコードをプログラミングすればよく、開発・テストは通常キーボードだけで完結する）。バインドは `Ctrl+Alt+1/2/3`（物理 `code` を読む — レイアウト非依存。生 printable キーとブラウザ既定を避け、R / S / Space / Esc / `?` とも衝突しない）。各入力の意味は Settings > External controls の設置共通 mapping と現在の機械状態から**純関数で導出し、ショートカット処理と常時表示の HUD（`ExternalActionHud`）が同一の解決結果を消費する**ため、表示と挙動は乖離し得ない。状態別に割り当て可能なのは READY=Start、RECORDING=Stop、RESULT（Failure 選択前）=Success + Save / Failure / Retake、RESULT（Failure 選択後）=reason slot 1–3 と `none` だけ。後方互換な既定は CENTER Start/Stop、LEFT Failure、CENTER Retake、RIGHT Success + Save、Failure 後の LEFT/CENTER/RIGHT=reason slot 1/2/3。SAVING / QUICK CHECK / ARMING / PAUSED / ENDED / COMPLETED と takeover は mapping にかかわらず全て disabled。Failure 理由ショートカットは**Failure が明示選択された後だけに**受理される（READY / RECORDING 中に理由を刻むことは構造的にできない）。入力ガード: typing（input / textarea / select / contenteditable）、開いている登録済み modal / overlay、saving / quick check 進行中、takeover、auto-repeat（`event.repeat`）、keydown ラッチ（1 物理押下 → 高々 1 論理アクション。keyup は**物理キーだけで**スロットを解除するため、modifier が digit より先に離されてもスロットが恒久ラッチしない）。`Success + Save` と `reason + Save` は**機械を通す単一複合ステップ**（`saveSuccess` / `saveFailureWithReason` — 描画クロージャでなくライブ store スナップショットを読み、マウス Save と同一の保存フロー。`saveFailureWithReason` は Failure 選択済みの result 状態でない限り no-op）で、pick+confirm の逐次 React 更新に頼らない。既存の R / S / Space / Esc / `?` とマウス操作は不変（フォールバックとして完全に使える）。HUD は 3 入力の**実効 mapping**＋現在地（disabled は「—」、未割り当ては「Unassigned」）を常に示し、Failure モードでは現在の Task 名も出す。
  - **キーボードだけの受け入れシナリオ（マウス操作なし）**: Settings の Plans で 1 つの Task に Failure shortcuts を設定（LEFT / CENTER / RIGHT の各スロットに共有 Failure reasons 語彙から理由を割り当て）→ Collect で同じ Task を選択し **CENTER**（`Ctrl+Alt+2`）で Start → **CENTER** で Stop → **RIGHT**（`Ctrl+Alt+3`）で Success + Save → 次の take を **CENTER** で Start / **CENTER** で Stop → **LEFT**（`Ctrl+Alt+1`）で Failure を選択 → 割り当て済みの **LEFT / CENTER / RIGHT** スロットのいずれかで理由 + Save → Review で**両エピソード**が正しく残っていることを確認（1 本目は Success、2 本目は Failure ＋ 選択した理由）。
- **録画状態はサーバが真実**（`GET /record/status` の 5s ポーリング。HCD 修正 2026-07-14）: このブラウザが開始していない/見失った録画が走っていれば **RECORDING IN PROGRESS カード**（run_id / 経過 / サイズ / operator / topics、確認モーダル付き `Stop & save`、`Open in Monitor →`）が READY の代わりに出る。SYSTEM STATUS の Recorder 行も同一クエリ由来 = 「READY なのに 409」の矛盾は構造的に発生しない。通常 Stop・takeover Stop・既に active な End / Reset は `POST /record/stop` の `200` だけでなく `confirmRecorderStopped` で terminal state かつ `live_capture_ids` に不在であることを確認してから停止済みとして扱う。arming 中に End で取り消した late start は、別 driver を止めない status 所有確認→stop 完了→digest lease を越えた discard を行う cancelled-start reconcile の完了を待つ（別 driver の録画開始後に全体の terminal 確認を待って誤失敗としない）。停止で回収されたテイクは下記「未保存テイク回収」に現れる。録画トピックの解決は v1 と同じ（selected / configured / all。選択は Monitor の Rec 列と連動し、「REC N topics」チップから Monitor へ飛べる。空選択では Start 無効）。
- **エピソードの保存**: Stop → 実イベントゲート（stop API 解決 → **recorder の停止確認** → integrity 読取。固定タイマー廃止・stop 失敗は SAVING に留まり `Retry stop`）→ 結果パネル。**stop の `200` だけでは前進しない（2026-07-27）**: `POST /record/stop` は冪等で、アクティブなものを見つけられなければ直近 run を `200` で返すため、**録画が続いていても成功に見える**。そこで解決後に `GET /record/status` を**即時 1 回＋1 秒間隔でポーリング**し、停止（terminal state かつ `live_capture_ids` に不在）を確認して初めて前進する（2026-08-07 改訂）。**status 読取の一時失敗は停止の失敗ではない**（2026-08 追補・timing sweep S2-2）: recorder の status ルートは finalise と同じロックを取るため、大きい bag の flush 中ほど 503/timeout を踏みやすい。確認ループは読取失敗を握って期限までポーリングを続け、エラーを表面化できるのは期限だけ。**この確認ループは Settings の robot 切替（stop & switch）とも共有**され、flush 中に config を hot-swap する経路（timing sweep S2-5）も閉じている。flush（rosbag2 のキャッシュ書き出し）は数秒かかる**正常な進行**であってエラーではないので、待機中は SAVING カードに「flushing (Xs)」の経過秒を表示し、recorder のエスカレーション予算（SIGINT 30s → SIGTERM 30s → SIGKILL 5s ＋余裕 ≈ **70 秒**）を超えたときだけ既存の `STOP_FAILED` 経路（`stop_not_confirmed`・`Retry stop`）へ流して SAVING に留まる。これが無いと、まだ書き込み中のテイクのラベル付けへ進んでしまい、終端は `MAX_RECORD_SECONDS` の自動停止だけになる。**Success は既定選択**で、クリーンな成功は `Save — success` 1 操作（Enter 可）。Failure は ✕ から理由必須の分岐（理由の選択肢は Settings > Failure reasons で編集する共有語彙。2026-08-04 — 固定配列を廃止）。**Quality の自動値はサーバの確定 `quick_check.verdict` を優先**し、未確定の間だけ実 integrity にフォールバック（clean→`Good · auto`、drop/failed→`Needs review · auto`＋実 drop 件数。でっち上げない）。`change` から 3 択（good / needs_review / not_usable）で任意上書き。**保存は `PATCH /api/v1/captures/{id}/review`**（`base_revision` 必須の CAS）。payload は、上書き時のみ `quality` ＋ `quality_source='operator'` を送り、非上書き時は `quality`／`quality_source` を省略してサーバに導出させる（capture の確定 `quick_check.verdict` が自動品質の単一の源。save が settle 前でもサーバが後追いで補正する — [api_orchestrator.md](api_orchestrator.md)「確定後の遅延再導出」）。オペレータの手順・操作数は不変（省略はペイロード側だけの変更）。**サーバ確定後にレシート** `Saved — Episode n of Batch m · {operator}`（strip チップに一時リング）。Discard は Discard ダイアログ（**reason 必須**・上記「削除の 2 ダイアログ」）を経由する**実削除**（`POST /api/v1/captures/{id}/delete {kind:"discard"}`）。**Retake（2026-08-05）**: 結果パネルの 1 ボタンで「このテイクを discard（ledger 理由 = superseded by retake）→ 同一ラベルのまま即座に次の録画を開始」— 1 日数十回の discard→再選択→再スタートを 1 操作に畳む。discard が失敗した場合は自動再開しない。**Storage 行は recorder 自身のディスク**（`GET /record/status` の `disk_free_bytes`。split ではロボット側）を優先し、**録画中はライブ書き込みレートから「残り ≈N 時間」**を併記する（開始 10 秒未満・アイドル時は推定を出さない — でっち上げない）。
- **未保存テイク回収**: Stop〜Save 間で離脱しても、リロード時に「Unsaved take from {time} — {N} MB, {duration}」の amber バナー（`Label it` / `Discard` / `Later`）で回収できる（終端状態かつ `review_revision == 0` の直近 capture を検出）。Label は `collection_context.batch_id` が非 null なら**元の Batch detail を復元できた場合だけ**その Batch へ Review 保存する。元 Batch の取得失敗時は別 Batch を推測して接続せず回収を進めない。`batch_id=null` の古い回収対象も ungrouped のままとし、推測接続しない。
- 件数「n / target」は**単調カウンタ `episodes_recorded`**（撮った数が正。Review 側の削除で減らない。品質内訳と乖離した場合は脚注で明示）。
- **COVERAGE サイドカード**: 現在の Plan ID（未解決時は name fallback）・active robot・hydrated operator を全て scope として送る。scope が未確定なら待機理由を表示し、別 robot/operator の総計を混ぜない。行 = プランの conditions ∪ scope 内で実際に使われた condition（`condition_id` と name の組）。`episodes_recorded` の和は初回 review 保存で増え、exclude / delete しても減らない。カードは scope を明示して「次に何を録るか」をデータで決める。
  - **v2 で「exported」列は撤去した。** §6 で dataset は capture の名前付き集合になり、dataset 自身は condition を持たないので、旧来の件数には**導出元がもう無い**。誰にも導けない数字を出すくらいなら、数字を出さない方がよい。
- **エピソード strip はチップを真のエピソード番号（`index_in_batch`）に置く**: 配列位置で描くと Review の削除で後続チップが左に詰まり、直近エピソードが「not recorded」に見える 1 ずれが出る。録画済み番号のうち現存しない番号は破線チップ+「recorded earlier; no longer listed (deleted in Review)」で正直に区別する。サーバが `index_in_batch` を振り直した保存（端末間衝突）は応答値をローカルチップにも採用。**サーバ復元は同一バッチに限りマージ**（保存直後のチップが not recorded に戻らないように）。別バッチへの復元ではローカルの件数を持ち込まない。
- **カメラ**: WebRTC プレビュー。ペイン追加/削除（**手動追加の上限 4**。stream config が定義する初期ペインはこの上限に縛られない — 機体設定として意図的に 5 台以上を並べる運用があり、サブは低解像度強制なので購読予算の原則は保たれる）。メインは解像度プリセット選択、サブは低解像度（240/360p）に強制 cap。**遅延 / fps はプレビュー映像内・右上のオーバーレイチップ**（タイル毎の実測値・閾値色。映像外へは置かない）。接続前のプレースホルダには状態の理由を明記（空欄を故障に見せない）。
- **Active warnings カード（2026-07-15 拡張・2026-07-27 改訂）**: 実データ 2 系統の合成 — ①arming スナップショットの未捕捉ターゲット（`armed` 中は現在値・録画中は開始時点で凍結）＋②**発火中の monitor アラート**（SSE `alert` バッファ。hz/gap 等の閾値超過＝**録画中の途中劣化**をオペレータの見ている画面に出す）。①は**原因を混ぜない**: 「N target topics not publishing」と断言するのは `missing_topics`（publisher 不在）だけで、`unsubscribed_topics`（配信中・recorder 未購読）は「not subscribed yet」と別文言にする — Monitor で 30 Hz 出ているトピックを「配信されていない」と表示するのは嘘であり、オペレータを誤った復旧作業に送る（両方あるときは断言せず「not being captured」＋内訳）。アラートは**録画対象トピックに限定**（arming があればその matched∪missing∪unsubscribed、無ければ config `default_topics` パターン、どちらも無ければ全件＝隠すより広く出す）。表示は実測値付き（`joint_states Hz < 45 · now 38.2`）・上限 2 件+「+N more in Monitor」・「Open in Monitor →」導線。待機中も表示する（録画開始前に「今日は調子が悪い」に気づける）。System status カードには **Topic rates 行**（`N / M at expected` — monitor が判定したトピックのうち status=ok の数。`unknown` は分母に入れない・monitor 停止時は「—」）。合成スコアは作らない（原因を隠すため）。
- **Quick check**（停止直後の品質サマリ）: サーバが停止時に確定した `quick_check.verdict`（good / needs_review ＋人間可読な `reasons`）を結果パネルに表示する（capture 詳細 `GET /api/v1/captures/{id}` を控えめにポーリング〔約 3 回 / 5s、確定で停止〕）。未確定の間は「Quick check running…」の控えめな注記のみ（でっち上げない）で、**保存は確定を待たない**。判定の設計は「収録中に貯めた監視統計の清算」2 層 — Layer 0 = monitor / recorder が収録中に持つ統計（件数・drop・gap・expected_hz 比。stop 時点で確定）、Layer 1 = MCAP の summary section のみ読む（O(index)）。**≤5 秒・split 構成でも転送ゼロ**で成立させる（詳細は [api_orchestrator.md](api_orchestrator.md)「停止時クイックチェック」）。
- **Advice** は固定 1 件のモック（hold still ~1s）で、可視見出しも `General tip · static guidance` とし個別分析に見せない。**生成ロジックは TBD（Phase 3）**。方針のみ確定: Live advice は orchestrator SSE の集約メトリクスを入力、Deep advice は転送後の MCAP（dora は DDS に触らない）。
- 3840×2160 から 1366×768 まで**ノースクロール**で収まる（コンパクト密度切替）。Collect は読み物の本文幅ではなく操作コンソールなので、デスクトップでは利用可能な幅・高さを使い、左操作列＋右カメラ列の配置と映像の aspect ratio を維持する。固定 `max-width` / `max-height` で大画面の大半を空白にしない。

### Review — 品質とラベルの判断、データセットへの投入

- 完了収録の一覧＋詳細。各行は capture 1 件（`GET /api/v1/captures`）で、**Batch「MM/DD · #N」/ Task result / Quality / レーン / Availability チップ**を表示。operator 等でフィルタ可能。**一覧はカーソルを最後まで追従**（200件で黙って切れない）し、ヘッダに実データ集計チップ（`n ready · n needs check · n excluded` / `n success · n failure`）。表示番号は**永続 `index_in_batch`**（削除で振り直らない）。判断ボタンは**スクロール外の固定バー**。
- **例外レビューモデル**: quality が good（または operator 確認済み）の capture は **READY**（追加クリック不要）。**NEEDS CHECK**（quality 非 good かつ未判断）だけが作業キューで、「Mark OK — include」か Exclude で解消する。既定の並びは NEEDS CHECK → READY → EXCLUDED。
- **ラベル編集(operator / task / robot)**: 詳細パネルの Inspection 行を**その場で編集**できる(値をクリック → 3 つの入力 → Save labels)。主用途は**取り込んだ bag** — recorder は自分が開始した収録にしかこれらを刻まないので、外から来たディレクトリは無ラベルで生まれ、operator / task フィルタから見えないままになる。**未設定は「—」ではなく「Set operator…」**と出して、埋められることを示す。3 つは**1 リクエスト**で、既存 review と**同じ CAS 経路**(`base_revision`・409/500 の扱いも同一)。空白のみは `null` で送って**クリア**(= 収録自身の manifest の値に戻る)。拒否されたときは編集中の入力を保持したままその操作の言葉で理由を出し、**保存されたとは決して表示しない**。
- **Condition の文脈表示**: Review/Datasets は capture の immutable `collection_context.condition` を収録時の正本として表示・検索する（明示 `null` も「未記録」で、現在の Batch へ fallback しない）。context が欠落した古い capture だけは `batch_id` の現在値へ fallback し、取得中・失敗は unavailable と明示する。Review Inspection では **Task の直下**に読み取り専用で出す。
- **Review 保存は本物の CAS**（`PATCH /api/v1/captures/{id}/review`。[api_orchestrator.md](api_orchestrator.md)「Review の保存」）。**楽観的にコミットしない** — 楽観的な編集は表示するが、失敗すれば元に戻す。
  - **`409`（競合）**: バナーで「他の誰かが先に保存した。リロードして適用し直すこと — 2 つの編集はマージされない」と述べ、**現在サーバに保存されている値を名指しで表示**する（`It is now {review_status} · {quality}`）。そのために `GET /api/v1/captures/{id}` を best-effort で引き直す。
  - **`500`（サイドカー書き込み失敗）**: **必ず明示的に閉じる必要がある**赤いバナーで「**Not saved.** …何も保存されていない — `record.json` が書けなかった。空き容量か権限を直してから保存し直すこと」。トーストのように勝手に消してはならない（消えると、保存されていないのに保存されたと思い込む）。
- **データセットへの投入は Datasets タブが入口**（一機能一箇所）。Review は判断までを担い、READY 到達後は Datasets への導線を出す。v1 の「Export ready (n)…」による**移動**は無くなった — dataset は論理的な集合になり、収録の実体は動かない（[capture_store](capture_store.md) §6）。
- **削除は 2 段階**: Exclude =「Excluded — kept on disk」（非破壊・ラベルのみ）→ 除外済みの項目だけに Delete / Discard の導線（上記「削除の 2 ダイアログ」。一括は逐次実行し失敗を正直に報告）。**単票 Exclude に確認ダイアログは無い** — 行からでも詳細パネルからでも即時に効く（録画は 1 バイトも消えず 1 操作で戻せる。確認を出すのは取り消せない Delete / Discard だけ）。代わりに Exclude 直後、一覧ツールバーの直下に **Undo 帯**（`role="status"`）が出て、**その Exclude が上書きした `review_status` / `quality` / `quality_source` を 1 回の保存で戻す**。この記憶はクライアント側・セッション限り・**直近 1 件のみ**（サーバに「以前の review」は無く、Undo ボタンのために schema を増やさない）。`quality` は `null` も明示送信する（省略は「変更なし」＝ `not_usable` が残る）が、**サーバは明示 null の quality を quick check から引き直す**ので、operator が一度も付けていなかった quality は「機械判定に戻る」（トーストもそう述べる）。**capture が excluded でなくなった時点で提示は消える** — Return でも Adopt でも、他端末の保存が sweep で届いた場合でも同じ。消えない提示は、後から押すと新しい判断を古い値で黙って上書きする。EXCLUDED や確定済みの例外からは「↩ Return to review」で pending に戻せる（可逆）。ただし **pending は完了状態ではない**ので、戻したときは「Adopt to include in datasets」と残りの手順を明示する。
- **詳細 inspection**: manifest / validation / loss_report テーブル / オンデマンド mp4「Video check」プレイヤー / 各 JSON ブロック。`fast_validation` の実行も詳細から可能。loss_report は従来の topic 別集計に加え、閾値超過した gap を**時刻帯・topic・gap 長・推定欠損数の一覧**で表示する（heatmap にはしない）。推定は中央値ケイデンス由来で、欠損位置や原因の断定ではない旨を併記する。実行は既存の「Run loss report」を押した時だけで、録画終了後に自動実行しない。**「All cameras」はその capture のカメラトピックを一斉に投入する**（§7.1 が共有 reader リースになり、読み取り専用ジョブが同一 capture を排他しなくなったため。実際の同時実行数を絞るのは `KAIROS_DORA_MAX_CONCURRENCY` ＝ 仕事のある側で、クライアントは順番待ちをしない）。以前はリース競合を自前で避けるため 1 本ずつ直列化し「Queued behind n…」を出していたが、待ち表示ごと撤去した。
- **Data integrity セクション（2026-07-15 に旧 Signals セクションを再設計）**: `signal_report` を明示ボタンで実行し、**①同期動画（video_check のフル尺 mp4）→ ②その直下の集約 integrity タイムライン → ③ランク順ロスイベント表 → ④トピック別サマリ（メッセージ数・continuity・ロスイベント数）**の順で表示。タイムラインは**1 レーン**（全トピックの worst 重畳。緑=問題なし / 琥珀=minor / 赤=major またはデンストピックの沈黙 / 灰=どのトピックも非アクティブ）で、hover で劣化トピック名、クリックで動画シーク（フル尺動画ロード時のみ＝head-only では嘘になるので無効）。**空ビン=赤はデンストピック（median 非零密度 ≥ 3）に限定** — 実測で bin 幅（~10ms）< メッセージ周期（20–30ms）となり健全データが真っ赤になったため。スパーストピックのロスは backend の loss_events（1.5×中央値間隔）が担う。イベント表は **major 優先・duration 降順**で先頭 8 件、以降は「Show all n events」で明示展開（件数は常に表示＝黙って隠さない）。**旧・生波形チャート（uPlot per-field プロット）とフィールド選択 UI は撤去**（関節角の生波形は「このエピソードは使えるか」に答えない。ライブ波形は Monitor > Signals＝topic_probe が担当）。付随して Settings の Signals 既定表示エディタと `GET/PUT /api/v1/config/signals` も削除。
- **バッチ絞り込み+バッチ一括判断**: 行のバッチチップをクリックでそのバッチだけに絞り込み（もう一度クリック/✕/Clear で解除）。絞り込み中はヘッダに「Exclude batch (n)…」（**確認モーダルは一括にだけ残す** — n 件をまとめて動かすため。保存する内容は単票 Exclude と同じ Not usable+excluded で**録画はディスクに残る**・逐次保存・失敗は行ごとに正直に報告するが、**単票の Undo 帯は付かない**。戻す道は「↺ Return batch」で、一括実行時は単票の Undo 提示を消す＝直前の 1 件の取り消しとして読まれないため）と「↺ Return batch (n)」（除外済みを一括で pending に戻す）が出る。バッチ一括検証（Validation）で FAIL したバッチを混ぜないための 1 操作。一覧のセクション分け（フル・グルーピング）は**意図的に不採用** — 例外レビューの作業順（NEEDS CHECK 先頭）を壊すため。
- **外部 bag の取り込み（2026-08-05）**: Review 右上の **「↧ Import bags…」** から、kairos 以外で録った rosbag を取り込む。**フォルダ単位**の流れ — サーバから見えるフォルダパスを入れて **Scan**（`GET /api/v1/imports/scan`）すると、**直下 1 階層**の bag ディレクトリ（**この深さは裁定**。深いツリーはその親フォルダを指定する。bag でないフォルダは「失敗」ではなく単に出さない。ただし**その中に bag がある場合は「このフォルダに N 件」とヒントを出し、クリックで降りられる** — 空表示のまま「空なのか 1 段深いのか」を分からせないため）が「トピック数 / メッセージ数 / 長さ / サイズ」または**取り込めない理由**（`metadata.yaml` 無し＋`ros2 bag reindex` の提示、取り込み済み、`.mcap` 無し）付きで一覧される。**コピー前に全部見える**のが要点。取り込み可能な行は既定で全選択。**Copy（既定）/ Move** を選んで実行すると 1 本ずつ順に取り込み、**失敗した bag はスキップして理由を行に残し、残りは続行する**（最初の不良で止まると残りを手作業で入れる羽目になる）。1 bag = 1 capture として `objects/<capture_id>/` に入り（`.incoming/` 経由の atomic rename）、表示名は `imported_YYYYmmdd_HHMMSS`、operator/task は空なので Review でラベル付けする。**実行前に operator / task / robot の一括ラベルを入力できる**（いずれも任意・**そのリクエストの全 bag に同じ値**が付き、capture の出生 manifest に刻まれる＝§4.3 の review override ではない）。未入力の項目は**送らない**（空文字は「在るが何も言わないラベル」になるため）。operator は plans のロスターを datalist で候補表示するが自由入力は維持。不正なラベル（`/` を含む・255 **バイト**超）は**リクエストを 1 本も出さずにその場で理由表示**し、入力は保持する（サーバは同じものを 400＋全件不取り込みで返すが、`.mcap` 無しなどの**bag ごとの 400 と区別できない**ため、文書化された 2 条件はクライアントで先に止める）。ここを空のままにすれば従来どおり無ラベルで入り、Review で個別にラベル付けできる。取り込み後は通常の capture と同じ（検証・データセット・archive すべて可）。コピーは非同期なので、実行後は数回だけ一覧を追い読みする。
- **検証判定バッジと override（2026-08-05）**: 詳細パネルに `VALIDATION PASSED` / `VALIDATION FAILED` / `NOT VALIDATED` を出す（サーバ導出の verdict をそのまま表示 — 画面が独自計算しないので dataset ゲートの挙動と食い違わない）。`NOT VALIDATED` は「まだ誰も検証していない」であり合格ではない旨を明記する。FAILED の capture は dataset に入らず、**理由必須の override**（ledger 記録）で通せる／撤回できる。Collect 側は保存直後に `needs_review` を 1 行で知らせる（数日後の Review で気付くのでは再セットアップになるため）。
- **failure の理由は見える**: 保存時に選んだ `failure_reason` は一覧の FAILURE チップの tooltip と詳細パネルの Task result 欄下（赤字）に表示する。
- **split 構成の転送**: `GET /api/v1/transfer/status` の `available` で split を判定し、有効なら Availability チップの `not here yet` と併せて「録画 PC へ転送」（`POST /api/v1/transfer/pull {capture_id}`）を出す。**完了は転送 API では通知されない** — frontend が見るのは capture の **replica state** で、reconciler が届いたディレクトリを採用した時点で `present_unverified` に変わる。v1 の `bag_local` 真偽値は廃止した（「ここにある / 無い」しか言えず、**届かなかったコピーと意図的に消したコピーを区別できない**ため）。転送は**手動 pull のみ**（自動スケジューラは作らない）で、**転送と検証は別ボタン**（auto-chain しない）。初回 review 保存時の auto-pull は `transfer.auto_pull_on_save` で opt-in。

### Datasets — 論理データセットの編成とカタログ

**v2 で dataset は論理的な集合になった**（[capture_store](capture_store.md) §6）。収録の実体は `objects/<capture_id>` から動かず、dataset は DB 行 + ledger イベントだけ。したがってこのタブは「エクスポート済みのカタログ」ではなく「**集合を編む場所**」になる。

- **編成**: 候補レール（Review で READY になった capture）から `POST /api/v1/datasets/{id}/members` で dataset に追加、`DELETE …/members/{membership_id}` で外す。**バイトは 1 バイトも動かない**ので、外して戻すのも、1 つの capture を複数の dataset に入れるのも自由。`display_index` の欠番は別 recording に渡らないが、**同じ capture の登録し直しは元の番号に戻る**。候補レールは**追加できるものが先頭**: 追加不可（未 adopted / bytes 不在）の行は既定で畳み、「Show blocked (n)」で件数明示のうえ展開する（展開行は各自の理由を保持）。候補行・メンバー行・選択メンバー詳細は Task / Operator / Task result と併せて**収録時 Condition**を表示する。snapshot のない旧 capture だけ Batch fallback を使い、取得不能は空値にせず unavailable と出す。
- **候補の条件検索と一括追加の来歴**: 一括追加の確定 run ごとに、固定した `selection_query`（states / review statuses / present-on-instance / 日時範囲 / dataset 除外 / `AND` / `OR` predicate）・一致数・試行/成功/失敗数を `POST /api/v1/datasets/{id}/selection-recipes` へ append する。Summary はこの完全なサーバー検索条件を履歴として表示する。手動追加・Combine は recipe を捏造しない。保存失敗時は member の成功を戻さず「members added but recipe not saved」を明示して dialog を閉じない。
- **候補の条件検索と一括追加**: 自由入力 1 本を、`Any field / Operator / Task / Condition / Run ID / Capture ID / Task result` のフィールド、`contains / equals`、値を組にした**明示的な条件**へ置き換える。追加済み条件は取り外せるチップで常に見せ、条件全体を `AND` または `OR` で結合する（カンマは構文ではなく通常文字）。候補はサーバー検索のカーソル単位で表示し、Next / Previous は表示のためだけに境界を保持する（ブラウザで全件を蓄積しない）。対象 dataset または条件を変えたら先頭ページへ戻る。**一括追加は表示中のページではなく** `POST /capture-selections` が凍結した全一致集合を server-owned bulk run に渡す。確認モーダルの件数もこの凍結済み集合を表示するため、ページ移動で実行対象は変わらない。
- **一覧は 1 棚ずつ**: Active（既定 = active＋archiving）と Archived の切替（`dsview` で URL 化）。封印済みの記録が作業リストに混ざらない。**全カタログスコープは廃止** — dataset ごとの採番を混ぜた一覧では #N が何も識別しないため、未選択時の中央は選択を促すプレースホルダになる（旧「All datasets」行は削除）。
- **ラベル編集**: ヘッダの「Edit」（active のみ描画）→ name / operator / task の 3 フィールドのモーダル（`PATCH /datasets/{id}`）。member と番号は不変であることをダイアログが明言する。複数人で録画した dataset は operator を空にしてよい（各収録は自分の operator を保持し続ける）。
- **合成（Combine）**: 左カラムの「⧉ Combine」→ 新しい dataset の name＋合成元（active な dataset のチェックリスト、選択順が採番順）→ 実行。**合成元は一切書き換えない**（dataset はリストであり、リストを読んでも変わらない）。実装は通常の作成＋member 追加を一括で行うだけで、一括規律（逐次・`{done}/{n}` 進捗・capture ごとの失敗を正直に列挙・実行中 Cancel 不可）に従う。両方の合成元にいる capture は最初の出現で 1 回だけ入る。合成後の新 dataset を archive する場合は、共有 member の 409 により先に合成元の整理（削除 or member 除去）が要る — dataset の削除は録画に触れない。
- **URL 状態は `dataset_id` / `membership_id`** で持つ（`url.ts` が所有するのは `ds*` キーのみで、`tab` / `solo` には触らない）。**名前は編集可能・`display_index` は表示用**なので、安定 ID はこの 2 つしかない。`dsmem` だけが指定されて `dsid` が無い URL は落とす。
- **ラベルフィルタ+マニフェスト**: task result（All / Success / Failure）チップ + operator セレクト + 検索ボックスで絞り込み。「Manifest (n)」でフィルタ結果を JSON マニフェスト（`data_dir` 相対パス+全ラベル）としてダウンロード — **学習セット定義をバージョン管理可能な 1 ファイルに実体化**する。全件非表示時は「フィルタで n 件隠れている」と明示。
- 各 member / 候補行に **Availability チップ**を出す（上記）。**使えない capture（missing / trashed / not here yet）はジョブ・プレビュー・archive の対象にしない。**
- 詳細 = DatasetDetail（メタデータ / member 一覧 / トピック / loss report / mp4 Video check / サイドカー JSON）。ジョブは `capture_id` で走る（`params.dataset_dir` は廃止）。
- **capture 単位の archive**: 候補が「archive root が設定済み」「どの dataset の member でもない」「availability が usable」の 3 条件を満たすときだけボタンを出す。ダイアログは destination と `<destination>/<capture_id>` の**両方**を見せ、確定ラベルは「Copy, verify, then remove」。
  - 成功トーストは `Archived to {dest} — verified, then removed from this machine`。**完了応答そのものが verify の主張**（コピー中に per-file hash を照合し、不一致は source を消す前に run 自体が失敗する）なので、「コピーは済んだが未検証」という応答分岐は存在しない（2026-08-11, sweep S4 — 常に True の `verified` フラグと、それを読む到達不能な警告分岐を撤去）。verify の失敗は run の失敗としてエラー面に出る。
- **dataset 単位の archive（§6.1・終端遷移）**: ヘッダの「Archive dataset」は**成功しうるときだけ**出す（root 設定済み・status が active・member が 1 件以上）。ダイアログは per-capture と同じ境界提示（root 選択＋**Path 入力** — views 形状 `<operator>/<task>/<name>` を先埋めした自由編集のパス。最終着地 `<root>/<path>` を echo し、使用中のパスは 409 で断られる旨も明記）に加えて **mode のラジオ**を持つ: 「Copy out — keep them」（封印のみ・確定ラベル「Copy, verify, then seal」）と「Move out — remove them」（源削除・「Copy, verify, then remove」）。他の active dataset と共有する member がいれば **Copy を既定にし、その理由（n 件が共有）を明記**する — Move はサーバが 409 で列挙拒否する。archived バナーも mode を正直に言い分ける（Copied to … stays on this machine / Archived to … removed from this machine）。202 の後は**同じダイアログが進捗ビューに変わり**、`GET /datasets/{id}/archive` を 1 秒間隔でポーリングして `{done} / {total}`・コピー中の capture・halt 理由を描く。**halt は原則 dismiss する失敗ではない**: run は `archiving` のまま、Resume（destination 無しの再 POST）が続きから再開する。ただしサーバーが `cancelable=true`（完了 member 0 件）を返した halted attempt だけは「Cancel archive run」を出し、実行前に「dataset は Active に戻る・destination claim は解放する・destination file は削除しない」と結果を明示する。部分完了 run には表示しない。`cancel_blocker=archive_canceled` は ledger 上で cancel 済みだが catalog 反映待ちの異常状態として説明を表示し、Cancel も Resume も出さない。完了トーストは `Archived to {dir} — n recordings verified, then removed from this machine`。
  - **status はバッジで行の同一性の一部**（archiving=amber・archived=gray、一覧行とヘッダの両方）。archived は read-only: 行き先と日時を言うバナーを出し、member の Remove / Discard / Delete と BuildRail の追加は**描かない**（サーバは全部 409 で断るので、出せば確実に失敗するボタンになる）。dataset の Delete は disabled＋「Kept: this record is what remembers where the dataset went.」— **archived の行は移行ログの照会キャッシュ**であり消させない。
- **Delete**(上記「削除の 2 ダイアログ」)。dataset 自体の削除は `DELETE /api/v1/datasets/{dataset_id}` で、**capture のバイトには触れない**（archiving / archived は上記の通り 409）。
- **Build**（LeRobot v3 等への変換）と **Recipe 型データセット構築は未実装（TBD: Phase 2）** — UI は淡色の枠のみで、動くコントロールに見せない。

### Validation — pipeline 実行・標準化

v1 の機能をそのまま維持し、レイアウトのみ v2 化。

- **pipeline 非依存**: pipeline 選択（`GET /api/v1/pipelines` の enabled 全件）→ **対象選択**: capture（v2 では「エクスポート前 / 後」の区別が消えたので、グループ分けも `dataset_dir` 分岐も無い。availability が usable なものだけを対象にできる）→ **パラメータフォーム**（`schemas.pipeline_forms[<id>]` から自動生成。`x-suggest` 注釈付き string はターゲット capture の実トピックから選択式＋先頭自動シード — video_check の `topic` はカメラの手打ち不要）→ durable Validation Run の作成（必須 `request_id` と単票 `capture_ids` または server selection の `selection_id`）。対象 picker はサーバー検索のカーソル単位で Next / Previous を出し、ページ移動時にはページに属する選択を外す。All / Batch は表示ページでなく server selection を凍結して実行する。結果は**汎用レンダラ**が `summary.json` を shape 非依存で描く（PASS/FAIL バッジ・message・metrics の key-value ツリー・artifacts・raw JSON）。**artifacts はデータ相対パス（orchestrator が正規化）なら `GET /api/v1/files/{path}` で取得可能として描画**: 画像（png/jpg/svg/gif/webp）は**インライン表示**、その他はダウンロードリンク、正規化できない絶対パスはテキストのまま（404 するリンクをでっち上げない）。つまり**プラグインが report dir にプロット画像を書けば UI 無改修でグラフが出る**。**プラグイン追加時に本タブへ手を入れる必要はない**（[dora_plugins.md §2.5](dora_plugins.md)）。
- 同梱 `fast_validation` のみ template の必須トピック一覧に対する専用チェックリストを持つ。結果は CSV でダウンロード可能。
- **一括実行**: 「All completed captures」は終端かつこの設置で利用可能な capture のサーバー検索結果を `POST /api/v1/capture-selections` で固定し、その `selection_id` から 1 つの durable Run を作る。ブラウザは capture ごとの `/jobs` を発行せず、Run detail の capture 別状態と PASS / FAIL を表示する。
- **バッチ単位の一括検証**（blast-radius 裁定 = 一括検証のみ・alert 永続化なし）: 対象セレクタの「Batches」から選ぶと、表示ページではなく `batch_id` を含むサーバー検索を snapshot 化し、availability が usable な capture 全件を 1 つの durable Run にする。ページ内に候補が見えていないだけで無効化しない。較正ずれ等バッチ単位でクラスターする欠陥を 1 クリックで検証する入口。
- **ワンクリック検証プリセット**: `GET /api/v1/validation/presets` のプリセットボタン（`pipeline`＋固定 `params`）。**未検証の capture**（`pending_capture_ids`）へ一括実行。「N pending」表示・0 件は「up to date」で無効化。定義は機体設定 `config/<robot>/validation_presets.yaml`（[config.md](config.md)）。
- **実行中 Run の中止**: 進捗の下に **Cancel run** を置き、`POST /api/v1/validation/runs/{run_id}/cancel` の durable intent を送る。要求直後は `cancel_requested` として表示し、child の実作業停止を server が確認するまで完了を偽装しない。中止した child は **CANCELED** として失敗と区別し、拒否は dismiss するまで保持する。
- **Run はブラウザより長く生きる**: Run の正本は server の `validation_runs.db` で、URL の `vrun=<run_id>` からタブ往復・reload・別 window・orchestrator restart 後も同じ進捗を再取得できる。create 応答喪失に備え、応答を受ける前から同じ必須 `request_id` と完全な payload を sessionStorage に保持し、reload 後も別 Run を作らず同じ intent を再送する。Run URL が不在・取得不能なら idle や成功に見せず、その状態を表示する。
- backend に lifecycle / promotion 契約が無いため、Experimental / Candidate / Standard チップ、Promote、New run の偽操作は表示しない。enabled pipeline の実情報と「Lifecycle and promotion are not configured in this console」だけを表示する。

### Monitor — 通信・信号・システム診断

v1 の Graph / Probe / Live 健全性パネルの統合先。サブナビは **Overview / Topics / Signals / System / Store / Events / Logs**。全サブビュー実データで実装（取得不能値は「—」・空グラフ／空リストは理由を明示）。既定表示は Overview。

- **コンテキスト帯**: 録画中は REC・run_id・経過時間、それ以外は STANDBY（`record_status` 由来の実表示）。
- **Overview ビュー**（診断ランディング・既定）: 録画コンテキスト、トピック健全性の集計（`ok`/`warning`/`danger`/`inactive` 件数＋要注意トピック名 → クリックで Topics にチャート）、発火中インシデント要約（実 alert バッファ）、`GET /api/v1/system` の簡易スナップショット、Topics/Signals へのジャンプ。
- **Topics ビュー**:
  - **チャートパネルの追加 / 削除（上限 4）**。パネル毎にメトリクス（**Frequency / Bandwidth / Max gap / Rate vs expected**）とトピック重畳（上限 6）を選択。時間窓（30s / 1m / 5m）と **Freeze charts / Live**（旧 Pause）はグローバル — 凍結はチャート限定（`Charts frozen · table still live.` を明示。テーブルは意図的に live 継続）。窓は開いてからの蓄積なので、蓄積が窓未満の間は `{window} window (n so far)` と正直に表示。チャート高さは**実測スロット追従**（固定高が overflow-hidden な親にクリップされ低値域が見えなくなる不具合の根治）。**録画の REC / STOP マーカー**を全パネルに重畳。Frequency には expected_hz の参照線。**latency / loss はメニューに置かない** — 非破壊 monitor では測れない（per-run の loss は Review の事後解析で提供）。
  - **トピック表**: discovery の全トピック＋live metrics（Hz / 帯域 / gap、status ドット `inactive`/`danger`/`warning`/`ok`/`unknown`、閾値超過時の shortfall バッジ＋理由 tooltip。shortfall は observed であり真の loss ではない）。**Rec チェックボックス列** = 次回録画の対象選択（記録途中の変更ではない）。設定済みトピックは事前チェック。機体切替で config 既定に再シード。チャートの系列選択とは独立。
- **Signals ビュー**（v1 Probe の移植）: `topic_probe` 由来の**数値フィールド**を (topic, field) 単位で重畳プロットする汎用プロッタ。トピック → 数値フィールド（配列は `[0..N]` 展開）を選び、**異トピック × 複数フィールドを重畳**。サンプルレート選択（1/5/10/30Hz・既定 10Hz）・窓・Pause。**decode は隔離コンテナ `topic_probe` が担い、録画・監視に波及しない**（[topic_probe.md](topic_probe.md)）。
- **System ビュー**（全面）: ホスト実測（CPU% / GPU% / ディスク使用量・`GET /api/v1/system`。取得不能値は「—」）＋ ROS_DOMAIN_ID・サービスエンドポイント（`GET /api/v1/config`）＋ **コンポーネント健全性**。健全性はブラウザから誠実に観測できる信号のみで表す＝ orchestrator=ライブ SSE 開通、monitor=`bridge` イベント。`bridge=null`（未報告）は connected と扱わず **checking** と表示する。recorder / streamer の個別 readiness は orchestrator の**サーバ側 `/readyz`**（Docker healthcheck 用）で判定されブラウザオリジンには露出しない旨を明記する（`/readyz` は同一オリジンに proxy されないため fetch しない）。Overview / Topics 右レールには簡易 **System カード**を埋め込む。
- **Store ビュー（v2 新設）**: `GET /api/v1/store/health` を 30 秒ポーリングして、**capture 一覧には決して現れない状態**を出す（[api_orchestrator.md](api_orchestrator.md)「ストア健全性と SUSPECT」）。
  - **SUSPECT ブロック**: 「Suspect — automatic clean-up is halted」＋理由＋ラッチした時刻。**何が止まっていて何が止まっていないかを両方明示**する（止まっている: 自動 missing 遷移・reaper・digest／止まっていない: 録画・review 保存・閲覧）。「毎パス再発火はしない。解除は repair だけ」と述べる。
  - **Repair ボタン**は SUSPECT のときだけ有効。`409 volume_unidentified` は理由付きで表示し、ボタンを無効化する。成功したら store health と captures の両方のキャッシュを無効化する。
  - **corrupt 一覧**: パス・理由・capture id と、**どのスキャン由来か**（`corrupt_source` が `reconcile` なら「reconciler pass」、そうでなければ「rebuild」）と観測時刻。空表示は 2 通りを**区別**する: 「このプロセスではまだスキャンが完走していない — これは all-clear ではない」と「直近の {rebuild|reconciler pass} は見つかった全サイドカーを読めた」。
  - **削除の可否**（`delete_available` / `delete_unavailable_reason`）: `objects/` と `.trash/` が別ファイルシステムのとき、削除系 API が `503` である理由をその場で説明する。
  - **rebuild サマリ**（`rebuilt_at` + 内訳）と **警告**、直近の reconcile 結果。
  - 全 main / solo 画面の global Store Health banner は、`rebuilt_at` を持つ正常終了した rebuild で API が `dismissible_warnings` に明示分類した**情報通知だけ**を Dismiss できる。acknowledgement は `instance_id` / `rebuilt_at` / 警告本文を identity としてブラウザの localStorage に保持し、同じ通知は画面遷移・再読込後も隠すが、後続 rebuild や異なる警告は再表示する。Dismiss は server の health・batch・capture・counter・rebuild report を変更せず、Monitor > Store の詳細も残す。`SUSPECT`、現在の corrupt sidecar、削除不可、health 取得不能、`dismissible_warnings` にない rebuild 警告は同じ操作で隠せない。localStorage を読み書きできない場合は通知を表示したままにする。
  - health の読み取り自体が失敗したら「**ストアの状態が読めなかったので、以下は何も分かっていない — これは all-clear ではない**」と出す。空白を「異常なし」に見せない。
- **Events**: SSE `alert` を **incident 単位（topic × metric）で 1 行に集約** — 発火中は `firing · since {t}` で現在値を in-place 更新、解消で `cleared · {t}`（muted）へ反転、再発火は `×n`。Overview / Topics 右レールの **Events カード**が集約表示、**Events ビュー**（全面）は topic 部分一致＋状態（firing/cleared/all）フィルタと注記（履歴は Monitor を開いてからのセッションローカル）を持つ。config ルールの無いトピックも monitor の既定 DANGER incident（持続 ~10s）で拾う = **テーブルの DANGER と Events は矛盾しない**（[topic_monitor.md](topic_monitor.md)）。
- **Logs ビュー**: 受信した SSE ライフサイクルイベント（record_status / alert / job）のセッションローカルなタイムライン（種別チップ＋テキストフィルタ、上限 ~500 のリングバッファ）。「このページを開いてから／完全なログは `docker compose logs`」と正直に表示。metrics は高頻度ノイズのため記録しない。

### Settings — 機体設定・計画

- **Robots**: 機体一覧（committed `config/<robot>/` と gitignored `config/local/<robot>/`）と選択（`POST /api/v1/config/select` で recording / stream を hot-swap。recorder QoS / monitor expected_hz は再起動後 — UI にもその旨を表示。**録画中のアクティブ化は「Stop and switch?」確認モーダル**）。**非アクティブ機体は read-only で設定を閲覧可能**（`GET /api/v1/config/robots/{robot}`。「Read-only — {robot} is not the active robot.」バナー＋雛形として読める disabled JSON）。アクティブ機体には手動の **Setup check** を置く（`POST /api/v1/system/setup-check`）。画面表示や録画終了では自動実行せず、ボタン押下時だけ recorder 前提条件・ROS topic coverage・monitor 受信 / 解決済み QoS・camera preview を読み取り専用で確認し、blocker / warning ごとに次の行動を常設表示する。「monitor が 1 sample 以上受信」は payload 妥当性の証明ではない旨も明記する。**aspect**（recording / stream / validation / validators）の option 選択。recording config は JSON で編集・永続化（`PUT /api/v1/config/recording`。**インライン検証**: 不正 JSON は Save 無効＋平易エラー。録画中の保存は「次の録画から適用」の情報バナー）。stream config も同型の JSON エディタで編集・永続化（`GET/PUT /api/v1/config/stream`。**`panes` が Collect のカメラペインへ即時反映**され、保存ノートは `columns` が現行レイアウトでは未使用であることも正直に述べる。config dir の無い機体はエディタでなく理由の説明文。**存在するのに読めないファイルは「壊れている・保存は置換」の amber 警告で開示**（絶対に無言で空 `{}` として見せない）。サーバ側が変わった場合は未保存編集を保持したまま amber バナーで開示）。機体の新規作成は不可 — `+ Add robot` は消えるトーストでなく**次の一歩を示す常設 explainer**（`config/<robot>/` フォルダ作成＋既存機体の雛形参照）を開く。レール下部は出典の無い版数表示を廃し **active robot の実値**。
- **Projects & tasks（Plans）**: Project / Task / Condition の定義を編集。Collect のピッカーと**共有ストア**で即時反映し、**サーバーに永続化**（`PUT /api/v1/plans`。2026-07-14 — 全端末で単一のラベル語彙を共有。オフライン時は localStorage が立ち dirty 編集は後で再 push。Plan の**モデル化**（id/参照/目標本数）は引き続き Phase 2.5）。名前は trim 後の空白と同一 scope の大小文字違い重複を PUT 前に拒否し、成功表示しない。Task / Condition 削除は Collect picker から消える範囲と既存収録ラベルが残ることを確認し、Cancel できる。
- **Failure shortcuts（Task 単位、2026-08-23）**: 各 Task は LEFT / CENTER / RIGHT の 3 スロットに**共有 Failure reasons 語彙**から理由を割り当てられる（Collect の外部オペレータアクションが Failure 選択後に保存する高速パス。語彙自体は 3 件に制限されない）。スロットは未割り当てのまま置いてよく、**同じ理由が同一 Task の 2 スロットには置けない**（UI は他スロットで使われた理由を disabled にし、サーバも 422 で拒否）。`failure_shortcuts` を持たない旧カタログは未割り当てとしてそのままロードされる（migration 不要・読み取り時に正規化）。
- **External controls（設置共通、2026-08-27）**: Collect の状態ごとに LEFT / CENTER / RIGHT を上記の状態安全な action または `None` へ割り当てる。UI は他 channel に割り当て済みの action を disabled にし、サーバも未知・状態外・重複 action を 422 で拒否する。変更は shared plan catalog の同じ CAS / dirty / conflict 経路で全端末へ反映し、失敗時は「このブラウザだけ」を表示する。不正な local/server 値は実行せず安全な既定値を使い、Settings に回復方法を表示する。Reset to default で明示的に既定へ戻せる。物理デバイスは前提にせず、3 つの論理入力を送れるキーボード・マクロパッド・プログラマブルペダルを同等に扱う。
- **Audio（端末単位、2026-08-27）**: master / Sound / Voice を独立設定し、イベント行ごとにも Sound / Voice を切り替える。Sound と Voice は別々の preview 操作とし、Sound の Web Audio player はスケジュール直後に close せず Audio 画面の unmount まで保持する。Voice は単一の local Kokoro 82M（英語・日本語、Apache-2.0）で、UI は language ごとの話者と `0.75..1.25` の話速を選べる。短い定型文には sidecar が終端句読点を補い、日本語は表示用の漢字をそのまま読み上げる。voice の作成は `Prepare voice assets` を明示したときだけで、language / voice / 話速 / failure-reason 語彙を変えると旧 asset を無効化し、同ボタンで更新する。recorder が `armed` / `recording` / `stopping` の間、recorder state を読めない間、または録画開始が作成を preempt した場合は作成を延期し、停止後に再試行する。engine unavailable、作成時の phrase 単位 failure、voice service 到達不能、browser blocked を status で区別し、いずれも Sound-only と Collect 継続の回復可能性を示す。Preview は user gesture を兼ねる。Audio は任意の補助であり、外部クラウド TTS、他端末への設定・asset 同期、録画中の TTS 作成は提供しない。旧 eSpeak / VOICEVOX の保存済み話者と asset は初回読込時にKokoro既定話者へ安全に移行し、再prepareを要求する。評価根拠は日本語漢字・英語の実モデル WAV 生成、話者/話速変更の request・cache identity test、engine 不在/録画優先の回復経路に対する expert review であり、代表利用者による聴感評価は未実施である。
- **Operators**（2026-08-05）: 帰属ロスター（**認証ではない** — パスワードも権限も持たない）。名前を登録するとヘッダの OP チップが**自由入力からピッカーに変わり**、完全名を常時可視にする（initials / tooltip のみは禁止）。ロスターが非空の間は**名前を選ぶまで録画を開始できない**（unknown_operator と表記ゆれの根絶）。空にすると従来の自由入力に戻りゲートも外れる。空白・大小文字違い重複は拒否し、削除は影響説明付き確認を通す。`PUT /api/v1/plans` の `operators` で全端末共有。
- **Failure reasons**（2026-08-04）: Collect が Failure 時に出す「What failed?」チップの語彙を追加・改名・削除する。Plans と同じ共有ストア/サーバ永続（`PUT /api/v1/plans` の `failure_reasons`）で全端末が同じ選択肢を持つ。空白・大小文字違い重複は PUT 前に拒否し、削除前に今後の選択肢だけが変わり既存ラベルは残ることを確認する。**最後の 1 件は削除不可**（Failure ラベルは理由必須のため、空語彙はフローを詰ませる）。編集が変えるのは**今後のラベルだけ** — ラベル済みエピソードは保存済み文字列を保持する。**参照しているタスクのショートカットが stale にならない**よう語彙編集と連動する: 理由を改名すると参照するスロットも**新しい名前に追従**し、削除すると該当スロットを**未割り当てにしてその旨を通知**する — どちらも語彙＋plans を**同一の catalog 編集**（1 回の PUT）で行うため、サーバが拒否する中途 state を永続化しない。
- **Recording**: アクティブ機体の recording config を**フォーム優先**で表示（`GET /api/v1/config/recording`：compression / start gate〔`start_paused`〕/ cache〔`max_cache_size_mb`〕と default_topics 表〔expected Hz・QoS override バッジ〕）。生 JSON エディタは「Advanced」に格下げ（既定折りたたみ・`PUT /api/v1/config/recording`）。
- **Data quality**: `GET /api/v1/config/robots/{robot}` の aspects 内容から、expected Hz 参照レート＋ monitor の warn/danger 閾値（`monitor.warn_shortfall`/`danger_shortfall`）＋アクティブ validation テンプレートの必須トピックを表示（読み取り専用カード）。その下に**アラート規則エディタ**（`GET/PUT /api/v1/config/alerts` → `config/<robot>/monitoring/alerts.yaml`。反映は monitor 再起動時＝UI に明記）。**フォームと Advanced 生 YAML は同一ファイルの 2 編集面なので相互ガードする**（2026-08-04 のバグ修正: raw 側に未保存編集がある間はフォーム Save を理由表示付きで無効化〔従来はフォーム状態を黙って書いて raw 編集を消失させ、しかも画面には未送信の raw が残って保存済みに見えた〕。Save YAML はテーブル側の未保存編集を破棄する旨を明示。保存成功時は両ビューを**サーバ応答から強制再シード**する — キャッシュと同一内容の応答では effect が発火しないため）。旧 Signals 既定表示エディタは Review 波形チャートの撤去（2026-07-15）と同時に削除。
- **Validation**: validation / validators aspect 選択（`POST /api/v1/config/select`）＋ワンクリックプリセット一覧（`GET /api/v1/validation/presets`・pending 件数）。実行は Validation タブへリンク（1 機能 1 箇所）。
- **System**（読み取り専用）: デプロイ事実（ROS_DOMAIN_ID・エンドポイント・data dir/storage・コンポーネント健全性）。誠実な version ソースがクライアントに無いため version 行は省略。RMW/DDS は API 非露出のため注記のみ。
- **Appearance**（端末・ブラウザ単位）: System / Light / Dark を選ぶ。既定は System で、`prefers-color-scheme` を追従し、System 中の OS / browser 設定変更にも追従する。Light / Dark はその選択を上書きする。選択は browser の localStorage にだけ保存して即時適用し、起動時は React の前に解決済み theme を document へ適用して light flash を避ける。browser storage が利用できない場合も現在の page には適用するが、reload 後に再選択が必要なことを UI に明示する。これは presentation preference だけであり、録画・backend・shared catalog・store state を変更しない。
- **Language**（端末・ブラウザ単位）: Settings > General で English / 日本語を選ぶ。`kairos.locale` に保存して即時反映し、`document.documentElement.lang`、共有 shell の文言、共有の日時・数値・リスト・count 表示は同じ選択ロケールを正本として再描画する。英語を fallback とし、resource は `common` / `collect` / `review` / `datasets` / `validation` / `monitor` / `settings` の安定 namespace に分け、各 locale の key shape をテストする。`navigator.language` は UI 言語の入力に使わない（POSIX 形式を修復する `localeGuard` は third-party `Intl` の互換性だけを担う）。選択中に Collect / Review / Datasets の React state、録画、backend、shared catalog を reset・変更しない。browser storage が使えない場合も当ページでは切替え、reload 後に再選択が必要なことを status で示す。ユーザーが作成した Project / Task / Condition / Operator / dataset 名や server の生診断は翻訳せず、Kairos が所有する周辺ラベルだけを翻訳する。全画面の本文移行は follow-up で段階的に行う。
- **semantic color tokens**: `index.css` の CSS variables と Tailwind semantic utilities が app / surface（card・muted・elevated・control）/ text / border・interaction / accent・focus・modal scrim、ならびに success / warning / danger / info / live / recording / paused / adopted / needs-review / excluded / suspect の background・border・text・accent を定義する。Light / Dark は両方の値を必ず持つ。共有 shell・Card・Button・Modal・Badge はこの layer を使い、残りの各画面の literal palette utility 移行は follow-up とする。状態を色だけで表すことはせず、既存の label・icon・text が意味の正本である。
- **honest placeholder**: **Dataset profiles**（Phase 3 の recipe モデル待ち）と **Users & permissions**（同一 LAN・無認証スコープのため管理対象なし）は、理由を述べる placeholder のみ（dead な操作は置かない）。

## データフロー（SSE × キャッシュ）

- 単一の SSE ストリーム（`GET /api/v1/events`）を購読し、イベント種別ごとに TanStack Query キャッシュへ反映する。コンポーネントはキーを購読して再描画。
- SSE 切断は UI（ヘッダの接続チップ）に明示し、自動再接続する（`Last-Event-ID`）。
- **鮮度の規律**（2026-08-11, sweep S3-5/S3-6）: (a) `record_status` の SSE イベントは、**status ポーリングが失敗している間はキャッシュへ適用しない**（`setQueryData` は query のエラーを消し `dataUpdatedAt` を今に進める＝到達不能な recorder を「新鮮」に蘇生してしまう。再接続後のリプレイは分オーダー古い可能性がある。イベント自体はログに残す）。(b) Monitor の Topics テーブルは、SSE が open でない・monitor bridge が down のとき**実測列を出さない**（凍結スナップショットを現在値として描かない。Collect の system card と同じゲートで、理由の注記を出す）。
- **ジョブ watcher のイディオム**（sweep S3-4）: 「terminal を検知したら result を fetch して setState」は **queryFn の中に書かない** — 2 タブがキャッシュを共有すると、先に fetch した側しか setState が走らず、残りは成功したジョブに恒久スピナーを出す。status の queryFn は純粋に保ち、終端処理は観測した state に対する effect で行う（共通フック `useJobCompletion`）。

## 出力（呼ぶ API）

- 記録: `POST /api/v1/record/prepare` / `start` / `stop`、`GET /api/v1/record/status`
- Batch: `POST /api/v1/batches`、`PATCH /api/v1/batches/{id}`、`GET /api/v1/batches?status=active`、`GET /api/v1/batches/{id}`
- **Capture**: `GET /api/v1/captures`（フィルタ・カーソル）、`GET /api/v1/captures/{id}`、`PATCH /api/v1/captures/{id}/review`、`POST /api/v1/captures/{id}/delete`、`GET /api/v1/captures/{id}/archive/config`、`POST /api/v1/captures/{id}/archive`
- **データセット（論理）**: `GET/POST /api/v1/datasets`、`GET/DELETE /api/v1/datasets/{dataset_id}`、`POST /api/v1/datasets/{dataset_id}/members`、`DELETE /api/v1/datasets/{dataset_id}/members/{membership_id}`
- **ストア**: `GET /api/v1/store/health`、`POST /api/v1/store/repair`
- 転送 / 保持期間: `GET /api/v1/transfer/status`、`POST /api/v1/transfer/pull`、`GET /api/v1/retention`
- Topic / システム: `GET /api/v1/topics`、`GET /api/v1/topics/status`、`GET /api/v1/events`（SSE）、`GET /api/v1/system`、`POST /api/v1/system/setup-check`
- 設定: `GET /api/v1/config`、`GET/PUT /api/v1/config/recording`、`GET/PUT /api/v1/config/stream`、`GET /api/v1/config/options`、`POST /api/v1/config/select`、`GET /api/v1/config/robots/{robot}`、`GET/PUT /api/v1/config/alerts`、`GET/PUT /api/v1/plans`
- ファイル: `GET /api/v1/files/{path}`（video_check mp4・ジョブ artifacts の画像/ファイル）
- ジョブ: `GET /api/v1/pipelines`、`POST /api/v1/jobs`（`{ capture_id, pipeline, params }`）、`GET /api/v1/jobs/{id}/status`、`GET /api/v1/jobs/{id}/result`、`GET/POST /api/v1/validation/templates`、`GET /api/v1/validation/presets`
- **呼ばなくなったもの**: `/api/v1/runs` 系・`/api/v1/episodes` 系・`/api/v1/datasets/{op}/{task}/{index}`・`/api/v1/datasets/export(-all)`（すべて廃止。互換エイリアスは無い）
- プローブ（orchestrator 経由でない直接接続はこの 2 系統のみ）: `/probe`（topics / fields / SSE サンプルストリーム）、`/webrtc`（offer / ICE）

## 設計方針

- **正直原則**: 測れないものは表示しない（latency / loss の偽装禁止・shortfall≠loss）。値をでっち上げない — 取得できない値・未実装の判定は「—」やモック明示で示す。品質（quality）とタスク結果（task result）を混同しない。**「読めなかった」を「異常なし」に見せない**（Store health の空表示・Availability の unknown）。
- **失敗はその操作の言葉で説明する。** エラーメッセージは「何が起きたか」ではなく「あなたのその操作がどうなったか」を述べる（`Not saved.` / lease 所有者を名指しした `capture_busy`）。破壊的操作の失敗は消えるトーストにしない。（分割 discard のトースト文言は「a copy may remain on the robot」— 確定 split と probe 未回答の両方で真になる表現。）
- **fetch 層のデッドライン**（2026-08-11, sweep S3-8）: 全リクエストに既定 30 秒の deadline（`AbortSignal.timeout`）。半開 TCP が「どの画面でも終わらないスピナー」になるのを防ぐ。サーバ側予算が長い呼び出しは個別に上書きする — `record/stop` 90s（recorder のエスカレーション ~75s を client 側で切らない）、`record/start` / `prepare` 60s（config 導出予算）。
- **split プローブは 1 本・開示は fail-safe**（sweep S3-7）: `/transfer/status` の probe は共有フック 1 つ（60s stale・リトライあり。失敗が再マウントまで「単一ホスト」として固着しない）。**機能ゲート**（転送 UI）は `available === true` のみで有効化し、**§12 の破壊的ダイアログの開示**（「ロボット側にコピーが残りうる」）は逆向きに倒す — 確定した単一ホストの答えだけが注記を抑止し、未回答・失敗中は表示する（`useRobotCopyMayRemain`）。
- **pre-arm の失敗は隠さない**（sweep S2-7）: prepare の連続失敗（2 回以上）は Ready カードに amber で表示し（Start は同期フル起動へフォールバックするので塞がらない）、リトライは 30s から指数バックオフ（上限 5 分）。recorder 側はこの失敗を capture として filed しない（→ capture_store §3.4）。
- **非侵入**: 監視表示は monitor の raw / no-decode + best_effort 由来。ペイロード decode は `topic_probe` に隔離。
- **画面あたりの image subscription 予算**: プレビューはタブ表示中のみ購読し離脱で解放、サブカメラは低解像度強制、集約値カード（System 等）は orchestrator の API 値のみで新規 subscription を作らない。同時フル解像度は 1 本まで。
- 実パスを持たない / pipeline をハードコードしない / schema・設定は backend が渡す。
- エンドポイントは `GET /api/v1/config` 取得完了まで描画を待つ（render gate）。ハードコード fallback は dev のみ。
- 記録中は危険操作（二重 start、topic 変更）を抑止する。破壊的操作（Discard / Delete / Reset / End early）は確認モーダル＋Cancel を必ず持つ。
- 時系列チャートは uPlot に統一。
- 共有設定は [config](config.md)。

## TBD 一覧

- Quick check の実判定（2 層設計は確定・Phase 3）／Advice 生成ロジック（Phase 3）
- Dataset Recipe・Build（Phase 3）
- Validation lifecycle（Experimental → Standard）の実体化
- split の replica 管理の完成（ロボット側コピーの receipt / drop-local。現状の discard は「録画 PC 上のコピーの破棄」に留まり、UI はそれを但し書きで正直に述べている）
- Session 階層・Plan モデル化（id/参照/目標本数 — カタログ自体のサーバー保存は 2026-07-14 に実装済み）・Batch Pause のサーバー化（Phase 2.5）
- アクセシビリティ（WCAG 2.2 AA）
