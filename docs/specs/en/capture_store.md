<!-- AUTO-GENERATED from docs/specs/ja/capture_store.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# capture store specification (v2)

> Status: design finalized (**v2**, implemented on `feat/capture-store`). Japanese is the source of truth (treat it as canonical). The English version `docs/specs/en/capture_store.md` is an auto-generated mirror (do not edit it directly). **No authentication is required.**

The cross-service source of truth that defines the **identity, placement, and durability** of recorded data. recorder writes it, orchestrator indexes it, dora_runner reads it, and frontend shows it — all of them obey one and the same contract. The APIs and screens of the individual services live in their own specs ([rosbag2_recorder](rosbag2_recorder.md) / [api_orchestrator](api_orchestrator.md) / [dora_runner](dora_runner.md) / [frontend](frontend.md)); this document states only the **foundation** they share.

**Being alpha, there is no backward compatibility and no migration.** v1 data (the `recorded/<run_id>` tree, the `data/<operator>/<task>/<NNN>` tree, `data/index.jsonl`, and v1-format `lifecycle.jsonl`) is not read. For later schema changes as well, the first choice is to **absorb them with a rebuild** rather than a migration. The "safety principles" (below) are, however, exempt from breaking changes.

## The central claims

1. **kairos.db is disposable.** The source of truth for a recording is the sidecar on disk; the DB is nothing more than an index and cache over it. Delete the DB and restart, and every record is rebuilt from the sidecars and the lifecycle ledger.
2. **Nothing disappears silently.** An external `rm -rf` is not a deletion. A deletion is always recorded in the ledger, the row (the tombstone) remains, and a copy that vanished surfaces as a warning.
3. **Recording depends on nothing else.** Even if the disk is full, even if the ledger cannot be written, even if the DB is broken, recording start / stop still works.

## 1. ID scheme

| ID | Format | Issued by | Purpose |
|---|---|---|---|
| `capture_id` | UUIDv7 (lowercase, hyphenated) | recorder (at `prepare` / `start`). **For imported external bags, orchestrator issues it at claim time** | **Global identity.** The key for paths, the DB primary key, sidecars, and the API |
| `source_instance_id` | UUIDv4 | Written to `<data_dir>/instance.json` at first startup | Identity of the installation (i.e. this kairos deployment) |
| `run_id` | `run_YYYYMMDD_HHMMSS(_N)` | recorder | **Display name only.** Not used as an API key |
| `event_id` | UUIDv7 | Whoever writes the ledger | Idempotency key for lifecycle events |
| `batch_id` | `batch_YYYYMMDD_HHMMSS` | orchestrator | Per recording session |
| `membership_id` / `dataset_id` | UUIDv7 | orchestrator | dataset member / logical dataset |

- UUIDv7 is an in-house implementation in `kairos_common.ids` (RFC 9562: 48-bit unix-ms + `rand_a` / `rand_b`). It **sorts in time order**, so sorting by ID is sorting by recording order.
- Demoting `run_id` to a display name is where v2 begins. Separating the human-readable name from the identifier that becomes a path and a foreign key makes both "the same run_id collides on another host" and "fixing the display name breaks the path" disappear.
- `instance.json`: `{"schema_version": 2, "instance_id": "…", "created_at": "<ISO8601>"}`. Written with exclusive creation (`O_EXCL`) plus fsync, and **never regenerated if it already exists**. If it is corrupt, **startup fails** (issuing a new id would orphan every existing replica row and sidecar).

## 2. Storage layout

```
<data_dir>/
├── objects/<capture_id>/              # the recording itself. task/operator/number are not in the path
│   ├── <capture_id>_0.mcap …         # rosbag2 output (numbered sequentially when split)
│   ├── metadata.yaml                  # produced by rosbag2. kairos does not modify it
│   ├── object_manifest.json           # §3
│   ├── record.json                    # §4 (absent until reviewed)
│   └── recorder.log                   # moved here after finalise
├── objects/<capture_id>.failed.json   # a failed start that produced no bag (§3.4)
├── objects/<capture_id>.qos.yaml      # temporary file during recording (sibling)
├── .incoming/<capture_id>/            # staging for import / transfer. must be on the same FS as objects/
├── .trash/<capture_id>/               # intermediate state of deletion (§7). must be on the same FS as objects/
├── views/                             # generated symlink tree (§6). can be wiped and regenerated
├── report/<pipeline>/<capture_id>/    # dora_runner artifacts
├── catalog/                           # sidecar duplication of validation_templates / plan_catalog
├── lifecycle.jsonl                    # §5
├── instance.json                      # §1
├── .ledger-slack                      # 1MB reserved against ENOSPC (§5)
├── .kairos-volume-id                  # volume identification marker (§9-3)
└── kairos.db                          # an index, fully rebuildable from the sidecars
```

- **Paths carry no meaning.** A capture's directory name is its `capture_id` and nothing else; operator, task, and number do not appear in it. Files no longer have to be moved every time a label is corrected, and the state "the power died partway through a move" disappears structurally.
- **Reserved names** (directly under `data_dir`): `objects` / `views` / `.trash` / `.incoming` / `report` / `catalog` / `lifecycle.jsonl` / `instance.json` / `kairos.db`. A name colliding with one of these is rejected with `400 reserved_name` **at dataset creation** (the `name` / `operator` / `task` of `POST /api/v1/datasets`) — those three become path components under `views/`, so a collision would tread on the store's own layout. A recording's operator / task never becomes a path and is therefore not subject to this check.
- **Removed**: the old `recorded/`, the 3-level `<operator>/<task>/<NNN>` dataset tree, and `data/index.jsonl`.
- **Invariant**: the only incomplete capture directory that ever appears directly under `objects/` is **the live capture recorder is currently writing**. Imports and transfers are always completed in `.incoming/<capture_id>` first, then moved into `objects/` with `os.replace`. Therefore a directory visible in `objects/` (and not live) is always a complete copy.
- **Startup check**: verify that `objects/`, `.trash/`, and `.incoming/` share the same `st_dev`. If they do not (a layout in which `os.rename` returns `EXDEV`), **deletion and archive answer `503 delete_unavailable` per request**. The routes themselves stay registered: rather than vanishing, they **refuse and state the reason** — and that reason also appears in `delete_unavailable_reason` of `GET /api/v1/store/health`, so an operator reads "why it cannot be used" instead of "the button is gone". An implicit fallback to copy + delete is forbidden — so that we never build behavior that promises an "atomic move" and in fact deletes only part of the way.
- The roots of `objects/` and `.trash/` are host-writable (recorder loosens them at creation time). The compose assumption is recorder = root, orchestrator / dora_runner = uid 1000.
- `make backup` excludes `.trash` and `.incoming` (intermediate states are not frozen into a backup).

## 3. `object_manifest.json` v2

The **audit record** written by recorder. It consolidates v1's `manifest.json` + `session.json` into one (eliminating any room for "the facts about a single recording", scattered across two files, to contradict each other).

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
  "manifest_digest": null | "sha256:…"
}
```

- Fields not in the contract are preserved as `extra` and re-emitted on write-back (so an old digest job does not silently drop a field a newer recorder added).
- A read returns **one of three values: `ok` / `missing` / `corrupt`**. Reading a 0-byte or unparsable manifest as "does not exist" is forbidden (→ §8 rebuild rule 4).

### 3.1 Definition of atomic write (common to all sidecars)

Write to tmp → flush → **`fsync(tmp)`** → `os.replace` → **`fsync` the parent directory**. The implementation is a single shared helper in `kairos_common.atomic_io`, and the ledger's append obeys the same discipline.

Even a root-owned file can be updated from uid 1000 as long as it goes through tmp + replace (an in-place `open` gets `EACCES`). This is the path by which the digest job can seal a root-owned manifest.

### 3.2 `manifest_digest`

Sort `files` by `path` ascending, concatenate them as `f"{path}\n{size}\n{sha256}\n"` (**no whitespace**), and take the sha256 of that UTF-8 string. Prefix it with `sha256:`. The canonical implementation is `kairos_common.capture_sidecars.manifest_digest`.

### 3.3 Single-writer handoff

- Up to finalize (`state ∈ {completed, interrupted, failed}`, `digest_state=pending`), **recorder is the only writer**.
- After that, **orchestrator (the digest job) becomes the only writer**, and writes `files` / `manifest_digest` / `digest_state=complete` **exactly once, in a single atomic write**. Every write after that is forbidden outright; the reconciler does not overwrite, it only reports CORRUPT.
- recorder's crash-recovery scan targets **only** manifests with `state ∈ {recording, stopping}` and touches nothing else.
- An `objects/<id>/` that does not have a manifest yet, however, is picked up by **a different path**. It can only be an arm / start that recorder itself abandoned (nothing gets in from elsewhere except through `.incoming`), so at startup recorder classifies it as its own: **if a bag exists, synthesize a manifest with `state=interrupted`**; **if it is empty, delete it together with its sibling files**. Without this, the directory of a capture that died while armed remains forever with no manifest — something rebuild can call neither "broken" nor "absent".
- An imported external bag has `operator` / `task` set to `null` and adds `imported_from` / `imported_at`.

### 3.4 Failed start (`objects/<capture_id>.failed.json`)

A start that produced not one byte of bag leaves a **sibling file** rather than a directory (to preserve the invariant "a directory directly under `objects/` means bytes were written"). It is written with the §3.1 helper, and **a write failure is not swallowed** — beyond the error log, the start error response (`507`) carries what failed (`failed_start_record_error`).

rebuild reads this file too and creates a `state='failed'` row. The deletion path and the reaper also cover a capture's sibling files (`.failed.json` / `.qos.yaml`).

> **Implementation note (found by E2E §13-4)**: the failed-start sidecar records topics from before type discovery finished, so `type` can be an explicit `null`. rebuild faithfully turns that into a row, so if any API model refuses `null`, **the whole of `GET /api/v1/captures` becomes a permanent `500`** (the row stays in the DB, so a restart does not fix it). Normalize `null` to "not yet discovered" = the empty string.

## 4. `record.json` (review-state sidecar, mutable)

```jsonc
{ "schema_version": 2, "capture_id": "…",
  "revision": N,                          // 1-based. Not yet reviewed = no file & DB review_revision=0
  "task_result": "success|failure"|null, "failure_reason": str|null,
  "quality": …|null, "quality_source": "operator|quick_check",
  "review_status": "pending|adopted|excluded",
  "batch_id": str|null, "index_in_batch": N|null, "updated_at": "<ISO8601>" }
```

**For review fields, `record.json` is authoritative and the DB is a cache.** This is what makes "you can delete kairos.db and restart" hold.

### 4.1 Save procedure (holding a per-capture mutex across steps 1–3)

1. Read `captures.review_revision`; if it disagrees with the request's `base_revision`, **`409`**. Before reading it, **adopt `record.json` into the row** if the sidecar is ahead of it (the §4.1-4 rule, applied per capture). Without that, step 2's guard produces a row that can never catch up and refuses every save forever.
2. atomic write `record.json` with `revision = base_revision + 1` — but **the disk is a compare-and-swap too**: if the `record.json` actually there does not hold `base_revision`, write nothing and answer **`409`** (a file that is missing or unreadable holds no decision to protect and is overwritten as before). On failure → **`500`, with the DB unchanged** (the only partial effect is the sidecar running ahead = the safe direction).
3. `UPDATE captures SET …, review_revision=? WHERE capture_id=? AND review_revision=?` (CAS). `rowcount=0` → **`409`**, and the sidecar just written is **restamped from the winning row** (same `revision`, the winner's values). Step 2's guard cannot fully close the read-then-write gap, so the DB is the arbiter and the disk is always made to agree with it at the end.
4. Divergence rule: rebuild / reconciler adopt the sidecar when `record.json.revision >= DB`. The reverse direction (DB > sidecar) is not silently repaired; it **surfaces as a warning**.

- Why steps 2 and 3 are needed as a pair: keeping only "the sidecar runs ahead" lets **a save that lost to another orchestrator process leave its write over the winner's `record.json`**. §8 rebuilds `kairos.db` from the sidecars, so the moment the index is thrown away, **the decision that was refused with a `409` becomes the stored one** — the CAS held inside the API and the recovery procedure undid it.
- We do not say "the DB is rolled back" (with sqlite3 plus files, that cannot be promised). What we promise is that **disk and DB converge on one decision**, whichever of them is ahead.
- A global lock is not used for this (it would serialize every request across an fsync).
- **System-originated rewrites** (re-deriving quality once quick_check has settled) go through the same path and advance `revision` (`quality_source=quick_check`). A client receiving a `409` as a result is **correct behavior**.
- The side effects the old `POST /episodes` carried (the monotonic increment of `batches.episodes_recorded`, launching auto-pull) have been relocated to "**the first review save for that capture**".

## 5. `lifecycle.jsonl` v2

```jsonc
{ "schema_version": 2, "event_id": "<uuid7>", "source_instance_id": "…",
  "kind": "…", "capture_id": "…"|null, "at": "<ISO8601>", …per-kind payload }
```

| kind | payload |
|---|---|
| `capture_discarded` / `capture_deleted` | Tombstone. Reason and so on |
| `capture_archived` | `destination` / `run_id` / `operator` / `task` / `bytes` / `message_count` / `files: [{path,size,sha256}]`. When written as a member of a dataset archive, also `dataset_id` / `membership_id` / `display_index` (§6.1) |
| `dataset_created` | `dataset_id` / `name` / `operator` / `task` |
| `dataset_updated` | `dataset_id` / `name` / `operator` / `task`. **The complete post-change label set, not a diff** (so a replay applies events in order without reconstructing the preceding rename history) |
| `dataset_member_added` | `dataset_id` / `membership_id` / `capture_id` / `display_index` / `operator` / `task` / `dataset_name` |
| `dataset_member_removed` | `dataset_id` / `membership_id` |
| `dataset_deleted` | `dataset_id` |
| `dataset_archive_started` | `dataset_id` / `destination` / `dataset_name` / `mode?` (`copy`\|`move`; missing = `move`) / `operator?` / `task?` / `members: [{membership_id, capture_id, display_index}]` / `reason?`. **The frozen member set itself** (§6.1) |
| `dataset_archived` | `dataset_id` / `destination` / `dataset_name` / `mode?` / `member_total` / `bytes_total` / `manifest_sha256?`. The seal on the run (§6.1) |

- `capture_id` travels in the event's **envelope**. `event_id` / `at` / `source_instance_id` are owned by the envelope as well and cannot be set from the payload (so a caller cannot forge an idempotency key or a timestamp).
- append is flush → fsync → fsync of the parent dir. **Fatal for every kind** — if it cannot be written, the operation is aborted.
- The crucial point is that `capture_archived` is **not counted as a tombstone**. The bytes merely moved to a location the operator chose and the capture really exists, so it must never be normalized into "it never existed". The same holds for `dataset_archive_started` / `dataset_archived` — neither is a tombstone.
- **No recording-related event kinds are added** (the invariant behind safety principle 5: recording start/stop must not depend on whether the ledger is writable).
- **ENOSPC countermeasure**: reserve `.ledger-slack` (1MB) at startup. When an append hits `ENOSPC`, the discard / delete path releases the slack and retries the append (preventing the only escape route from a full disk from being blocked because it, too, demands disk).
- Review edits are not written to the ledger (`record.json` is authoritative).
- **A ledger that cannot be read is not the same as a ledger that is empty.** Empty = nothing was discarded; unreadable = we do not know. The ledger takes precedence over manifests (§8 rule 3), so treating the latter as the former yields **a catalog that has resurrected every capture the operator discarded**. An "unreadable ledger" therefore **aborts startup**.

## 6. Making datasets logical

- Physical moves and real copies are abolished entirely. **A dataset is nothing but DB rows + ledger events.**
- `display_index` is the display number within a dataset, and **reusing a gap is forbidden** (the high-water mark can be recovered from the ledger). What the ban actually forbids is handing a retired number to a **different** recording — **the same capture returning to the same dataset takes its former number back** (restored from the ledger's last member_added; the number↔recording binding is strengthened, not weakened). This is so that re-registering after an accidental remove never reads as a new take.
- **The labels (name / operator / task) are editable while the dataset is active** (`PATCH /api/v1/datasets/{id}`, `dataset_updated` in the ledger). Identity is `dataset_id`: a rename changes what the dataset is called, never what it is — same members, same numbers. operator is **the dataset's label, not "who recorded"** — every member capture keeps its own operator, so a dataset recorded by several people may leave the label empty (`views/` then branches per member operator). Non-active is `409` (the labels are baked into the folder the archive run wrote).
- **Explicitly removed**: the `dataset.json` sidecar, `data/index.jsonl`, `POST /api/v1/datasets/index/rebuild`, `episode.json`, the jobs' `dataset_dir` param, `mcap_utils.validate_dataset_dir`, and the 3-level `<op>/<task>/<NNN>` validation. Their roles are taken over in full by the `datasets` / `dataset_members` tables and the rebuild in §8.
- **views/**: `views/<operator>/<task>/<dataset_name>/<NNN> -> ../../../../objects/<capture_id>`.
  - Regeneration is atomic via a **generation directory + symlink swap**: `views` itself is a symlink to `views.<generation>/`, swapped with `os.replace` (never creating a moment in which views does not exist). Rewriting in place is forbidden.
  - The input to regeneration is **only committed `dataset_members` rows**, and it runs after the DB transaction. There is exactly one owner, orchestrator (dora_runner merely requests it). Old generations die two ways: the count-based prune at regeneration (KEEP_GENERATIONS), and a **grace-based sweep in the reconciler's periodic pass** (currently 10 minutes — so that the last old generation from just before a quiet period, e.g. the tree from before a dataset archived, does not linger beside `views` as dangling-symlink debris; the generation the `views` symlink currently targets is never touched).
  - **The path must be unique.** `display_index` restarts at 1 in every dataset, so two active datasets with the same `(name, operator, task)` make both their 001s demand the identical path.
    - Closed at the door: creating or relabelling refuses a duplicate of the three labels among active datasets with **`409 dataset_labels_taken`** (non-active are out of scope — their bytes have left and the name is free to reuse).
    - Even so, regeneration **never aborts with an exception**: the tree is swapped exactly once at the end, so throwing partway leaves `views` pinned to the pre-change generation and every later edit failing at the same place = it **silently stops tracking reality** (only `POST /views/refresh` exposes it, as a raw 500). Rows can arrive without passing the door — restoration from the ledger, for one — so the colliding dataset's folder is moved aside to `<name>__<dataset_id tail>` and reported as `renamed` in the result. The order comes from `datasets.created_at`, so the dataset that was there first keeps its path.
  - The entry point is `POST /api/v1/views/refresh`.
- **archive survives, at capture granularity**: `POST /api/v1/captures/{id}/archive`. It preserves the order copy → sha256 verify → ledger (`capture_archived`) → delete source (the safe direction).
  - **The `KAIROS_ARCHIVE_ROOTS` allow-list and the overlap check are different questions**, and passing the former is no evidence about the latter. The allow-list says "where you are allowed to write"; the overlap check says "those two must not be the same bytes".
  - What is checked is the **resolved write target (target = `<destination>/<capture_id>`)**, not the permitted root itself. Permitting a root that contains `data_dir` is therefore **not forbidden in itself** — `KAIROS_ARCHIVE_ROOTS=/data` is in fact the kind of setting an operator would plausibly choose, and on the allow-list alone it would let `objects/<id>` be archived to a location under data_dir, after which deleting the source **erases the verified copy along with the original** and reports "success, nothing left". Stopping that is what this independent check is for.
  - Resolve both sides with `realpath` (a symlink cannot fake away an overlap) and check **containment in both directions** (the write target being inside data_dir, and data_dir being inside the write target, are two faces of the same disaster).

### 6.1 Archiving a dataset (finalize and write out — the terminal transition)

The dataset's terminal state. It lifts the capture archive's vocabulary (copy → verify → remove) to a dataset, and it is **not a revival of v1's "export = a move inside the store"**: what left is gone from this store, and **that a record of where it went remains** is the purpose itself.

- **State machine**: `datasets.status` walks `active → archiving → archived` in one direction. `active → archiving` is serialized by a DB CAS (`UPDATE … WHERE status='active'`), structurally ruling out a double start. `archived` is terminal.
- **The two modes** (frozen as `archive_mode` into both the row and the ledger; a resume cannot change it — `409 archive_mode_mismatch`):
  - **`move` (the default)**: **deletes the source** of each verified member as it goes. Disk is freed. Members must be exclusive (sharing with another active dataset is a 409).
  - **`copy`**: produces the same folder, the same manifest, and the same seal, but **touches neither the captures' rows nor their bytes**. Shared members are legal — the standard way to write out a combined set. The per-member `capture_archived` events are **not written** (recording "it left" for a capture nothing happened to would be a lie) — the durable record of finished members is the destination manifest itself, and a resume reads it to pick up. It runs even where deleting is withdrawn (`delete_unavailable`).
- **A membership in a copy-sealed dataset (archived × copy) is not a claim on the capture's local bytes**: it blocks **neither** the per-capture delete / archive **nor** joining a new dataset. Without this there is a trap: a capture belonging only to a copy-sealed dataset could never be deleted — the member set is frozen, so the membership could never be removed to unblock it. move is as before (§7's guard counts only the memberships that claim bytes: active datasets, and the non-active move family).
- **Start (`POST /api/v1/datasets/{id}/archive` → 202)**: the destination goes through the same `KAIROS_ARCHIVE_ROOTS` allow-list plus overlap check as the capture archive (the two independent questions of §6; what is checked is the resolved dataset_dir). **The folder name is the operator's**: `path` (a relative path under the root; its last component is the dataset's folder) is prefilled by the UI with the views shape `<operator>/<task>/<name>` and freely editable. When omitted, the server derives the same sanitized default. Escapes (`..` and the like) are closed not by string hygiene but by realpath re-validation of the final directory (containment in the allow-list), and **a collision with an existing export is the ordinary `409 destination_not_empty`** (which is the duplicate check). Zero members, shared members (captures that also belong to another dataset; a 409 enumerating every one), busy members (every one, each with its own reason), and a non-empty destination are refused before anything starts. CAS succeeds → append `dataset_archive_started` (**carrying the frozen member set**. If the append fails, the CAS is put back — the only rollback ever permitted, allowed precisely because no byte has moved yet).
- **The run (an in-process runner inside the orchestrator. Not dora_runner — moving files is not its job)**: members are carried out in `display_index` order through the same §9-1 sequence as the per-capture archive (copy → sha256 verify → `capture_archived` (with the dataset annotation) → row update → source deletion via trash, the replica going to `trashed` in the same critical section). The write target is `<dataset_dir>/<NNN>/`.
- **The one relaxation of the member guard**: §7's "a dataset member is refused for archive" is waived **only for memberships in the run's own dataset** (memberships in any other dataset are refused as before). The behavior of the per-capture archive over HTTP is unchanged.
- **`dataset_manifest.json`**: placed in the dataset_dir from the first write and atomically rewritten as each member completes — so that a folder that died halfway **declares itself**: "dataset X, write-out in progress, 001–002 sealed". When every member is done it settles to `status: complete`, and the sha256 of those bytes is recorded by `dataset_archived` (the seal event). The dependency is one-way, manifest → ledger, so a manifest rewritten after the seal is detectable from the ledger alone.
- **Halt and resume**: on a member it cannot advance past (a lease appears, an append fails, unrecorded bytes at the destination, etc.) the run **stops on the spot and stays `archiving`**, reporting why. Nothing is rolled back. A re-POST (destination omitted; if given it must match the record — otherwise a 409) resumes idempotently **from durable state alone**: members the rows say are complete are skipped, members only the ledger vouches for are finished from the row update onward, unrecorded debris is rebuilt **only while the source is intact**, and when even the source is gone it calls a human (the one state it must not touch). **No automatic resume at startup** — a write to external storage the operator chose is not continued as a side effect of a restart. The UI presents `archiving` + `running: false` as Resume.
- **Freezing**: a dataset with `status != 'active'` refuses adding members, removing members, and deletion, all with a 409 (resume replays the frozen set from the started event, so a mid-flight change would be a silent divergence). **The archived row is never deletable** — the row is the queryable cache of the ledger's migration log, the very answer to "where did this dataset go" (the same "the row is not removed" principle as a capture's tombstone). The reverse guards: an archived capture (its bytes are gone) and a member of a non-active dataset (its bytes are on their way out) cannot be added to a new dataset.
- **views/**: `list_view_entries` restricts itself to `status='active'`. Starting an archive removes the dataset from views/ **as a declaration** — never by dropping into regeneration's "the source is gone, skip it" path.
- **rebuild**: `dataset_archive_started` reconstructs the dataset row and the member rows on its own (a self-contained payload, against a truncated ledger), and with no seal present it restores the dataset **still `archiving`** — resumability survives the total loss of the DB. The members' capture rows are carried, unchanged, by the existing `capture_archived` reconstruction.
- **Progress**: volatile (`GET /api/v1/datasets/{id}/archive`). The count of completed members is derived from the rows; the bytes being copied and the halt reason are process memory — honestly reset by a restart. It is not put in the jobs table (the volatile, out-of-rebuild contract).

## 7. Unified deletion (via trash, with tombstones)

The common path for discard (discarding something not yet sent) and delete.

**Preconditions**: while a capture lease is live, `409 capture_busy` / while `recording` or `stopping`, `409` / while referenced from `dataset_members`, `400` (remove the member first).

```
1. ledger.append(kind=…)                      — fatal. If it cannot be written, abort
2. DB tx: captures.state → delete_pending, record deleted_at/delete_kind/reason
3. atomic rename objects/<id> → .trash/<id> (sibling files move too)
4. DB tx: captures.state → discarded|deleted (tombstone committed. The row is not removed)
5. reaper: physically delete .trash/<id> → "only after verifying the absence of .trash/<id>",
   replicas.state → absent_managed. If debris remains, stay trashed and retry up to a cap;
   exceeding it surfaces as a warning (no infinite loops)
```

- `delete_pending` is not "cleanup for a failed rename" — it is **a durable marker written before the rename**.
- **Resume rule (reconciler, an idempotent 3-way branch)**: for a row with `state=delete_pending`, if `objects/<id>` exists, rename and go to 4 / if `.trash/<id>` exists, go to 4 / if neither exists, go to 4.
- **Startup delete-resume** (not only on rebuild — **always run on a normal startup too**): scan the ledger's `capture_discarded` / `capture_deleted` and, for any whose `objects/<id>` still remains, re-run from step 2 (idempotent via `event_id`). A crash between steps 1 and 2 leaves not even a `delete_pending` row, so reading the ledger every time is the only way to recover them.
- A rename does not fail because of an open FD (POSIX). Protection against running jobs is done with a **lease**, not with FDs.
- **No restore-from-`.trash` feature is provided** (it is one-way). We refuse to tell the lie of writing "you can put it back" and then letting the reaper get there first.
- Deletion also reclaims `report/<pipeline>/<capture_id>/` (stopping the artifacts of a discarded capture from being served on and on). This is scan-based rather than trash-based and sits outside the reaper's retry count — a report is a derivative, so failing to delete it must not hold up the deletion of the capture.
- **An external `rm -rf` is not a deletion**: `replicas.state → missing_unmanaged`, `captures.state` unchanged, surfaced in the warning UI (under the threshold guard described below).
- Capacity calculations count `.trash` and `.incoming`.

### 7.1 capture lease

`captures` carries `lease_owner` / `lease_expires_at`. The digest job and dora_runner jobs acquire a lease before touching `objects/<id>`. discard / delete answer `409` while a lease is live.

- A job that has lost its lease, or whose state is no longer terminal, **aborts and writes nothing**.
- **The digest job** holds the lease for the entire span of its run and, **immediately before the final manifest write, re-reads both `captures.state` and its own hold on the lease**. If either has broken (it became `delete_pending|discarded|deleted`, or the lease was lost) it **aborts right there — it does not update**. What closes the window is not a DB lock but **the lease itself**; the last re-read merely confirms, at the final moment a write is still possible, the §7.1 requirement that "a job that has lost its lease gives up quietly and writes nothing".
- **A job must not create `objects/<id>/`** (writing a tmp there would resurrect the tree).
- dora_runner's jobs may remain **lease-unaware** (they write only to `report/`, so the ban on writing to `objects/` holds structurally). orchestrator manages the lease on their behalf: acquire on submission, **renew when a status / result poll observes a non-terminal state (renew-on-poll)**, and release within the owner scope once a terminal state is observed.
  - **Acquisition necessarily comes after the job is created** (the order is forced). The lease's owner string is `job:<job_id>`, and it is dora_runner that issues `job_id`, so without creating the job there is no owner to name — that id is precisely the name shown to the operator in a `409`, and the key matched against on release. The create → acquire order therefore cannot be broken. **If the acquire fails, the job just created is undone** (a compensating cancel). A cheap pre-check is also run once before creation to reduce how often that compensation path is entered (the authoritative decision remains the acquire that follows).
- **What the TTL does not guarantee (stated honestly)**: renew-on-poll guarantees "**it stays alive while someone is watching**"; it does **not** cover waiting in the queue. dora_runner caps its concurrency, so a submitted job can sit behind other jobs, and if nobody polls during that time the lease expires and delete wins. That job then **fails cleanly** against a directory that has since moved to `.trash` — a slow, orderly ending, not corruption. We accept this failure rather than run a renewal loop for jobs the orchestrator is not watching.
- An expired lease is not a lease (`acquire_lease` compares against the current time), so a job whose process died never locks a capture forever. The property this design leans on is that **every failure converges toward "you can delete it again"**.

## 8. DB schema v2 and rebuild

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
batches(unchanged. Only its references now point at captures)
replicas(capture_id, instance_id, state, path, manifest_digest, verified_at,
         updated_at, PRIMARY KEY(capture_id, instance_id))
datasets(dataset_id PK, name, operator, task, status, created_at,
         archive_destination, archive_started_at, archived_at)
dataset_members(membership_id PK, dataset_id, capture_id, display_index,
                UNIQUE(dataset_id, display_index), UNIQUE(dataset_id, capture_id))
jobs / validation_templates / plan_catalog(unchanged)
```

`digest_state` is **not a column** — it is derived from the local `replicas` row (`present_verified` ⇔ `complete`). This keeps "never promote to `present_verified` before verification" (safety principle 4) as a single fact.

### 8.1 State machines

**capture state** (`captures.state`)

```
recording ──▶ stopping ──▶ completed
    │                          │
    └──▶ failed                └──▶ (below: the delete path only)
    └──▶ interrupted ──────────▶ delete_pending ──▶ discarded | deleted
```

Only these five — `recording` / `stopping` / `completed` / `interrupted` / `failed` — can ever be written into a manifest. `delete_pending` / `discarded` / `deleted` exist only in the DB and the ledger — **a manifest never says "deleted"**. Because a deletion is precisely the act of taking that manifest away.

**replica state** (`replicas.state`, i.e. "where the copy stands on this installation")

| state | Meaning |
|---|---|
| `present_unverified` | Here, but the digest is unverified |
| `present_verified` | Here, and the digest has been confirmed to match |
| `trashed` | In `.trash/` (awaiting the reaper) |
| `absent_managed` | kairos deleted it deliberately (the reaper finished) |
| `missing_unmanaged` | **Vanished outside of kairos.** A warning |
| `corrupt` | The sidecar cannot be read |

`missing_unmanaged` matters most. An external `rm -rf` produces it. Bytes being erased behind kairos's back is not a deletion, so the capture row stays, the replica says "a copy vanished although nobody asked for it", and **it never looks like a completed cleanup**.

### 8.2 rebuild (full reconstruction from the sidecars)

**Inputs**: `objects/*/object_manifest.json`, `objects/*.failed.json`, `record.json`, `lifecycle.jsonl`. `jobs` is treated as volatile and is out of scope for rebuild. `validation_templates` and `plan_catalog` are duplicated into sidecars under `catalog/*.json` when saved, and restored by rebuild. A dataset's archive state (§6.1: `archiving` / `archived`, destination included) is restored by replaying the ledger.

**Conditions for rebuilding at startup**: the DB is absent / the schema version differs / an explicit request via `KAIROS_REBUILD`. It is not something that runs on every startup.

**Rules**:

1. First query recorder's `GET /record/status` and **exclude live captures** (create no row; leave them to the normal finalize path). When recorder cannot be reached, **leave manifests with `state ∈ {recording, stopping}` unconverted** and pass over them again once a response is obtained. If the response has no `live_capture_ids` array, treat that as **recorder unreachable**, not as "the live set is empty".
2. When turning `state=recording|stopping` into a row, **always normalize it to `interrupted`** (anything with neither a `metadata.yaml` nor a `.mcap` is `failed` — matching recorder's finalise decision).
3. **For tombstones, the ledger takes precedence over the manifest.**
4. A 0-byte / unparsable manifest is **reported as CORRUPT** (treating it as "does not exist" is forbidden). **No `captures` row is created for that capture** — that manifest was the only thing that could say "what this capture is", so creating a row would be fabrication. Instead, two things are emitted: (a) an entry in the corrupt list (with the reason) and (b) a **replica row** with `state=corrupt`. This is so that the set of rows itself can say "the bytes are here, but their description is broken". As a consequence, joining `captures` to `replicas` leaves the corrupt replica with no counterpart — **that is exactly the set to repair**, so a reader has to tolerate this mismatch.
5. Review fields follow the divergence rule of §4.1-4 (sidecar wins; the reverse direction is a warning).
6. **`batches` rows are not rebuilt** (a known loss). `batch_id` / `index_in_batch` on the `captures` side are restored from `record.json`, so "which capture was which number in which batch" survives, but there is no way to restore the batch row itself (`project` / `robot` / `condition` / `target_episodes` / `batch_seq` / `status`) — none of those are written into any sidecar. `episodes_recorded` is not re-initialized either. After a rebuild, an existing capture can end up still pointing at a `batch_id` whose row does not exist.

### 8.3 Periodic reconciler

A consistency pass that runs continuously, separate from rebuild. It picks up:

- An `objects/<id>` that has a valid manifest but no DB row (where a crashed import or a race with rebuild lands) → adopt the row.
- Something left complete in `.incoming/<id>` (an importer that died between the rsync and the rename) → move it into `objects/` and adopt it.
- Terminal with `digest_state=pending` → re-submit to the digest queue.
- Resuming `delete_pending` (§7).
- Marking vanished copies `missing_unmanaged` (**under the threshold guard**, described below).
- Recording broken sidecars as `corrupt` and reflecting that in `GET /api/v1/store/health`.

When a non-terminal DB state and a terminal manifest disagree, **the manifest wins**.

## 9. Safety principles (exempt from breaking changes)

1. **The ledger is fatal, and ledger-first.** Step 1 of §7 always precedes step 2 and onward.
2. **`rm -rf` is not a deletion.** It is warned about as `missing_unmanaged`.
3. **The reconciler's threshold guard.** One pass proceeds in the following order, with **the more destructive a step is, the later it is placed**:
   1. Read the volume marker. If it cannot be read, decide nothing.
   2. Publish the completed staging in `.incoming/<id>` into `objects/` (`_adopt_incoming`). It is placed **before the scan** so that a capture that arrived from the robot gets its row in **this** pass rather than the next one. Putting it here is safe because it is a move between directories on the volume whose marker was just confirmed, and it destroys nothing — every write to the catalog is still guarded in full by the marker re-check that comes later.
   3. Scan `objects/` and assemble "what would be concluded if a rebuild ran right now".
   4. **Re-read the marker** and, if it has changed, **discard the whole pass** (the scan did run, but it described a volume nobody can confirm, so not even its corrupt list is accepted as evidence).
   5. Threshold guard: if the missing count exceeds `max(5, 10% of the population)`, apply nothing and go **SUSPECT**.
   6. Only now apply: adopting orphans, missing transitions, resuming deletions, the reaper, and digest re-submission.
   - The population is **the number of `replicas` rows for that instance with `state ∈ {present_*}`** (not the number of `captures` rows).
   - **What SUSPECT stops**: automatic missing transitions, the reaper, and digests for that storage.
   - **What it does not stop**: recording start/stop, review saves, browsing the catalog.
   - **Repair is offered only when the marker matches.** Approval while the marker cannot be read is refused (`409 volume_unidentified`) — "those really are gone" means nothing about a disk nobody can identify.
   - SUSPECT **latches**; it does not re-fire on every pass. Only an operator's Repair clears it.
4. **Promotion to `present_verified` before digest verification is forbidden.** The digest job starts only after confirming both (a) `captures.state` is terminal and (b) recorder does not hold that capture.
5. **Recording start/stop does not depend on the ledger, the digest, or the completion of a rebuild.** Even on a full disk, the recording path alone keeps working (the slack of §5 guarantees the recovery path via discard).

These are not the kind of properties you can "fix later". Break one even once, and you lose either the data itself or the fact that it was lost.

## 10. The digest job

- Its start condition is safety principle 4. A background task after stop completes, plus **re-submission from the periodic reconciler** (picking up pending work stranded by normalization to `interrupted`).
- per-file sha256 → completed by the single atomic write of §3.3 → record `replicas.manifest_digest` → `present_verified`.
- While it runs, surface `digest_state=pending` in the UI (never blend "verified" with "being verified").
- After a crash, the reconciler re-submits the pending work (partial results are thrown away and it starts over).

## 11. API (summary)

See [api_orchestrator](api_orchestrator.md) for the exact shapes. This document states only **what the key is**:

- Every API that refers to a capture is keyed by `capture_id`. `run_id` is included in responses but is not used as a key.
- **Removed (with no compatibility aliases)**: all of `/api/v1/runs`, all of `/api/v1/episodes`, `GET|DELETE /api/v1/datasets/{op}/{task}/{index}`, `POST /api/v1/datasets/index/rebuild`, `POST /api/v1/datasets/export|export-all`.
- A job's only required input is `capture_id`. The source resolves to `objects/<capture_id>` (the `dataset_dir` param is removed). Artifacts go to `report/<pipeline>/<capture_id>/`.
- Retention redefined: candidates = "**captures that belong to no `dataset_members` and have remained at `review_status` `excluded` or `pending` past a set period**". The old definition "a row exists = not yet exported" is abolished entirely (because rows stopped disappearing, per §6). The dataset archive of §6.1 does not change this definition — an archived member keeps its member row and is therefore structurally excluded from the candidates, and with no bytes left it would be meaningless to reclaim anyway.
- **New (§6.1)**: `POST /api/v1/datasets/{id}/archive` (202; doubles as start and resume) and `GET /api/v1/datasets/{id}/archive` (progress). Not a revival of the old `POST /datasets/export` — this is a terminal carry-out with a ledger behind it, and neither the response nor the path is the same thing.

## 12. Acceptance (E2E)

**Acceptance is performed from the UI.** If the API is correct but the screen does not render the result, the feature does not exist.

```bash
make build       # required after a code change (see the caveat below)
make test-e2e    # bring the stack up → Playwright → bring the stack down
```

Playwright drives the real frontend in a real browser against a real stack brought up on a dedicated port, a dedicated data dir, and a dedicated compose project (able to coexist with a developer's `make up`). The topic source is a real rosbag played back in a loop. 6 scenarios:

| # | Scenario |
|---|---|
| 1 | Record in Collect → stop → appears in captures → digest pending → complete |
| 2 | Save a review → verify that `record.json` exists and check its `revision`. A conflicting save is **rejected out loud** |
| 3 | Discard → modal requiring a reason → disappears from the list → a tombstone in the ledger |
| 4 | Delete `kairos.db` → restart → restored in the UI (including that a failed-start row does not take down the catalog) |
| 5 | `rm -rf` an `objects/<id>` → SUSPECT → Repair → `missing_unmanaged` displayed (nothing disappears silently) |
| 6 | Build a dataset → Archive (§6.1) → the archived badge → the views shape plus the manifest at the destination (sha256 measured and matching) → gone from `objects/` → after deleting `kairos.db` and restarting, still archived and still able to name the destination |

- **The UI result is the first-class assertion**; the sidecars (`object_manifest.json` / `record.json` / `lifecycle.jsonl`) and the API are examined as its corroboration.
- **Do not skip silently.** A scenario whose environment is not ready fails rather than skips (an acceptance test that quietly evaporates reports a branch nobody tested as green).
- **`make test-e2e` does not build images** (the same rule as `make up` — a build needs the network even when nothing changed). **Forget `make build` after a code change and you get a green against the stale code inside the container.** A stale image is more dangerous than a missing one, so treat this caveat as an operational requirement.

The pytest side guards a different layer: crash injection (kill → restart → resume) at each of steps 1–5 of §7, the threshold guard, rebuild's normalization rules, review CAS, the reaper's idempotency and verification, and lease contention.

## 13. Out of scope (next branch)

- The edge → server transfer subsystem, hub mode, receipts, drop-local (formal replica management for copies left behind on the robot is resolved there). In the current split deployment, a discard is "**discarding the copy on the recording PC**", and a copy may still remain on the robot — the UI states that honestly alongside.
- `task_revision_id`, and automating retention / capacity (this branch goes **only as far as fixing the definitions that are displayed**).
