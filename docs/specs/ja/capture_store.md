# capture store 仕様（v2）

> ステータス: 設計確定（**v2**、`feat/capture-store` で実装済み）。日本語が正本（これを正とする）。英語版 `docs/specs/en/capture_store.md` は自動生成ミラー（直接編集しない）。**認証は不要。**

収録データの**同一性・配置・耐久性**を定める、サービス横断の正本。recorder が書き、orchestrator が索引し、dora_runner が読み、frontend が見せる — その全員が同じ 1 つの規約に従う。個々のサービスの API・画面は各仕様（[rosbag2_recorder](rosbag2_recorder.md) / [api_orchestrator](api_orchestrator.md) / [dora_runner](dora_runner.md) / [frontend](frontend.md)）にあり、本書はそれらが共有する**土台**だけを述べる。

**alpha 版につき後方互換・migration は持たない。** v1 のデータ（`recorded/<run_id>` 木・`data/<operator>/<task>/<NNN>` 木・`data/index.jsonl`・v1 形式の `lifecycle.jsonl`）は読まない。以後のスキーマ変更も migration ではなく **rebuild で吸収**することを第一選択とする。ただし「安全原則」（後述）は破壊的変更の対象外とする。

## 中心にある主張

1. **kairos.db は捨ててよい。** 収録の正本はディスク上のサイドカーであり、DB はその索引・キャッシュにすぎない。DB を削除して再起動すれば、サイドカーと lifecycle ledger から全件再構築される。
2. **黙って消えない。** 外部の `rm -rf` は削除ではない。削除は必ず ledger に記録され、行（墓標）は残り、消えたコピーは警告として表面化する。
3. **録画は他の何にも依存しない。** ディスクが満杯でも、ledger が書けなくても、DB が壊れていても、録画の start / stop だけは動く。

## 1. ID 体系

| ID | 形式 | 発行者 | 用途 |
|---|---|---|---|
| `capture_id` | UUIDv7（小文字・ハイフン付き） | recorder（`prepare` / `start` 時）。**取り込んだ外部 bag は orchestrator が claim 時に発行** | **グローバルな同一性**。パス・DB 主キー・サイドカー・API のキー |
| `source_instance_id` | UUIDv4 | 初回起動時に `<data_dir>/instance.json` へ | インストール（＝この kairos 設置）の同一性 |
| `run_id` | `run_YYYYMMDD_HHMMSS(_N)` | recorder | **表示名専用。** API のキーには使わない |
| `event_id` | UUIDv7 | ledger 書き込み側 | lifecycle イベントの冪等キー |
| `batch_id` | `batch_YYYYMMDD_HHMMSS` | orchestrator | 収録セッション単位 |
| `membership_id` / `dataset_id` | UUIDv7 | orchestrator | dataset member / 論理 dataset |

- UUIDv7 は `kairos_common.ids` の自前実装（RFC 9562: 48bit unix-ms + `rand_a` / `rand_b`）。**時刻順に並ぶ**ので、ID 順のソートが収録順のソートになる。
- `run_id` を表示名に降格したのが v2 の出発点。人が読む名前と、パス・外部キーになる識別子を分けることで、「同じ run_id が別ホストで衝突する」「表示名を直すとパスが壊れる」の両方が消える。
- `instance.json`: `{"schema_version": 2, "instance_id": "…", "created_at": "<ISO8601>"}`。排他作成（`O_EXCL`）＋ fsync で書き、**存在すれば再生成しない**。壊れていた場合は**起動を失敗させる**（新しい id を振ると、既存の replica 行とサイドカーが全部孤児になるため）。

## 2. ストレージレイアウト

```
<data_dir>/
├── objects/<capture_id>/              # 録画の実体。task/operator/番号をパスに含めない
│   ├── <capture_id>_0.mcap …         # rosbag2 出力（split 時は連番）
│   ├── metadata.yaml                  # rosbag2 生成物。kairos は変更しない
│   ├── object_manifest.json           # §3
│   ├── record.json                    # §4（未 review なら存在しない）
│   ├── quick_check.json               # §4.2（停止時の verdict。未 settle なら存在しない）
│   └── recorder.log                   # finalise 後にここへ移動
├── objects/<capture_id>.failed.json   # bag が生まれなかった失敗 start（§3.4）
├── objects/<capture_id>.qos.yaml      # 録画中の一時ファイル（sibling）
├── .incoming/<capture_id>/            # import / 転送の staging。objects/ と同一 FS 必須
├── .trash/<capture_id>/               # 削除の中間状態（§7）。objects/ と同一 FS 必須
├── views/                             # 生成 symlink 木（§6）。全消し再生成可
├── report/<pipeline>/<capture_id>/    # dora_runner 成果物
├── exports/<name>/                    # LeRobot export の成果物（§6.2）。派生物・再生成可
│   └── (exports/.staging/<export_id>/ # 変換入力の symlink staging。ジョブ終了で消える)
├── catalog/                           # validation_templates / plan_catalog の sidecar 二重化
├── lifecycle.jsonl                    # §5
├── instance.json                      # §1
├── .ledger-slack                      # ENOSPC 用に予約した 1MB（§5）
├── .kairos-volume-id                  # ボリューム識別マーカー（§9-3）
└── kairos.db                          # サイドカーから全再構築可能な索引
```

- **パスに意味を持たせない。** capture のディレクトリ名は `capture_id` だけで、operator・task・番号は入らない。ラベルを直すたびにファイルを動かす必要がなくなり、「移動の途中で電源が落ちた」という状態が構造的に消える。
- **予約名**（`data_dir` 直下）: `objects` / `views` / `.trash` / `.incoming` / `report` / `exports` / `catalog` / `lifecycle.jsonl` / `instance.json` / `kairos.db`。これらと衝突する名前は **dataset 作成時**（`POST /api/v1/datasets` の `name` / `operator` / `task`）に `400 reserved_name` で拒否する — その 3 つは `views/` のパス構成要素になるので、衝突するとストア自身のレイアウトを踏む。録画時の operator / task はパスにならないため、この検査の対象ではない。
- **廃止**: 旧 `recorded/`、`<operator>/<task>/<NNN>` の 3 階層データセット木、`data/index.jsonl`。
- **不変条件**: 完全でない capture ディレクトリが `objects/` 直下に現れるのは「**recorder が現在書いている live capture**」だけ。import・転送は必ず `.incoming/<capture_id>` に完成させてから `os.replace` で `objects/` へ入れる。したがって `objects/` に見えている（かつ live でない）ディレクトリは、常に完全なコピーである。
- **起動時検査**: `objects/` と `.trash/` と `.incoming/` の `st_dev` 一致を検証する。不一致（`os.rename` が `EXDEV` になる構成）なら**削除・archive は要求ごとに `503 delete_unavailable` を返す**。ルート自体は登録されたまま残り、消えるのではなく**理由を述べて断る** — その理由は `GET /api/v1/store/health` の `delete_unavailable_reason` にも出るので、operator は「ボタンが無い」ではなく「なぜ使えないか」を読める。copy + delete への暗黙のフォールバックは禁止 — 「アトミックな移動」を約束しておいて実際には途中まで消える、という挙動を作らないため。
- `objects/` と `.trash/` のルートは host-writable（recorder が作成時に緩める）。compose の前提は recorder = root、orchestrator / dora_runner = uid 1000。
- `make backup` は `.trash` と `.incoming` を除外する（中間状態をバックアップに固めない）。

## 3. `object_manifest.json` v2

recorder が書く**監査記録**。v1 の `manifest.json` + `session.json` を 1 本に統合したもの（2 ファイルに散っていた「1 つの録画の事実」が食い違う余地を無くす）。

```jsonc
{
  "schema_version": 2,
  "capture_id": "…", "source_instance_id": "…", "run_id": "run_…",
  "state": "recording|stopping|completed|interrupted|failed",
  "operator": …, "task": …, "robot": …,
  "started_at": "<ISO8601>", "ended_at": "<ISO8601>|null",
  "topics": [ { "name": …, "type": …, "qos": … } … ],
  "message_count": N|null, "bytes": N|null,
  "compression": …, "split": …, "dropped_messages": N|null,
  "integrity": "ok|dropped|failed|unknown", "error": str|null,
  "digest_state": "pending|complete",
  "files": null | [ { "path": …, "size": …, "sha256": … } … ],
  "manifest_digest": null | "sha256:…",
  "digest_sealed_by": null | "<instance_id>"   // 封印した instance（§10。旧 manifest は null）
}
```

- 契約に無いフィールドは `extra` として保持し、書き戻し時に再出力する（新しい recorder が足したフィールドを、古い digest ジョブが黙って落とさない）。
- 読み取りの結果は **`ok` / `missing` / `corrupt` の 3 値**で返す。0 バイト・パース不能な manifest を「存在しない」と読むことは禁止（→ §8 rebuild 規則 4）。

### 3.1 atomic write の定義（全サイドカー共通）

tmp へ書く → flush → **`fsync(tmp)`** → `os.replace` → **親ディレクトリを `fsync`**。実装は `kairos_common.atomic_io` の共通ヘルパ 1 本で、ledger の append も同じ規律に従う。

root 所有のファイルでも tmp + replace なら uid 1000 から更新できる（in-place の `open` は `EACCES`）。digest ジョブが root 所有の manifest を封印できるのはこの経路のため。

### 3.2 `manifest_digest`

`files` を `path` 昇順に並べ、`f"{path}\n{size}\n{sha256}\n"`（**空白を入れない**）で連結した UTF-8 列の sha256。`sha256:` を前置する。正典実装は `kairos_common.capture_sidecars.manifest_digest`。

### 3.3 単一書き手の引き渡し

- finalize（`state ∈ {completed, interrupted, failed}`、`digest_state=pending`）までは **recorder が唯一の書き手**。
- 以後は **orchestrator（digest ジョブ）が唯一の書き手**となり、`files` / `manifest_digest` / `digest_state=complete` を**単一の atomic write で 1 回だけ**書く。以後の書き込みは全面禁止で、reconciler は上書きせず CORRUPT として報告するだけ。
- recorder のクラッシュ復旧走査は `state ∈ {recording, stopping}` の manifest **のみ**を対象とし、それ以外の manifest には触れない。
- ただし **manifest がまだ無い `objects/<id>/` は別の経路**で拾う。それは recorder 自身が放棄した arm / start にしかなりえない（`.incoming` 経由でしか他所からは入って来ないため）ので、recorder は起動時にそれを自分のものとして分類する: **bag があれば `state=interrupted` の manifest を合成**し、**空なら兄弟ファイルごと削除**する。これが無いと、armed のまま落ちた capture のディレクトリが manifest 無しで永久に残り、rebuild からは「壊れている」とも「無い」とも言えない対象になる。
- 取り込んだ外部 bag は `operator` / `task` を `null` とし、`imported_from` / `imported_at` を追加する。

### 3.4 失敗 start（`objects/<capture_id>.failed.json`）

bag が 1 バイトも生まれなかった start は、ディレクトリではなく**兄弟ファイル**を残す（「`objects/` 直下のディレクトリ＝バイトが書かれた」という不変条件を守るため）。§3.1 のヘルパで書き、**書き込み失敗を握り潰さない** — error ログに加えて、start のエラーレスポンス（`507`）に失敗内容を含める（`failed_start_record_error`）。

rebuild はこのファイルも読み、`state='failed'` の行を作る。削除系・reaper は capture の兄弟ファイル（`.failed.json` / `.qos.yaml`）も対象にする。

**例外: 失敗した `prepare`（pre-arm probe）は filed されない**（2026-08-11, sweep S2-7）。prepare はコンソールが 30 秒ごとに繰り返す背景の keep-alive であり、operator の記録操作ではない。恒久的な arm 阻害（topic 不一致・disk full）があると、旧仕様では **30 秒に 1 つ** `.failed.json`＋failed 行が積み上がり、画面には何も出なかった。今は recorder が prepare 失敗にサイドカーを書かず（一時ファイルは掃除）、orchestrator も行を作らず、失敗はエラー応答としてコンソールへ返る — Collect が「pre-arm failing」を表示し、リトライは指数バックオフする。operator の `start` の失敗は従来どおり必ず filed される。

> **実装上の注意（E2E §13-4 が発見）**: 失敗 start のサイドカーは、型の discovery が終わる前の topics を記録するため `type` が明示的な `null` になりうる。rebuild はそれを忠実に行にするので、`null` を受け付けない API モデルがあると **`GET /api/v1/captures` 全体が恒久的に `500`** になる（行が DB に残るため再起動でも直らない）。`null` は「未 discovery」＝空文字列に正規化する。

## 4. `record.json`（Review 状態のサイドカー・可変）

```jsonc
{ "schema_version": 2, "capture_id": "…",
  "revision": N,                          // 1 始まり。未 review = ファイル無し & DB review_revision=0
  "task_result": "success|failure"|null, "failure_reason": str|null,
  "quality": …|null, "quality_source": "operator|quick_check",
  "review_status": "pending|adopted|excluded",
  "batch_id": str|null, "index_in_batch": N|null, "updated_at": "<ISO8601>",
  "labels": { "operator"?: str, "task"?: str, "robot"?: str } }  // 任意・§4.3
```

**review 系フィールドは `record.json` が正、DB はキャッシュ。** これが「kairos.db を消して再起動できる」ことの担保。

### 4.1 保存手順（capture 単位の mutex を 1〜3 全体で保持）

1. `captures.review_revision` を読み、リクエストの `base_revision` と不一致なら **`409`**。読む前に、`record.json` が行より進んでいれば**サイドカーを行へ取り込む**（§4.1-4 と同じ規則を capture 単位で適用）。取り込まないと、次の 2 のガードが「行が追いつけないまま永久に拒否する」状態を作る。
2. `record.json` を `revision = base_revision + 1` で atomic write。ただし**ディスク側も compare-and-swap**: 現に置かれている `record.json` の `revision` が `base_revision` でなければ書かずに **`409`**（読めない・存在しないファイルは守るべき決定を持たないので従来どおり上書きする）。失敗 → **`500`、DB は無変更**（部分的な効果はサイドカー先行のみ＝安全な向き）。
3. `UPDATE captures SET …, review_revision=? WHERE capture_id=? AND review_revision=?`（CAS）。`rowcount=0` → **`409`**。このとき**書いたサイドカーを勝者の行から書き直す**（同じ `revision` のまま値だけ勝者のものへ）。2 のガードは read-then-write の隙間を塞ぎきれないため、DB を裁定者として最後に必ずディスクを一致させる。
4. 乖離規則: rebuild / reconciler は `record.json.revision >= DB` ならサイドカーを採用。逆向き（DB > サイドカー）は黙って直さず**警告として表面化**する。

- 2 と 3 が対で必要な理由: サイドカー先行だけを守ると、**別プロセスの orchestrator に負けた保存が勝者の `record.json` を上書きしたまま残る**。§8 は `kairos.db` をサイドカーから作り直すので、索引を捨てた瞬間に **`409` で拒否したはずの判断が採用**される。CAS は API の中でだけ成立していて、復旧手順がそれを取り消す。
- 「DB をロールバックする」とは言わない（sqlite3 + ファイルの組では約束できない）。約束するのは「**ディスクと DB は、どちらが先に進んでいても、同じ 1 つの判断に収束する**」こと。
- グローバルなロックはこの用途に使わない（fsync をまたいで全リクエストを直列化してしまうため）。
- **システム由来の書き換え**（quick_check 確定後の quality 再導出）も同じ経路を通り `revision` を進める（`quality_source=quick_check`）。その結果クライアントが `409` を受けるのは**正しい挙動**。
- 旧 `POST /episodes` が持っていた副作用（`batches.episodes_recorded` の単調加算・auto-pull の起動）は、「**その capture への初回 review 保存**」へ移設した。

### 4.2 `quick_check.json`（停止時 verdict のサイドカー）

停止時に orchestrator が下す quick_check の verdict を、`objects/<capture_id>/quick_check.json` に
**settlement が行より先に**書く。中身は API の `quick_check` オブジェクトそのまま（`verdict` / `layer0` /
`layer1` / `elapsed_ms`）。**未 settle なら存在しない。**

**3 つ目のサイドカーである理由**: `object_manifest.json` は recorder が「何を書いたか」を述べるファイル、
`record.json` は operator の review。quick_check は**どちらでもない** — orchestrator 自身が sealed bag を
測った結果である。とくに `record.json` には入れられない: §4 は revision 0 を「`record.json` が存在しない」と
綴っており、settlement は通常**最初の review より前**に走るので追記する先が無い。revision 1 で新規作成すれば、
operator の最初の Save（`base_revision: 0`）が CAS に落ちる。

**rebuild はこのファイルから復元する。** 無ければ `null`（＝未実施と同じ表示）で、**でっち上げない**:
rebuild 時に bag を測り直せば、それは古い時刻を名乗る新しい測定になる。よってこのサイドカーより前に
収録された capture の verdict は**戻らない** — migration は持たない（§8 の方針どおり rebuild で吸収）。
壊れて読めない場合も `null` 扱いで、capture 自体は失わない（派生物のために本体を捨てない）。

書き込みに失敗しても settlement は続行し、行には verdict が入る（警告をログに出す）。失うのは
「rebuild を越える永続性」だけで、operator が待っている verdict を止める理由にはならない。

### 4.3 ラベル編集（`operator` / `task` / `robot`）

review が書ける列は **measurement と label の区別**で決まる。

- **measurement は不可** — `bytes` / `message_count` / `topics` / `started_at` / `ended_at` / `state` は
  recorder が観測した事実であり、review では触れない。編集すると封印済み manifest と索引が食い違い、
  §8 は manifest から rebuild するので**その編集は黙って巻き戻る**。正直に提供できる操作ではない。
- **label は可** — `operator` / `task` / `robot` は人間による記述であり、review が書ける。
  これを可能にしたのは**取り込み bag**である: ラベルを持たずに生まれる（記録した人がいない）ので、
  後から人が付けるしか手が無い。通常録画の「operator が間違っていた」も同じ操作で直る。

**manifest は絶対に書き換えない。** override は `record.json` の `labels` ブロックに置く。これが
「編集された」という事実をディスク上に残し、かつ**編集を取り消せば録画時の値に戻る**ことを可能にする。

- **キーが無い = override 無し。** 「クリア」は null を書くのではなく**キーを消す**ことで表す。
  「override されていない」の綴りを 1 つに保つため。空文字・空白のみも同様にクリアとして扱う
  （空白のラベルはラベルではなく、manifest の値を隠すだけの override になる）。
- **`labels` は閉じた集合。** 上記 3 キー以外は `record.json` を **CORRUPT** として報告する（§8 rule 4）。
  自由記述の注釈置き場に育てないため。ただし値の `null` は「override 無し」として**受理する** —
  PATCH の綴りと同じ言葉でサイドカーを壊せてはならない。
- **rebuild は manifest を読んでから `labels` を上に適用する。** 順序がこの設計の全部で、
  逆にすると編集は rebuild のたびに消える（→ §8）。
- **`views/` は追随する。** `views/` は operator/task で束ねるが、dataset がそれらを持たないとき
  **capture の値にフォールバックする**（`COALESCE(d.operator, c.operator)`）。したがって
  operator/task の編集は再生成をスケジュールする。`robot` はパス構成要素ではないので何も起きない。
- **パス安全性**: `/` `\\`・制御文字・`.` / `..` は **`400 unsafe_label`**、255 バイト超は
  **`400 label_too_long`**。dataset 側のラベルが `sanitize_component` で書き換えられる既存挙動は
  変更しない（新しい入口だけ、書き換えでなく拒否にする — 入力した本人がその場に居るため）。

## 5. `lifecycle.jsonl` v2

```jsonc
{ "schema_version": 2, "event_id": "<uuid7>", "source_instance_id": "…",
  "kind": "…", "capture_id": "…"|null, "at": "<ISO8601>", …kind 別 payload }
```

| kind | payload |
|---|---|
| `capture_discarded` / `capture_deleted` | 墓標。理由等 |
| `capture_archived` | `destination` / `run_id` / `operator` / `task` / `bytes` / `message_count` / `files: [{path,size,sha256}]`。dataset archive の member として書かれた場合は `dataset_id` / `membership_id` / `display_index` も（§6.1） |
| `dataset_created` | `dataset_id` / `name` / `operator` / `task` |
| `dataset_updated` | `dataset_id` / `name` / `operator` / `task`。**差分ではなく変更後の完全なラベル集合**（replay が直前のリネーム履歴を再構成せずに適用できるように） |
| `dataset_member_added` | `dataset_id` / `membership_id` / `capture_id` / `display_index` / `operator` / `task` / `dataset_name` |
| `dataset_member_removed` | `dataset_id` / `membership_id` |
| `dataset_deleted` | `dataset_id` |
| `dataset_archive_started` | `dataset_id` / `destination` / `dataset_name` / `mode?`（`copy`\|`move`、欠落 = `move`） / `operator?` / `task?` / `members: [{membership_id, capture_id, display_index}]` / `reason?`。**凍結された member 集合そのもの**（§6.1） |
| `dataset_archived` | `dataset_id` / `destination` / `dataset_name` / `mode?` / `member_total` / `bytes_total` / `manifest_sha256?`。run の封印（§6.1） |
| `batch_created` | `batch_id` / `batch_seq` / `project` / `task` / `target_episodes` / `created_at` / `robot?` / `condition?` / `operator?`。**`status` は載せない** — 作成時点は常に `active` なので情報が無く、replay がそれを信じると終了済みバッチを「開いたまま」に復元してしまう（→ `batch_ended`） |
| `batch_updated` | `batch_id` / `project` / `task` / `condition` / `target_episodes`。`dataset_updated` と同じく**差分ではなく変更後の完全な集合** |
| `batch_ended` | `batch_id` / `status` / `ended_reason?` / `ended_at`。終端遷移 |

- `capture_id` はイベントの **envelope** で運ぶ。`event_id` / `at` / `source_instance_id` も envelope 側が所有し、payload からは設定できない（呼び出し側が冪等キーや時刻を偽造できないようにするため）。
- append は flush → fsync → 親 dir fsync。**全 kind で fatal** — 書けなければその操作を中止する。
- `capture_archived` を**墓標に含めない**のが要点。バイトは operator が選んだ場所へ移っただけで capture は実在するので、「存在しなかったこと」に正規化してはならない。`dataset_archive_started` / `dataset_archived` も同様に墓標ではない。
- **録画系イベントの kind は追加しない**（安全原則 5 の不変条件。録画 start/stop が ledger の書き込み可能性に依存してはならない）。
- **ENOSPC 対策**: 起動時に `.ledger-slack`（1MB）を確保する。append が `ENOSPC` になったとき、discard / delete の経路は slack を解放して append を再試行する（ディスクが埋まった状態から抜け出す唯一の経路が、ディスクを要求するせいで塞がる、を防ぐ）。
- Review 編集は ledger に書かない（`record.json` が正）。
- **ledger が読めないことと、ledger が空であることは別**。空 = 何も破棄されていない、読めない = 分からない。ledger は manifest に優先するので（§8 規則 3）、後者を前者として扱うと**operator が破棄した capture を全部復活させた catalog** ができあがる。よって「読めない ledger」は**起動を中止させる**。

## 6. dataset の論理化

- 物理 move・実体コピーは全廃。**dataset は DB 行 + ledger イベントだけ**。
- `display_index` は dataset 内の表示番号で、**欠番の再利用を禁止**（high-water mark は ledger から復元できる）。禁止の実体は「引退した番号を**別の** recording に渡さない」こと — **同じ capture が同じ dataset に戻るときは、かつての自分の番号を取り戻す**（ledger の最後の member_added から復元。番号↔recording の対応はむしろ強まる）。誤 remove からの登録し直しが「新しいテイク」に見えてしまわないため。
- **ラベル（name / operator / task）は active な間は編集可能**（`PATCH /api/v1/datasets/{id}`、ledger に `dataset_updated`）。同一性は `dataset_id` であり、リネームは「何と呼ぶか」を変えるだけで member と番号は不変。operator は「dataset のラベル」であって「誰が録画したか」ではない — 各 member の capture が自分の operator を持ち続けるので、複数人で録画した dataset はラベルを空にしてよい（views/ はその場合 member ごとの operator で枝を作る）。非 active では 409（ラベルは archive run が書いたフォルダに焼き込まれている）。
- **明示的に廃止**: `dataset.json` サイドカー、`data/index.jsonl`、`POST /api/v1/datasets/index/rebuild`、`episode.json`、ジョブの `dataset_dir` param、`mcap_utils.validate_dataset_dir`、`<op>/<task>/<NNN>` の 3 階層検証。役割はすべて `datasets` / `dataset_members` テーブルと §8 の rebuild が引き継ぐ。
- **views/**: `views/<operator>/<task>/<dataset_name>/<NNN> -> ../../../../objects/<capture_id>`。
  - 再生成は**世代ディレクトリ + symlink 差し替え**で原子的に行う: `views` 自体を `views.<generation>/` への symlink とし、`os.replace` で張り替える（views が存在しない瞬間を作らない）。in-place の書き換えは禁止。
  - 再生成の入力は**コミット済みの `dataset_members` 行のみ**で、DB トランザクションの後に走る。所有者は orchestrator ただ 1 つ（dora_runner は依頼するだけ）。旧世代は 2 つの経路で消える: 再生成時の世代数プルーン（KEEP_GENERATIONS）と、**reconciler の定期パスによる猶予付き掃除**（現行 10 分。静かな期間の直前に作られた最後の旧世代 — 例えば archive 前の木 — が、ダングリング symlink の残骸として `views` の隣に居座り続けないため。`views` symlink が現在指す世代には決して触れない）。
  - **パスは一意でなければならない**。`display_index` は dataset ごとに 1 から振り直すので、`(name, operator, task)` が同じ active な dataset が 2 つあると両者の 001 が同一パスを要求する。
    - 入口で閉じる: 作成・ラベル編集は active な dataset の 3 ラベル重複を **`409 dataset_labels_taken`** で拒否する（非 active は対象外 — バイトは出て行っており、名前は再利用してよい）。
    - それでも再生成は**決して例外で中断しない**: 木の差し替えは最後の 1 回なので、途中で投げると `views` は変更前の世代を指したまま固定され、以後の編集も同じ所で落ちる = **黙って現実を追わなくなる**（`POST /views/refresh` だけが raw 500 でそれを露出する）。ledger 由来の復元など入口を通らない行があるため、衝突した側のフォルダを `<name>__<dataset_id 末尾>` へ退避し、`renamed` として結果に報告する。順序は `datasets.created_at` で決めるので、先にあった dataset のパスは動かない。
  - 入口は `POST /api/v1/views/refresh`。
- **archive は capture 単位**として存続する: `POST /api/v1/captures/{id}/archive`。copy → sha256 verify → ledger(`capture_archived`) → source 削除、という順序（安全な向き）を維持する。
  - **`KAIROS_ARCHIVE_ROOTS` の許可リストと、重なりの検査は別の問い**であり、前者を通ったことは後者の証拠にならない。許可リストは「どこへ書いてよいか」を言い、重なり検査は「その 2 つが同じバイトであってはならない」を言う。
  - 検査の対象は **解決後の書き込み先（target = `<destination>/<capture_id>`）** であって、許可ルートそのものではない。したがって **`data_dir` を含むルートを許可すること自体は禁止されない** — 実際 `KAIROS_ARCHIVE_ROOTS=/data` は operator がやりそうな設定で、許可リストだけなら `objects/<id>` を data_dir 配下へ archive することを通してしまい、その後の source 削除が**検証済みのコピーを原本もろとも消して**「成功しました、何も残っていません」になる。それを止めるのがこの独立した検査。
  - `realpath` で両側を解決し（symlink で重なりを偽装できない）、**包含は両方向**を見る（書き込み先が data_dir の中にある場合と、data_dir が書き込み先の中にある場合は、同じ災厄の裏表）。
- **task.json の投影（行き先のみ）**: 検証済みコピーの完了後、capture に実効 task ラベル（§4.3 の override 適用後。row のキャッシュではなく**サイドカーから読む** — record.json の override、無ければ manifest。サイドカーが読めないときだけ row にフォールバック）があれば、行き先ディレクトリに rosbag2lerobot 互換の `task.json`（`{"task": "<label>"}`）を生成する。archive された木を LeRobot 変換器が kairos 抜きで直接読めるようにするため。適用は capture 単位 archive と dataset archive の member（move / copy とも）の全経路。ラベルが無い capture（import 等）はファイル自体を作らない。**源が自前の `task.json` を持っている場合（import された bag・再 import された archive）はそれをそのまま保持し、投影しない** — 源のファイルは subtasks 等の他に存在しない情報を運び得るし、kairos のラベルは `capture_archived` の `task` フィールドに残る。生成は**行き先だけ** — ライブの `objects/` には決して書かない（§4.3 のラベル編集で腐る写しになるため）。エントリ（`{path, size, sha256}`）は copy 結果に合流するので、`capture_archived` の `files`・dataset manifest の member `files` が生成ファイルもコピー済みバイトと同様に監査する。**行き先の task.json は「その member をコピーした時点」のラベルのスナップショット**であり、以後のラベル編集には追随しない — halt/resume を挟んだ dataset archive では、run 1 と run 2 の member が異なる時点の写しを運び得る（封印はそれを遡って揃えない）。

### 6.1 dataset の archive（確定と書き出し・終端遷移）

dataset の終端。capture archive の語彙（copy → verify → remove）を dataset に持ち上げたもので、**v1 の「export = store 内の move」の復活ではない**: 出て行ったものはこの store から消え、**どこへ行ったかの記録が残ること**が目的そのもの。

- **状態機械**: `datasets.status` は `active → archiving → archived` を一方向に歩く。`active → archiving` は DB の CAS（`UPDATE … WHERE status='active'`）で直列化し、二重開始を構造的に排除する。`archived` は終端。
- **2 つの mode**（`archive_mode` として行と ledger の両方に凍結される。resume で変更不可 — 409 `archive_mode_mismatch`）:
  - **`move`（既定）**: 検証済みの member から順に**源を削除**する。ディスクが空く。member は専有必須（他の active dataset と共有していれば 409）。
  - **`copy`**: 同じフォルダ・同じ manifest・同じ封印を作るが、**capture の行にもバイトにも一切触れない**。共有 member でも合法 — 合成で作った集合の標準の書き出し方。member ごとの `capture_archived` イベントは**書かない**（何も起きていない capture に「出て行った」と記録するのは嘘になる）— 完了 member の耐久記録は destination の manifest 自身で、resume はそれを読んで再開する。`delete_unavailable` の環境でも実行可能。
- **copy で封印された dataset（archived × copy）の membership は、capture のローカルバイトへの主張ではない**: per-capture の delete / archive を**ブロックせず**、新しい dataset への追加も妨げない。これが無いと「copy 封印された dataset にしか属さない capture が、凍結された member 集合のせいで永久に消せない」罠になる。move の場合は従来どおり（§7 の guard は active な dataset と、bytes を主張する非 active = move 系のみを数える）。
- **開始（`POST /api/v1/datasets/{id}/archive` → 202）**: 行き先は capture archive と同じ `KAIROS_ARCHIVE_ROOTS` 許可リスト＋重なり検査（§6 の 2 つの独立した問い。検査対象は解決後の dataset_dir）。**フォルダ名は operator のもの**: `path`（root 配下の相対パス。最終要素が dataset のフォルダ）を UI が views 形状 `<operator>/<task>/<name>` で先埋めし、自由に書き換えられる。省略時はサーバが同じ既定を sanitize して合成。エスケープ（`..` 等）は文字検査ではなく最終ディレクトリの realpath 再検証（許可リスト包含）で閉じ、**既存エクスポートとの衝突は `409 destination_not_empty` または `409 destination_claimed`**（この 2 つが重複チェックの実体）。後者は行き先を既に別の dataset が保持している場合で、空だが専有済みの窓 — 走者がまだ何も書いていない開始直後や、operator が中断した run の残骸を消した後 — を閉じる。member 0 件・共有 member（他 dataset にも属す capture、409 で全件列挙）・busy な member（各自の理由付きで全件列挙）・非空の行き先は開始前に拒否する。CAS 成功 → `dataset_archive_started` を append（**凍結された member 集合を運ぶ**。失敗したら CAS を戻す — バイトが動く前だけに許される唯一の rollback）。
- **run（orchestrator 内の in-process ランナー。dora_runner ではない — ファイルを動かす仕事はそこに無い）**: member を `display_index` 順に、per-capture archive と同一の §9-1 順序（copy → sha256 verify → `capture_archived`（dataset 注釈付き）→ 行更新 → trash 経由の source 削除・replica を同一クリティカルセクションで `trashed` へ）で搬出する。書き込み先は `<dataset_dir>/<NNN>/`。
- **member guard の唯一の緩和**: §7 の「dataset member は archive 拒否」は、**当該 run 自身の dataset の membership に限って**免除される（他の dataset の membership は引き続き拒否）。HTTP 経路の per-capture archive の挙動は不変。
- **`dataset_manifest.json`**: 最初の書き込みから dataset_dir に置き、member 完了ごとに atomic に書き直す — 途中で死んだフォルダが「dataset X の書き出し途中、001–002 は封印済み」と**自己申告する**ため。全 member 完了で `status: complete` に確定し、その bytes の sha256 を `dataset_archived`（封印イベント）が記録する。依存は manifest → ledger の一方向で、封印後に manifest を書き換えれば ledger 単独で検出できる。
- **halt と resume**: 進めない member（lease 出現・append 失敗・行き先に未記録のバイト etc.）で run は**その場で止まり、`archiving` のまま**理由を報告する。何も rollback しない。再 POST（destination 省略、指定するなら記録と一致必須 — 違えば 409）が**耐久状態だけから**冪等に再開する: 行が言う完了 member はスキップ、ledger だけが言う member は行更新以降のみ、未記録の debris は**原本が健在なときに限り**作り直し、原本まで消えていれば人間を呼ぶ（唯一触ってはならない状態）。**起動時の自動 resume はしない** — operator が選んだ外部ストレージへの書き込みを再起動の副作用で続けない。UI は `archiving`＋`running: false` を Resume として提示する。
- **凍結**: `status != 'active'` の dataset は member の増減・削除を全て 409 で拒否する（resume は started イベントの凍結集合を再生するので、途中の増減は静かな乖離になる）。**archived の行は消させない** — 行は ledger の移行ログの照会キャッシュであり、「この dataset はどこへ行ったか」への答えそのもの（capture の墓標と同じ「行は消さない」原則）。逆向きの guard: archive 済み capture（bytes が無い）と、非 active な dataset の member（bytes が出て行く途中）は、新たな dataset に追加できない。
- **views/**: `list_view_entries` が `status='active'` に限定する。archive 開始で dataset は views/ から**宣言として**消える — regenerate の「原本が無いから skip」経路に落とさない。
- **rebuild**: `dataset_archive_started` は dataset 行と member 行を単独で再建し（truncated ledger 対策の自己完結 payload）、封印が無ければ **`archiving` のまま復元**する — resume 可能性は DB 全損を生き延びる。member の capture 行は既存の `capture_archived` 再構築がそのまま引き受ける。
- **進捗**: 揮発（`GET /api/v1/datasets/{id}/archive`）。member 単位の完了数は行から導出し、コピー中のバイト数・halt 理由はプロセスメモリ — 再起動で正直にリセットされる。jobs テーブルには置かない（揮発・非 rebuild 契約）。

### 6.2 dataset の LeRobot export（派生物の生成・非終端）

dataset を学習用形式（LeRobot v3）へ変換して `exports/<name>/` に書き出す。archive と違い
**非終端** — dataset の状態は変わらず、何度でも実行できる。実行主体は常駐の `lerobot_exporter`
コンテナ（opt-in overlay。同梱の rosbag2lerobot を変換ごとに subprocess 起動）。

- **入力のスナップショット**: orchestrator が `POST /api/v1/datasets/{id}/export` の時点で member を
  capture リストへ解決し（`display_index` 順・ローカルバイト不在と review_status=excluded は落とす）、
  各 capture の実効 task ラベルを **§4.3 の解決規則（record.json override → manifest → row
  フォールバック）で capture mutex 下**に読んで固める。views/ の生木は使わない。
- **lease**: 全対象 capture に共有 lease `export:<export_id>` を張る（queued の間も保持・
  観測ごとに延長・終端で解放）。freeze はしない — スナップショット + lease が同じ保証を与える。
- **staging**: `exports/.staging/<export_id>/<NNN>/` に実ディレクトリを作り、MCAP と
  `metadata.yaml` だけを**ファイル単位 symlink**で張る。task ラベルがある episode には
  `task.json` を書く（源 bag が自前の `task.json` を持つ場合はそれを優先し注入しない — §6 の
  投影衝突ルールと同じ向き）。`objects/` へは一切書かない。staging はジョブ終了で削除。
- **保存先と命名**: root は `exports/` 固定。名前は `<operator>_<profile名>_<メモ>`
  （operator 混在は固定語 `mixed`。省略できるのは末尾のメモだけ。views と同じ sanitize）。
  衝突は 409 `destination_not_empty`。パスの記録は data-root 相対で統一し、絶対パスを焼かない。
  ホスト上の置き場所は `.env` の `EXPORTS_DIR`（既定 `<data_dir>/exports`）がマウントで決める。
- **並行**: 受付は FIFO キューで無制限、実行スロットは既定 1（`KAIROS_LEROBOT_MAX_CONCURRENCY`）。
  同一 dataset の多重投入だけ 409 `export_in_progress`。録画との同時実行は許可
  （コンテナ `cpus:` 上限 + recorder のドロップ検出がガードレール）。
- **記録**: 成功の終端を orchestrator が初めて観測したとき ledger に `dataset_exported` を
  append（export_id・出力相対パス・profile + config sha256・capture スナップショット・件数）。
  行は作らない（成果物は派生物で、正本は出力木自身の `meta/conversion_log.json`）。
  `dataset_exported` は墓標ではない。
- **削除**: `exports/<name>/` は派生物なので通常の削除でよく、trash 経路を通らない。
  再生成は同じ dataset + 同じ profile で再実行するだけ。
- **進捗**: 揮発。exporter が変換の heartbeat（`meta/progress.json`）を読んで
  `queued/running/complete/failed/canceled` + episode 単位/episode 内の進捗 + stall を返す。

## 7. 削除の統一（trash 経由・墓標）

discard（未送信の破棄）と delete の共通経路。

**先行条件**: capture lease が生きている間は `409 capture_busy` / `recording`・`stopping` 中は `409` / `dataset_members` から参照中は `400`（先に member を外す）。

```
1. ledger.append(kind=…)                      — fatal。書けなければ中止
2. DB tx: captures.state → delete_pending、deleted_at/delete_kind/reason を記録
3. objects/<id> → .trash/<id> へ atomic rename（兄弟ファイルも移動）
4. DB tx: captures.state → discarded|deleted（墓標確定。行は消さない）
5. reaper: .trash/<id> を物理削除 →「.trash/<id> の不在を検証してから」
   replicas.state → absent_managed。残骸があれば trashed のまま上限付きで再試行し、
   超過は警告として表面化する（無限ループ禁止）
```

- `delete_pending` は「rename 失敗時の後始末」ではなく、**rename 前の耐久マーカー**。
- **resume 規則（reconciler、冪等 3 分岐）**: `state=delete_pending` の行について、`objects/<id>` があれば rename して 4 へ / `.trash/<id>` があれば 4 へ / どちらも無ければ 4 へ。
- **起動時 delete-resume**（rebuild 時に限らず**通常起動でも必ず実行**）: ledger の `capture_discarded` / `capture_deleted` を走査し、`objects/<id>` が残るものは手順 2 から再実行する（`event_id` で冪等）。手順 1 と 2 の間で落ちると `delete_pending` の行すら残らないので、ledger を毎回読むのが唯一の回収手段。
- rename は open 中の FD では失敗しない（POSIX）。実行中ジョブ対策は FD ではなく **lease** で行う。
- **`.trash` からの復元機能は提供しない**（片道）。「戻せる」と書いておいて reaper が先に走る、という嘘をつかないため。
- 削除は `report/<pipeline>/<capture_id>/` も回収する（破棄済みの成果物が配信され続けるのを止める）。これは trash 経由ではなく走査ベースで、reaper の再試行回数の外側にある — レポートは派生物なので、その削除失敗が capture の削除を止めてはならない。
- **外部の `rm -rf` は削除ではない**: `replicas.state → missing_unmanaged`、`captures.state` は不変、警告 UI に出る（後述の閾値ガード配下）。
- 容量計算は `.trash` と `.incoming` を算入する。

### 7.1 capture lease

**lease は共有（shared reader lease、rev.2.15）。** 1 つの capture を**複数の保持者が同時に持てる**。
`capture_leases(capture_id, owner, expires_at, acquired_at)`（PK は `(capture_id, owner)`、
`(capture_id, expires_at)` に index）に 1 保持者 = 1 行で持つ。digest ジョブ・dora_runner ジョブは
`objects/<id>` に触れる前に保持を取得する。**discard / delete は live な保持者が 1 人でも居れば `409 capture_busy`。**

- **なぜ共有にしたか**: 単一所有者の lease は「誰かが触っている」という記録と「ジョブ同士の排他」を
  兼ねていたが、後者は目的ではなく、**同一 capture のカメラ N 本を並列にエンコードできない**という
  実害だけを生んでいた（N は実運用で 2〜5）。よって排他をやめ、記録だけを残した。
- **守る不変条件は不変**で、保持者ごとに再現される — 失効した保持は保持ではない（読み取りは常に now と
  比較する）／保持者はそれぞれ独立に失効する／**最後の 1 人が居なくなった時点で capture は削除可能に
  なる**。あらゆる失敗が「また削除できる」方向へ収束する性質は保たれている。
- **取得は排他しない**（常に成功する）。したがって**ジョブ投入時の「他が保持しているか」の事前判定は
  撤去した** — それこそが並列化を阻んでいた門であるため。
- **GC タスクは持たない。** 失効行は次に同じ capture を取得したときに日和見的に削除する。失効した保持は
  読み取り時点で既に保持ではないので、掃除は衛生であって正しさではない — だからこそ「死ぬかもしれない
  常駐タスク」ではなく、どうせ起きる書き込みに相乗りさせられる。
- **`409` の details は保持者の全リスト**: `{ capture_id, holders: [{owner, expires_at}, …],
  lease_owner, lease_expires_at }`。`holders` は expires_at 昇順。`lease_owner` /
  `lease_expires_at` は**最後に失効する保持者**を指すスカラ要約（＝「いつ再試行できるか」の答え）で、
  単一所有者時代の形しか知らないクライアントのために維持する。
- **`captures` の `lease_owner` / `lease_expires_at` 列は撤去した。** API 応答の同名フィールドは
  view `captures_with_lease` が上記スカラ要約として供給する。lease は **volatile で rebuild 対象外**
  （§8）— lease は「今走っているプロセス」の記述であり、rebuild が走るのはそんなプロセスが居ないとき
  なので、復元すれば解放する者の居ない保持で capture を永久にロックすることになる。

- lease を失った / state が terminal でなくなったジョブは**中断し何も書かない**。
- **digest ジョブ**は lease を実行の全区間について取り、最終 manifest 書き込みの**直前に `captures.state` と lease 保持の両方を読み直す**。どちらかが崩れていれば（`delete_pending|discarded|deleted` になった、あるいは lease を失った）**そこで中止する — 更新はしない**。窓を閉じているのは DB のロックではなく **lease そのもの**で、最後の再読は「lease を失ったジョブは黙って諦め何も書かない」という §7.1 の要件を、書き込み可能な最後の瞬間に確認しているだけ。
- **ジョブは `objects/<id>/` を作ってはならない**（tmp 生成でツリーが復活するため）。
- dora_runner のジョブは **lease 非認知のまま**でよい（書き込み先が `report/` のみで、`objects/` への書き込み禁止は構造的に守られる）。lease の管理は orchestrator 側が代行する: 投入時に取得、**status / result のポーリング観測時に非 terminal なら更新（renew-on-poll）**、terminal を観測したら owner スコープで解放。
  - **取得は job の作成より後になる**（順序は強制されている）。lease の owner 文字列は `job:<job_id>` で、`job_id` を発行するのは dora_runner だから、作成しないと owner が決まらない — その id こそが `409` で operator に見せる名前であり、解放時に照合する鍵でもある。したがって作成 → 取得の順を崩せない。**取得に失敗したら、たった今作った job を打ち消す**（補償的な cancel）。作成の前にも安価な事前チェックを 1 回入れて、この補償経路に入る頻度を下げている（権威ある判定はあくまで後段の取得）。
- **TTL が保証しないもの（正直に述べる）**: renew-on-poll は「**誰かが観測している間は生きる**」という保証であって、**キュー待ちは保証しない**。dora_runner は並行度を絞るので、投入されたジョブは他のジョブの後ろで待つことがあり、その間に誰もポーリングしなければ lease は失効し delete が勝つ。そのジョブは後で `.trash` へ移ったディレクトリに対して**きれいに失敗する** — 遅い正常終了であって破損ではない。orchestrator が見ていないジョブのために更新ループを回すよりも、この失敗を受け入れる。
- 失効した lease は lease ではない（読み取りは現在時刻と比較する）ので、プロセスが死んだジョブが capture を永久にロックすることはない。**あらゆる失敗が「また削除できる」方向へ収束する**のが、この設計が寄りかかっている性質。
- **既知の follow-up（rev.2.15）**: dataset archive の「live lease があれば halt」は今回変更していない。
  保持者が増えれば halt する機会も増えるので、archive 側を「保持者を待つ」か「保持者ごとに判断する」形へ
  変えるかは別途裁定する。
- **同一 pipeline の同時実行（rev.2.15 で裁定済み）**: 投入時の排他が無くなったので、同一 capture に
  同一 pipeline のジョブを複数投入できる。裁定は**許容** — カメラ用途（video_check）は成果物名が
  topic 由来なので元から衝突せず、固定名 `summary.json` を書く pipeline も**全成果物書き込みを
  atomic（tmp → rename）に統一した**ため、同時実行は**丸ごとの last-writer-wins** に正規化される。
  これは逐次に 2 回走らせたときの「後勝ち」と意味的に同一で、破損（バイト混合・途中読み）は
  起こらない。完全同一 (capture, pipeline, params) の重複投入を弾く dedup は必要になったときの
  follow-up とする（UI は既に二重送信を抑止している）。

## 8. DB スキーマ v2 と再構築

```
captures(capture_id PK, run_id UNIQUE, source_instance_id, state,
         operator, task, robot, started_at, ended_at,
         topics JSON, compression, split JSON, error JSON,
         message_count, bytes, quick_check JSON,
         task_result, failure_reason, quality, quality_source,
         review_status, review_revision INTEGER NOT NULL DEFAULT 0,
         batch_id, index_in_batch,
         deleted_at, delete_kind, delete_reason,
         archived_at, archive_destination,
         lease_owner, lease_expires_at,
         created_at, updated_at)
batches(現行維持。参照のみ captures へ)
replicas(capture_id, instance_id, state, path, manifest_digest, verified_at,
         updated_at, PRIMARY KEY(capture_id, instance_id))
datasets(dataset_id PK, name, operator, task, status, created_at,
         archive_destination, archive_started_at, archived_at)
dataset_members(membership_id PK, dataset_id, capture_id, display_index,
                UNIQUE(dataset_id, display_index), UNIQUE(dataset_id, capture_id))
jobs / validation_templates / plan_catalog(現行維持)
```

`digest_state` は**列にしない** — ローカルの `replicas` 行から導出する（`present_verified` ⇔ `complete`）。「検証前に `present_verified` へ昇格しない」（安全原則 4）を単一の事実として保つため。

### 8.1 状態機械

**capture state**（`captures.state`）

```
recording ──▶ stopping ──▶ completed
    │                          │
    └──▶ failed                └──▶（以下は delete 経路のみ）
    └──▶ interrupted ──────────▶ delete_pending ──▶ discarded | deleted
```

`recording` / `stopping` / `completed` / `interrupted` / `failed` の 5 つだけが manifest に書かれうる。`delete_pending` / `discarded` / `deleted` は DB と ledger にしか存在しない — **manifest が「削除された」と言うことはない**。削除とは、その manifest を取り去る行為そのものだから。

**replica state**（`replicas.state`。「このインストールにおけるコピーの所在」）

| state | 意味 |
|---|---|
| `present_unverified` | ここにあるが digest 未検証 |
| `present_verified` | ここにあり digest 一致を確認済み |
| `trashed` | `.trash/` にある（reaper 待ち） |
| `absent_managed` | kairos が意図して消した（reaper 完了） |
| `missing_unmanaged` | **kairos の外で消えた**。警告 |
| `corrupt` | サイドカーが読めない |

`missing_unmanaged` が最重要。外部の `rm -rf` はこれを生む。バイトが kairos の背後で消されるのは削除ではないので、capture 行は残り、replica は「誰も頼んでいないのにコピーが消えた」と言い、**完了した掃除には見えない**。

### 8.2 rebuild（サイドカーからの全再構築）

**入力**: `objects/*/object_manifest.json`、`objects/*.failed.json`、`record.json`、`quick_check.json`（§4.2）、`lifecycle.jsonl`。`jobs` は揮発として rebuild 対象外。`validation_templates` と `plan_catalog` は保存時に `catalog/*.json` へサイドカー二重化し、rebuild で復元する。dataset の archive 状態（§6.1: `archiving` / `archived`、destination 含む）は ledger の replay が復元する。

**起動時に rebuild する条件**: DB が無い / スキーマ版が違う / `KAIROS_REBUILD` による明示要求。毎回の起動で走るものではない。

**規則**:

1. 最初に recorder の `GET /record/status` を照会し、**live capture を除外**する（行を作らず、通常の finalize 経路に任せる）。recorder に到達できないときは `state ∈ {recording, stopping}` の manifest を**変換せず残し**、応答が得られてから再度パスする。応答に `live_capture_ids` 配列が無い場合は「live 集合が空」ではなく**recorder 到達不能**として扱う。
2. `state=recording|stopping` を行にするときは**必ず `interrupted` へ正規化**する（`metadata.yaml` も `.mcap` も無いものは `failed` — recorder の finalise 判定と一致させる）。
3. **墓標は ledger が manifest に優先**する。
4. 0 バイト / パース不能な manifest は **CORRUPT として報告**する（「存在しない」扱いは禁止）。**この capture には `captures` 行を作らない** — その manifest だけが「この capture が何であるか」を言えたのだから、行を作れば捏造になる。代わりに (a) corrupt 一覧のエントリ（理由付き）と (b) `state=corrupt` の **replica 行**の 2 つを出す。行の集合そのものが「バイトはここにあるが、その説明が壊れている」と言えるようにするため。結果として `captures` と `replicas` を join すると corrupt な replica が相手なしで残る — **それがまさに修復すべき集合**なので、読み手はこの不一致を許容しなければならない。
5. review 系は §4.1-4 の乖離規則（サイドカー優先・逆向きは警告）。
6. **`batches` の行は ledger から rebuild される。** `batch_created` / `batch_updated` / `batch_ended`（§5）が正本で、`project` / `robot` / `condition` / `operator` / `target_episodes` / `batch_seq` / `status` はそこから戻る。replay は**冪等** — 値はすべてイベント側から読み、行から計算し直さないので、`KAIROS_REBUILD=1` を何度掛けても `batch_seq` は動かない。**このイベントより古い ledger には `batch_created` が 1 行も無い**ので、その設置では従来どおりバッチ行は戻らない（例外にも失敗にもせず、下の孤児報告に落ちる）。**これは欠落ではなく決定である**: メタデータは `kairos.db` にしか存在しなかったのだから、遡って埋める材料がどこにも無い。id だけ合っていて中身が空のバッチを作れば、operator には「正直に失われたバッチ」ではなく「存在するが空のバッチ」が見えることになり、修正の形をした新しい誤答になる。よって**このイベント以降に作られたバッチは残り、それ以前のバッチは残らない**。`captures` 側の `batch_id` / `index_in_batch` は従来どおり `record.json` から復元される。**`episodes_recorded` だけは event から戻せない**（review 保存という「出来事」の単調カウンタであり、ledger が記録するのは事実であって出来事の回数ではない）。よって replay は**そのバッチを名指ししている capture 行を数え直して**この値を入れ、行に `episodes_recorded_is_floor = 1` を立てる。これは**下限**である: review 済みで後に削除された capture は `record.json` ごと消えているので数えられない（tombstone 行は残るので数える）。0 を入れるのは下限ですらなく誤りだったので改めた — 表示用の `N / 30` は rebuild 後に減りうるが、減りうることが機械可読になっている。行の戻らないバッチを capture が指している場合は、その旨を rebuild 時に警告として報告する（store health の warnings に出る）。**id は再利用されない** — capture が名指ししている `batch_id` は取得済みとして扱う。

### 8.3 定期 reconciler

rebuild とは別に、常時走る整合パス。次を拾う:

- 有効な manifest を持つのに DB 行が無い `objects/<id>`（import のクラッシュ・rebuild とのレースの着地点）→ 行を採用。
- `.incoming/<id>` に完成して残っているもの（rsync と rename の間で死んだ importer）→ `objects/` へ移して採用。**「完成」の判定は terminal manifest だけでは足りない**（2026-08-11, sweep S1-5 — 従来の守りは「mcap がファイル名ソートで manifest より先に転送される」という偶然 1 枚だった）。採用前に 2 つの独立ゲートを通す: (a) **バイト完全性** — staging 内 `*.mcap` の合計サイズが manifest の `bytes`（recorder が finalise 時に実測した値）に達していること（`bytes` 未記載の manifest はスキップ）。(b) **静穏** — ディレクトリ内のどこにも直近 5 秒の書き込みが無いこと（orphan sweep と同じ全木 mtime 走査。rsync は完了時に mtime を転送元の値へ戻すので、完了済みは即座に通る）。どちらかに落ちたら**次の tick に回すだけ**で、何も破壊しない。この静穏ゲートは、import の `write_manifest` と `finalize` の 2 await の隙間に採用が割り込むレースも同時に閉じる。
- terminal かつ `digest_state=pending` → digest キューへ再投入。
- `delete_pending` の resume（§7）。
- 消えたコピーの `missing_unmanaged` 化（**閾値ガード配下**、後述）。
- 壊れたサイドカーの `corrupt` 記録と `GET /api/v1/store/health` への反映。

非 terminal な DB state と terminal な manifest が食い違う場合は **manifest が勝つ**。

## 9. 安全原則（破壊的変更の対象外）

1. **ledger fatal かつ ledger-first。** §7 の手順 1 は必ず 2 以降より先。
2. **`rm -rf` は削除ではない。** `missing_unmanaged` として警告する。
3. **reconciler の閾値ガード。** 1 パスの手順は次の順で、**破壊的なものほど後ろ**に置く:
   1. volume marker を読む。読めなければ何も決めない。
   2. `.incoming/<id>` の完成済み staging を `objects/` へ公開する（`_adopt_incoming`）。**走査より前**に置くのは、ロボットから届いた capture が次のパスではなく**このパス**で行を得るため。ここに置いて安全なのは、いま marker を確認したボリューム上のディレクトリ間の移動であり、何も破壊しないから — カタログへの書き込みは、後段の marker 再確認が依然として全部ガードする。
   3. `objects/` を走査し、「今 rebuild したら何が結論されるか」を組み立てる。
   4. **marker を再読**し、変化していれば**パス全体を破棄**する（走査は行われたが、確認できないボリュームを記述していたので、その corrupt 一覧も証拠として採用しない）。
   5. 閾値ガード: missing 件数が `max(5, 対象母数の 10%)` を超えるなら適用せず **SUSPECT**。
   6. ここで初めて適用する: 孤児の採用・missing 遷移・削除の resume・reaper・digest 再投入。
   - 母数は**当該 instance の `replicas` で `state ∈ {present_*}` の行数**（`captures` 行数ではない）。
   - **SUSPECT が止めるもの**: 自動の missing 遷移・reaper・当該ストレージの digest。
   - **止めないもの**: 録画 start/stop・review 保存・カタログ閲覧。
   - **Repair は marker が一致するときのみ**提示する。marker が読めない状態での承認は拒否する（`409 volume_unidentified`）— 「あれは本当に消えた」は、誰も同定できないディスクについては意味を成さない。
   - SUSPECT は**ラッチ**し、毎パス再発火しない。解除は operator の Repair だけ。
4. **digest 検証前の `present_verified` 昇格を禁止。** digest ジョブは (a) `captures.state` が terminal (b) recorder が当該 capture を保持していない、の両方を確認してからのみ起動する。
5. **録画 start/stop は ledger・digest・rebuild の完了に依存しない。** 満杯のディスクでも録画系だけは動く（§5 の slack が discard による復旧経路を保証する）。

これらは「あとで直せばよい」種類の性質ではない。1 度でも破れば、失われたデータそのものか、失われたという事実が失われる。

## 10. digest ジョブ

- 起動条件は安全原則 4。stop 完了後の background task ＋ **定期 reconciler からの再投入**（`interrupted` 化で取り残された pending を拾う）。
- per-file sha256 → §3.3 の単一 atomic write で完成 → `replicas.manifest_digest` を記録 → `present_verified`。
- 実行中は `digest_state=pending` を UI に出す（「検証済み」と「検証中」を混ぜない）。
- クラッシュ後は reconciler が pending を再投入する（途中結果は捨てて最初からやり直す）。
- **hash 対象から可変・派生サイドカーを除く**: `object_manifest.json`（書く対象自身）、`record.json`（可変）、加えて `quick_check.json`（2026-08-11 — settlement が stop 後に**自分の時計で**書くため、封印より後に着地すると以後の照合が「派生ファイルの到着」を capture の破損として誤読する）。
- **封印済み manifest に対する未検証コピーは、本当に照合する**（2026-08-11, sweep S3-3）。`digest_state=complete` の manifest を持つ replica が `present_unverified` の場合、旧実装は 1 バイトも比べずに `present_verified` へ昇格していた（転送中に切断された bag が到着即 verified になり得た）。今はローカルの per-file hash を manifest の `files` と突き合わせ、一致で昇格、**不一致は replica を `corrupt`** にして manifest には触れない（manifest は証拠）。旧規約で `quick_check.json` を含めて封印された manifest は、そのエントリを無視して照合する（その場合 `manifest_digest` の照合はスキップ）。
- **封印の出所を manifest に刻む**: 封印時に `digest_sealed_by`（封印した instance の id）を書く。**source で封印**された hash は録画そのものに遡って錨を下ろすが、**受信側で封印**された hash（robot 側は orchestrator を走らせないので、転送が封印より先行する）は「以後の整合性チェックの基準」であって**転送そのものの証明ではない** — UI の verified 文言もそう述べる。robot 側で digest を封印してから転送する受領書型の設計は §13 のまま TBD（D12）。

## 11. API（要約）

正確な形は [api_orchestrator](api_orchestrator.md) を参照。本書は**キーが何か**だけを述べる:

- capture を指す API は全て `capture_id` をキーにする。`run_id` は応答に含まれるが、キーには使わない。
- **廃止（互換エイリアス無し）**: `/api/v1/runs` 全部、`/api/v1/episodes` 全部、`GET|DELETE /api/v1/datasets/{op}/{task}/{index}`、`POST /api/v1/datasets/index/rebuild`、`POST /api/v1/datasets/export|export-all`。
- ジョブの必須入力は `capture_id` 一本。ソース解決は `objects/<capture_id>`（`dataset_dir` param は廃止）。成果物は `report/<pipeline>/<capture_id>/`。
- retention の再定義: 候補 =「**`dataset_members` に属さず、`review_status` が `excluded` または `pending` のまま一定期間経過した captures**」。「行が存在する = 未 export」という旧定義は全廃（§6 で行が消えなくなったため）。§6.1 の dataset archive はこの定義を変えない — archive 済み member は member 行が残るため構造的に候補から外れ、bytes も無いので回収対象として意味を持たない。
- **新設（§6.1）**: `POST /api/v1/datasets/{id}/archive`（202・開始/再開兼用）と `GET /api/v1/datasets/{id}/archive`（進捗）。旧 `POST /datasets/export` の復活ではない — 台帳付きの終端的な持ち出しであり、応答も経路も別物。

## 12. 受け入れ（E2E）

**受け入れは UI から行う。** API が正しくても画面が結果を描かなければ、その機能は無い。

```bash
make build       # コード変更後に必要（下記の注意）
make test-e2e    # スタック起動 → Playwright → スタック停止
```

Playwright が、専用ポート・専用 data dir・専用 compose プロジェクトで起動した実スタック（開発者の `make up` と併存できる）に対し、実ブラウザで実 frontend を駆動する。トピック源はループ再生する実 rosbag。6 シナリオ:

| # | シナリオ |
|---|---|
| 1 | Collect で録画 → 停止 → captures に出現 → digest pending → complete |
| 2 | Review 保存 → `record.json` の存在と `revision` を検証。競合した保存は**声を上げて拒否**される |
| 3 | Discard（Review）→ reason 必須モーダル → 一覧から消える → ledger に墓標。**Collect の Discard は 1 クリック即時**（2026-08-03 の運用判断）: 目の前の take への押下自体が同意であり、ledger には「Collect からの即時 discard・理由は尋ねていない」旨の自動 reason が入る |
| 4 | `kairos.db` を削除 → 再起動 → UI に復元（失敗 start の行が catalog を落とさないことを含む） |
| 5 | `objects/<id>` を `rm -rf` → SUSPECT → Repair → `missing_unmanaged` 表示（黙って消えない） |
| 6 | dataset を構築 → Archive（§6.1）→ archived バッジ → 行き先に views 形状＋manifest（sha256 実測一致）→ `objects/` から消える → `kairos.db` 削除・再起動後も archived のまま destination を言える |

- **UI の結果が第一級のアサーション**で、サイドカー（`object_manifest.json` / `record.json` / `lifecycle.jsonl`）と API はその裏付けとして見る。
- **黙ってスキップしない。** 環境が整わないシナリオは skip ではなく fail にする（静かに蒸発する受け入れテストは、誰もテストしていないブランチを green と報告する）。
- **`make test-e2e` はイメージをビルドしない**（`make up` と同じ規則 — ビルドは変更が無くてもネットワークを要するため）。**コード変更後に `make build` を忘れると、コンテナの中の古いコードに対して green が出る。** 欠けたイメージより陳腐化したイメージの方が危険なので、この注意は運用上の必須事項として扱う。

pytest 側は別の層を守る: §7 手順 1〜5 の各段での kill → 再起動 → resume のクラッシュ注入、閾値ガード、rebuild の正規化規則、review CAS、reaper の冪等性と検証、lease 競合。

## 13. スコープ外（次ブランチ）

- edge → server の転送 subsystem・hub モード・receipt・drop-local（ロボット側に残置されたコピーの正式な replica 管理はここで解消する）。現状の split デプロイでは、discard は「**録画 PC 上のコピーの破棄**」であり、ロボット側にコピーが残っている可能性がある — UI はそれを正直に併記する。**暫定の再取得ガード**（2026-08-11, sweep S4）: importer の pull はローカル ledger の墓標（`capture_discarded` / `capture_deleted`）を持つ capture をスキップする — drop-local が無い間、`{"all": true}` の pull が削除済み capture をロボットから引き戻すのを防ぐ（削除に復元は無いので恒久スキップで安全）。
- `task_revision_id`、retention / capacity の自動化（本ブランチは**表示定義の修正まで**）。
