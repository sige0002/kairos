# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""SQLite DDL and column allow-lists for the capture store.

Split out of ``store.py`` so the schema reads as one document. The store is an
index rebuilt from sidecars (see ``store.py``'s module docstring): there are no
migrations, so this file plus :data:`SCHEMA_VERSION` fully describe what a
``kairos.db`` can look like.
"""

from __future__ import annotations

# The schema generation this code speaks. A database stamped with anything else
# is discarded and rebuilt from sidecars — see the store.py module docstring.
#
# BUMP THIS WHENEVER SCHEMA CHANGES. The jobs run_id→capture_id rename shipped
# without a bump, so live version-2 databases existed with EITHER shape and
# every POST /jobs against an old one died on "no column named capture_id" —
# found in the field, not by tests, because tests only ever see fresh schemas.
# The rebuild is the designed absorption path; refusing to bump is how it is
# bypassed by accident.
SCHEMA_VERSION = 9

SCHEMA = """
-- One recording, merged with the operator's review of it. Replaces v1's
-- runs + episodes pair: those were joined on run_id in every read path, and
-- keeping them apart meant a delete had to cascade correctly in two places.
CREATE TABLE IF NOT EXISTS captures (
    -- Insertion order for cursor paging. capture_id is a UUIDv7 and would sort
    -- by mint time too, but seq is stable against a rebuild that re-inserts
    -- rows in directory order.
    seq                INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id         TEXT NOT NULL UNIQUE,
    -- Display name only (§1). NULL is allowed and meaningful: a row rebuilt
    -- from a ledger tombstone alone has no run_id to recover.
    run_id             TEXT UNIQUE,
    source_instance_id TEXT,
    state              TEXT NOT NULL,
    operator           TEXT,
    task               TEXT,
    robot              TEXT,
    started_at         TEXT,
    ended_at           TEXT,
    topics             TEXT NOT NULL DEFAULT '[]',
    compression        TEXT NOT NULL DEFAULT 'none',
    split              TEXT,
    error              TEXT,
    message_count      INTEGER,
    bytes              INTEGER,
    quick_check        TEXT,
    -- Review columns: a CACHE of record.json, which is authoritative (§4.1-4).
    task_result        TEXT,
    failure_reason     TEXT,
    quality            TEXT,
    quality_source     TEXT,
    review_status      TEXT NOT NULL DEFAULT 'pending',
    -- The CAS token. 0 means no record.json exists at all.
    review_revision    INTEGER NOT NULL DEFAULT 0,
    batch_id           TEXT,
    index_in_batch     INTEGER,
    -- Context frozen at start, including the batch labels this capture may
    -- later be reviewed into. It is a sidecar-backed JSON snapshot, not a
    -- second mutable set of provenance columns.
    collection_context TEXT,
    -- A human's override of a NEEDS_REVIEW validation verdict, so a dataset
    -- add can consult it in one read. The verdict itself is DERIVED from the
    -- reports on disk (see verdict.py) and deliberately not cached here; only
    -- the human decision is stored, and the ledger keeps its audit copy.
    validation_override TEXT,
    -- Tombstone (§7). The row is never deleted, only marked.
    deleted_at         TEXT,
    delete_kind        TEXT,
    delete_reason      TEXT,
    -- Archive (§6). Beyond §8's column list, and deliberately: rebuild
    -- reconstructs a row from a capture_archived event and carries these two
    -- fields, so without columns for them every rebuild would forget where an
    -- archived capture went — the one question the archive event exists for.
    archived_at        TEXT,
    archive_destination TEXT,
    -- Leases (§7.1) live in capture_leases, not here: a capture can be held by
    -- SEVERAL readers at once (N camera encoders on one recording), which a
    -- pair of columns cannot express.
    created_at         TEXT,
    updated_at         TEXT
);
-- There is deliberately NO index on `seq`. It is INTEGER PRIMARY KEY, so it IS
-- the rowid, and the keyset page already seeks through the table B-tree:
-- `EXPLAIN QUERY PLAN` gives `SEARCH captures USING INTEGER PRIMARY KEY
-- (rowid<?)` with or without one. An index on it is a second copy of the rowid
-- that no query reads and every insert maintains. Dropped rather than merely
-- not created, so databases that already carry it shed it too.
DROP INDEX IF EXISTS idx_captures_seq;
CREATE INDEX IF NOT EXISTS idx_captures_state ON captures (state);
CREATE INDEX IF NOT EXISTS idx_captures_batch ON captures (batch_id);

-- §7.1 leases: who is touching objects/<capture_id> right now. SHARED — any
-- number of readers may hold one capture at once, which is what lets the N
-- camera encoders of one recording run in parallel. What the lease protects is
-- unchanged: discard and delete refuse while ANY live holder remains.
--
-- One row per (capture, owner) so a holder can be renewed and released on its
-- own. Volatile and NOT rebuilt (§8): a lease describes a process that is
-- running now, and a rebuild happens when no such process exists — resurrecting
-- one would lock a capture out of deletion with no job left to release it.
CREATE TABLE IF NOT EXISTS capture_leases (
    capture_id  TEXT NOT NULL,
    owner       TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    acquired_at TEXT,
    PRIMARY KEY (capture_id, owner)
);
-- Covers both questions asked of this table: "is anyone still holding this
-- capture" and "who, and until when".
CREATE INDEX IF NOT EXISTS idx_capture_leases_live
    ON capture_leases (capture_id, expires_at);

-- Captures with their lease summary attached, so every read path that already
-- did ``SELECT * FROM captures`` keeps one statement and one row shape. The
-- summary is deliberately the LATEST-expiring live holder: that is the honest
-- scalar answer to "who is blocking me and until when", because it is the
-- moment the capture becomes deletable. A caller that needs all of them asks
-- ``lease_holders`` (the 409 body does).
--
-- Expired rows are filtered here rather than deleted on a timer: an expired
-- lease is already not a lease, so a reader that dies costs one stale row until
-- the next acquire on that capture sweeps it, and never a capture that cannot
-- be deleted.
DROP VIEW IF EXISTS captures_with_lease;
CREATE VIEW captures_with_lease AS
SELECT c.*,
       (SELECT l.owner FROM capture_leases l
         WHERE l.capture_id = c.capture_id
           AND l.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         ORDER BY l.expires_at DESC LIMIT 1) AS lease_owner,
       (SELECT MAX(l.expires_at) FROM capture_leases l
         WHERE l.capture_id = c.capture_id
           AND l.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS lease_expires_at
FROM captures c;

-- Where each installation's copy of a capture stands. Keyed by instance so a
-- transferred capture can say "present here, absent there" rather than one
-- global boolean that is wrong on at least one machine.
CREATE TABLE IF NOT EXISTS replicas (
    capture_id      TEXT NOT NULL,
    instance_id     TEXT NOT NULL,
    state           TEXT NOT NULL,
    path            TEXT,
    manifest_digest TEXT,
    verified_at     TEXT,
    updated_at      TEXT,
    PRIMARY KEY (capture_id, instance_id)
);
CREATE INDEX IF NOT EXISTS idx_replicas_state ON replicas (instance_id, state);

-- A dataset is rows plus ledger events (§6). No directory tree, no move, no
-- dataset.json: the physical <operator>/<task>/<NNN> hierarchy is retired.
CREATE TABLE IF NOT EXISTS datasets (
    dataset_id TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    operator   TEXT,
    task       TEXT,
    status     TEXT NOT NULL DEFAULT 'active',
    created_at TEXT,
    -- Highest display_index ever ISSUED in this dataset, including numbers
    -- whose member has since been removed. Numbers are never reused (§6), so
    -- the next one is always this + 1 — MAX() over live members would hand a
    -- retired number to a different recording.
    index_high_water INTEGER NOT NULL DEFAULT 0,
    -- The terminal transition (§6.1). These cache what the ledger's archive
    -- events hold durably: the resolved directory the bytes went to, when,
    -- and HOW — mode 'copy' sealed the set and kept the recordings here,
    -- 'move' removed them. A zero-progress canceled attempt is the sole
    -- archiving → active edge; archived never returns.
    archive_destination TEXT,
    archive_mode        TEXT,
    archive_started_at  TEXT,
    archived_at         TEXT
);

CREATE TABLE IF NOT EXISTS dataset_members (
    membership_id TEXT PRIMARY KEY,
    dataset_id    TEXT NOT NULL,
    capture_id    TEXT NOT NULL,
    display_index INTEGER NOT NULL,
    created_at    TEXT,
    UNIQUE (dataset_id, display_index),
    UNIQUE (dataset_id, capture_id)
);
CREATE INDEX IF NOT EXISTS idx_members_capture ON dataset_members (capture_id);

CREATE TABLE IF NOT EXISTS jobs (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id     TEXT NOT NULL UNIQUE,
    capture_id TEXT NOT NULL,
    pipeline   TEXT NOT NULL,
    state      TEXT NOT NULL,
    progress   REAL NOT NULL DEFAULT 0,
    logs_tail  TEXT NOT NULL DEFAULT '[]',
    result     TEXT,
    created_at TEXT,
    updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_seq ON jobs (seq DESC);

CREATE TABLE IF NOT EXISTS validation_templates (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    version         INTEGER NOT NULL,
    required_topics TEXT NOT NULL DEFAULT '[]',
    UNIQUE (name, version)
);
CREATE INDEX IF NOT EXISTS idx_validation_templates_seq
    ON validation_templates (seq DESC);

CREATE TABLE IF NOT EXISTS batches (
    seq               INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id          TEXT NOT NULL UNIQUE,
    robot             TEXT,
    project           TEXT,
    task              TEXT,
    condition         TEXT,
    operator          TEXT,
    target_episodes   INTEGER NOT NULL DEFAULT 30,
    status            TEXT NOT NULL DEFAULT 'active',
    ended_reason      TEXT,
    created_at        TEXT,
    ended_at          TEXT,
    -- Monotone: incremented on the FIRST review save for a capture and never
    -- decremented, so "N / 30" keeps describing what was captured even after a
    -- later exclude or delete.
    episodes_recorded INTEGER NOT NULL DEFAULT 0,
    -- 1 when the counter above was reconstructed by a rebuild and is therefore
    -- a lower bound (§8.2 rule 6): review saves are events, and a rebuild can
    -- only count the recordings still on disk that name this batch.
    episodes_recorded_is_floor INTEGER NOT NULL DEFAULT 0,
    batch_seq         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_batches_seq ON batches (seq DESC);

CREATE TABLE IF NOT EXISTS plan_catalog (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    payload    TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

# Columns :meth:`CaptureStore.update_capture` may target. A typo guard: an
# unknown name raises instead of silently updating nothing.
CAPTURE_COLUMNS: frozenset[str] = frozenset(
    {
        "run_id",
        "source_instance_id",
        "state",
        "operator",
        "task",
        "robot",
        "started_at",
        "ended_at",
        "topics",
        "compression",
        "split",
        "error",
        "message_count",
        "bytes",
        "quick_check",
        "task_result",
        "failure_reason",
        "quality",
        "quality_source",
        "review_status",
        "review_revision",
        "validation_override",
        "batch_id",
        "index_in_batch",
        "collection_context",
        "deleted_at",
        "delete_kind",
        "delete_reason",
        "archived_at",
        "archive_destination",
    }
)

# Columns a §4.1 review save may write. Deliberately narrower than
# CAPTURE_COLUMNS, and the line it draws is between MEASUREMENTS and LABELS.
#
# A measurement — bytes, message_count, topics, started_at, ended_at, state —
# is what the recorder observed, and a review may never reach one. Editing a
# measurement would make the catalog disagree with the sealed manifest about
# what is in the bag, and §8 rebuilds from that manifest, so the edit would
# silently revert. There is no honest way to offer it.
#
# A label — operator, task, robot — is a human's statement about the recording,
# and a review MAY write one (§4.3). The case that forced the distinction is the
# imported bag: it is born with no operator and no task, because nobody was
# there to record them, and the only way it can ever have them is for a person
# to say so afterwards. The manifest is still never rewritten; the override
# lives in record.json's ``labels`` block, which is what makes "this was
# edited" a durable fact and what lets rebuild re-apply it over the manifest.
REVIEW_COLUMNS: frozenset[str] = frozenset(
    {
        "task_result",
        "failure_reason",
        "quality",
        "quality_source",
        "review_status",
        "batch_id",
        "index_in_batch",
        "operator",
        "task",
        "robot",
    }
)

BATCH_UPDATE_FIELDS: frozenset[str] = frozenset(
    {
        "robot",
        "project",
        "task",
        "condition",
        "operator",
        "target_episodes",
        "status",
        "ended_reason",
        "created_at",
        "ended_at",
    }
)

JSON_COLUMNS: frozenset[str] = frozenset(
    {"topics", "split", "error", "quick_check", "collection_context"}
)
