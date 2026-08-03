"""SQLite capture store v2 — the queryable cache in front of the sidecars.

Contract §8. The v1 store treated ``kairos.db`` as the source of truth and the
recorder's manifest as an audit trail. v2 inverts that: the sidecars beside each
capture (``object_manifest.json``, ``record.json``) plus ``lifecycle.jsonl`` are
authoritative, and this database is an index that can be **deleted and rebuilt**
from them. That inversion is what makes "the DB is corrupt" a restart rather
than a data-loss incident, and it is why there are no migrations here.

Three consequences show up directly in the code below:

**No migration path, ever.** ``PRAGMA user_version`` records the schema
generation; a database that does not carry :data:`SCHEMA_VERSION` is *deleted*
and recreated empty, with :attr:`CaptureStore.was_discarded` telling the caller
a full rebuild is now mandatory. Absorbing a schema change through a rebuild is
the first choice (§8), so an ALTER-TABLE ladder would only be a second, weaker
copy of a mechanism that already exists.

**Review saves are a compare-and-swap, not an update.** ``review_revision`` is
the token: :meth:`save_review_cas` writes only if the row still holds the
revision the caller read. Two terminals editing one capture therefore produce a
409 for the loser instead of a silent overwrite (§4.1).

**Anything the database alone would know is mirrored to disk.** Validation
templates and the plan catalog have no sidecar of their own, so saving one also
writes ``catalog/*.json`` — otherwise "delete kairos.db and restart" would
quietly lose the UI's vocabulary.

The store stays small and synchronous (stdlib ``sqlite3``). A reentrant lock
serializes connection use so FastAPI's thread pool cannot interleave access.
That lock is **not** the review mutex: §4.1 requires a per-capture mutex held
across a filesystem write, which a global connection lock must never be taken
for.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from collections.abc import Iterable, Iterator, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from kairos_common import Compression, JobState
from kairos_common.atomic_io import atomic_write_json
from kairos_common.capture_sidecars import DigestState
from kairos_common.ids import new_membership_id
from kairos_common.rebuild import CaptureRow, ReplicaRow, ReplicaState
from kairos_common.time import utc_now_iso8601

from api_orchestrator.models import (
    Batch,
    Capture,
    CaptureState,
    CaptureTopic,
    DatasetMember,
    DatasetMembership,
    JobCreateResponse,
    JobResult,
    JobStatus,
    QuickCheck,
    Replica,
    Split,
    ValidationTemplate,
    coerce_error,
)

logger = logging.getLogger("kairos")

# The schema generation this code speaks. A database stamped with anything else
# is discarded and rebuilt from sidecars — see the module docstring.
#
# BUMP THIS WHENEVER _SCHEMA CHANGES. The jobs run_id→capture_id rename shipped
# without a bump, so live version-2 databases existed with EITHER shape and
# every POST /jobs against an old one died on "no column named capture_id" —
# found in the field, not by tests, because tests only ever see fresh schemas.
# The rebuild is the designed absorption path; refusing to bump is how it is
# bypassed by accident.
SCHEMA_VERSION = 4

CATALOG_DIRNAME = "catalog"
TEMPLATES_SIDECAR = "validation_templates.json"
PLAN_CATALOG_SIDECAR = "plan_catalog.json"

# Replica states that mean "the bytes are on this machine right now". The §9-3
# threshold guard counts these as its denominator, and the digest job only ever
# runs against one of them.
PRESENT_REPLICA_STATES: frozenset[str] = frozenset(
    {ReplicaState.present_unverified.value, ReplicaState.present_verified.value}
)

# States reached only through the deletion path (§7). The row survives so
# "where did it go" stays answerable, but the operator's working list excludes
# them by default.
TOMBSTONE_STATES: frozenset[str] = frozenset(
    {CaptureState.discarded.value, CaptureState.deleted.value}
)


class CaptureExistsError(Exception):
    """A capture_id (or run_id) already has a row."""

    def __init__(self, capture_id: str) -> None:
        super().__init__(f"Capture already exists: {capture_id}")
        self.capture_id = capture_id


class BatchExistsError(Exception):
    """``batch_id`` already exists; the caller re-allocates and retries."""

    def __init__(self, batch_id: str) -> None:
        super().__init__(f"Batch already exists: {batch_id}")
        self.batch_id = batch_id


class DatasetMemberExistsError(Exception):
    """This capture is already a member of this dataset.

    A distinct error rather than a silent no-op: adding a capture twice would
    give it two display_indexes inside one dataset, and every downstream export
    would then contain the same take under two different numbers.
    """

    def __init__(self, dataset_id: str, capture_id: str) -> None:
        super().__init__(f"{capture_id} is already in dataset {dataset_id}")
        self.dataset_id = dataset_id
        self.capture_id = capture_id


_SCHEMA = """
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
    -- Lease (§7.1): a job is touching objects/<capture_id> right now.
    lease_owner        TEXT,
    lease_expires_at   TEXT,
    created_at         TEXT,
    updated_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_captures_seq ON captures (seq DESC);
CREATE INDEX IF NOT EXISTS idx_captures_state ON captures (state);
CREATE INDEX IF NOT EXISTS idx_captures_batch ON captures (batch_id);

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
    -- The terminal transition (§6.x). These cache what the ledger's
    -- dataset_archive_started / dataset_archived events hold durably: the
    -- resolved directory the bytes went to, and when. status walks
    -- active → archiving → archived and never back.
    archive_destination TEXT,
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
    project           TEXT NOT NULL,
    task              TEXT NOT NULL,
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
_CAPTURE_COLUMNS: frozenset[str] = frozenset(
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
        "batch_id",
        "index_in_batch",
        "deleted_at",
        "delete_kind",
        "delete_reason",
        "archived_at",
        "archive_destination",
        "lease_owner",
        "lease_expires_at",
    }
)

# Columns a §4.1 review save may write. Deliberately narrower than
# _CAPTURE_COLUMNS: a review edit must never reach a recording fact.
_REVIEW_COLUMNS: frozenset[str] = frozenset(
    {
        "task_result",
        "failure_reason",
        "quality",
        "quality_source",
        "review_status",
        "batch_id",
        "index_in_batch",
    }
)

_BATCH_UPDATE_FIELDS: frozenset[str] = frozenset(
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

_JSON_COLUMNS: frozenset[str] = frozenset({"topics", "split", "error", "quick_check"})


class CaptureStore:
    """The v2 catalog: captures, replicas, datasets, batches, jobs, templates.

    Args:
        db_path: SQLite file (``/data/kairos.db`` in production). ``":memory:"``
            is supported for tests via one shared connection.
        data_dir: Data root. Catalog sidecars are written under
            ``<data_dir>/catalog/`` so the templates and plan catalog survive a
            database rebuild. ``None`` disables mirroring (in-memory tests).
        instance_id: This installation's id, used as the default when reading a
            capture's local replica. May be set later with
            :meth:`set_instance_id` (it is minted after the store opens).
    """

    def __init__(
        self,
        db_path: str | Path,
        *,
        data_dir: str | Path | None = None,
        instance_id: str | None = None,
    ) -> None:
        self._path = str(db_path)
        self._data_dir = Path(data_dir) if data_dir is not None else None
        self._instance_id = instance_id
        # Serializes every connection use (reentrant: write helpers nest reads).
        self._lock = threading.RLock()
        self._shared: sqlite3.Connection | None = None
        self.was_discarded = False
        # Whether a database file was already there when this process opened it.
        # ``False`` is one of §8's three rebuild triggers ("kairos.db missing"),
        # and it can only be observed here — a moment later the file exists
        # because we just created it.
        self.existed_at_open = False

        if self._path != ":memory:":
            Path(self._path).parent.mkdir(parents=True, exist_ok=True)
            self.existed_at_open = Path(self._path).exists()
            self.was_discarded = self._discard_if_wrong_version(Path(self._path))
        else:
            # In-memory DBs vanish when their connection closes, so keep one.
            # check_same_thread=False: FastAPI runs sync handlers in a thread
            # pool; the module lock serializes access.
            self._shared = sqlite3.connect(self._path, check_same_thread=False)
            self._shared.row_factory = sqlite3.Row

        with self._conn() as conn:
            if self._shared is None:
                # WAL persists in the file header and lets readers run
                # concurrently with the single writer, so a long capture list
                # never blocks a recording-state write.
                conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(_SCHEMA)
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    @staticmethod
    def _discard_if_wrong_version(path: Path) -> bool:
        """Delete a database that is not this schema generation. ``True`` = did.

        §8 replaces migrations with rebuild, so a stale database is thrown away
        rather than upgraded. The WAL and shared-memory siblings go too: leaving
        a ``-wal`` behind would let SQLite replay committed v1 pages into the
        fresh file and resurrect exactly the schema we just decided not to
        speak.
        """
        if not path.exists():
            return False
        try:
            conn = sqlite3.connect(path)
            try:
                version = conn.execute("PRAGMA user_version").fetchone()[0]
            finally:
                conn.close()
        except sqlite3.DatabaseError:
            # Not a readable SQLite file at all. It cannot be the v2 catalog,
            # and it is rebuildable, so it goes.
            version = None
        if version == SCHEMA_VERSION:
            return False
        logger.warning(
            "kairos.db is schema version %s, not %s; discarding it and "
            "rebuilding the catalog from sidecars (contract §8)",
            version,
            SCHEMA_VERSION,
        )
        for suffix in ("", "-wal", "-shm"):
            Path(str(path) + suffix).unlink(missing_ok=True)
        return True

    def set_instance_id(self, instance_id: str) -> None:
        """Adopt this installation's id for local-replica reads."""
        self._instance_id = instance_id

    @property
    def instance_id(self) -> str | None:
        return self._instance_id

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        """Yield a connection under the lock, committing on success."""
        with self._lock:
            if self._shared is not None:
                yield self._shared
                self._shared.commit()
                return
            conn = sqlite3.connect(self._path)
            conn.row_factory = sqlite3.Row
            # busy_timeout is per-connection: wait for a competing writer rather
            # than raising "database is locked" at once.
            conn.execute("PRAGMA busy_timeout = 5000")
            try:
                yield conn
                conn.commit()
            finally:
                conn.close()

    def close(self) -> None:
        """Close the shared in-memory connection (no-op for file DBs)."""
        if self._shared is not None:
            self._shared.close()
            self._shared = None

    def execute_read(self, sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
        """Run an arbitrary read. For diagnostics and tests, not hot paths."""
        with self._conn() as conn:
            return list(conn.execute(sql, params).fetchall())

    # ---- captures ----------------------------------------------------------

    def create_capture(self, capture: Capture) -> Capture:
        """Insert a capture row. Raises :class:`CaptureExistsError` on a clash."""
        now = utc_now_iso8601()
        capture.created_at = capture.created_at or now
        capture.updated_at = capture.updated_at or now
        columns = self._capture_columns(capture)
        names = ", ".join(columns)
        placeholders = ", ".join("?" for _ in columns)
        with self._conn() as conn:
            try:
                conn.execute(
                    f"INSERT INTO captures ({names}) VALUES ({placeholders})",
                    list(columns.values()),
                )
            except sqlite3.IntegrityError as exc:
                raise CaptureExistsError(capture.capture_id) from exc
        return capture

    def upsert_capture(self, capture: Capture) -> Capture:
        """Insert *capture*, or update every column of an existing row.

        Used by paths that must be idempotent across a restart (import arrival,
        orphan adoption), where "did I already write this row" is not knowable
        without a read that would then race the write.
        """
        try:
            return self.create_capture(capture)
        except CaptureExistsError:
            fields = {
                name: value
                for name, value in self._capture_columns(capture).items()
                if name not in ("capture_id", "created_at")
            }
            self.update_capture(capture.capture_id, _raw=fields)
            return capture

    def get_capture(
        self, capture_id: str, *, instance_id: str | None = None
    ) -> Capture | None:
        """Return one capture with its local replica attached, or ``None``."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM captures WHERE capture_id = ?", (capture_id,)
            ).fetchone()
            if row is None:
                return None
            capture = self._capture_from_row(row)
            self._attach_replica(conn, [capture], instance_id or self._instance_id)
            self._attach_memberships(conn, [capture])
        return capture

    def list_captures(
        self,
        limit: int,
        cursor: int | None = None,
        *,
        state: str | None = None,
        review_status: str | None = None,
        task: str | None = None,
        operator: str | None = None,
        robot: str | None = None,
        batch_id: str | None = None,
        include_deleted: bool = False,
        instance_id: str | None = None,
    ) -> tuple[list[Capture], int | None]:
        """One page of captures, newest first, plus the next cursor.

        The cursor is the ``seq`` of the last item on the previous page. One
        extra row is fetched to decide whether a next page exists.
        """
        clauses: list[str] = []
        params: list[Any] = []
        for column, value in (
            ("state", state),
            ("review_status", review_status),
            ("task", task),
            ("operator", operator),
            ("robot", robot),
            ("batch_id", batch_id),
        ):
            if value is not None:
                clauses.append(f"{column} = ?")
                params.append(value)
        # Tombstones are hidden from the DEFAULT list only. An explicit
        # ``state=`` filter is honoured verbatim — a caller that asked for
        # discarded captures gets them — which is why this is skipped whenever
        # *state* is set, not just when *include_deleted* is.
        if not include_deleted and state is None:
            placeholders = ", ".join("?" for _ in TOMBSTONE_STATES)
            clauses.append(f"state NOT IN ({placeholders})")
            params.extend(sorted(TOMBSTONE_STATES))
        if cursor is not None:
            clauses.append("seq < ?")
            params.append(cursor)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(limit + 1)

        with self._conn() as conn:
            rows = conn.execute(
                f"SELECT * FROM captures {where} ORDER BY seq DESC LIMIT ?", params
            ).fetchall()
            has_more = len(rows) > limit
            page = rows[:limit]
            captures = [self._capture_from_row(r) for r in page]
            self._attach_replica(conn, captures, instance_id or self._instance_id)
            self._attach_memberships(conn, captures)
        next_cursor = int(page[-1]["seq"]) if has_more and page else None
        return captures, next_cursor

    def list_by_states(
        self, states: Iterable[str], *, instance_id: str | None = None
    ) -> list[Capture]:
        """Every capture currently in one of *states*, oldest first."""
        values = [str(s) for s in states]
        if not values:
            return []
        placeholders = ", ".join("?" for _ in values)
        with self._conn() as conn:
            rows = conn.execute(
                f"SELECT * FROM captures WHERE state IN ({placeholders}) ORDER BY seq",
                values,
            ).fetchall()
            captures = [self._capture_from_row(r) for r in rows]
            self._attach_replica(conn, captures, instance_id or self._instance_id)
        return captures

    def update_capture(
        self, capture_id: str, _raw: dict[str, Any] | None = None, **fields: Any
    ) -> Capture:
        """Patch selected columns and return the new state.

        ``_raw`` carries already-encoded column values (the upsert path);
        keyword fields are encoded here. Unknown names raise ``KeyError`` to
        catch typos rather than silently updating nothing.
        """
        columns: dict[str, Any] = dict(_raw or {})
        for name, value in fields.items():
            if name not in _CAPTURE_COLUMNS:
                raise KeyError(f"Unknown capture field: {name}")
            columns[name] = self._encode(name, value)
        if not columns:
            return self.get_capture_or_raise(capture_id)
        columns["updated_at"] = utc_now_iso8601()
        assignments = ", ".join(f"{name} = ?" for name in columns)
        with self._conn() as conn:
            cur = conn.execute(
                f"UPDATE captures SET {assignments} WHERE capture_id = ?",
                (*columns.values(), capture_id),
            )
            if cur.rowcount == 0:
                raise KeyError(capture_id)
        return self.get_capture_or_raise(capture_id)

    def get_capture_or_raise(self, capture_id: str) -> Capture:
        capture = self.get_capture(capture_id)
        if capture is None:
            raise KeyError(capture_id)
        return capture

    def get_capture_by_run_id(self, run_id: str) -> Capture | None:
        """Look a capture up by its display name (recorder correlation only)."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM captures WHERE run_id = ?", (run_id,)
            ).fetchone()
        return self._capture_from_row(row) if row is not None else None

    def save_review_cas(
        self, capture_id: str, *, base_revision: int, fields: dict[str, Any]
    ) -> bool:
        """Step 3 of §4.1: update the review columns **only if unchanged**.

        Returns ``False`` when the row's ``review_revision`` no longer equals
        *base_revision* (or the capture is gone), which the caller turns into a
        409. This is the whole concurrency story for review edits: no merge, no
        last-writer-wins, and no lock held across the HTTP round-trip.

        The sidecar has already been written at ``base_revision + 1`` by the
        time this runs, and is deliberately NOT rolled back on a loss — a
        sidecar ahead of the database is the direction rebuild can resolve.
        """
        unknown = set(fields) - _REVIEW_COLUMNS
        if unknown:
            raise KeyError(f"Not review fields: {sorted(unknown)}")
        assignments = ", ".join(f"{name} = ?" for name in fields)
        prefix = f"{assignments}, " if assignments else ""
        with self._conn() as conn:
            cur = conn.execute(
                f"UPDATE captures SET {prefix}review_revision = ?, updated_at = ? "
                "WHERE capture_id = ? AND review_revision = ?",
                (
                    *fields.values(),
                    base_revision + 1,
                    utc_now_iso8601(),
                    capture_id,
                    base_revision,
                ),
            )
        return cur.rowcount > 0

    def delete_capture_row(self, capture_id: str) -> bool:
        """Remove a capture row outright.

        Not part of the deletion path — §7 keeps the row as a tombstone. This
        exists for the reconciler's cleanup of rows that describe nothing at
        all (an adoption that was rolled back).
        """
        with self._conn() as conn:
            cur = conn.execute(
                "DELETE FROM captures WHERE capture_id = ?", (capture_id,)
            )
        return cur.rowcount > 0

    # ---- leases (§7.1) -----------------------------------------------------

    def acquire_lease(self, capture_id: str, owner: str, *, ttl_s: float) -> bool:
        """Take or renew the lease on a capture. ``False`` = someone else holds it.

        A job must hold this before touching ``objects/<capture_id>``, and
        discard/delete refuse while it is live. An **expired** lease is not a
        lease: a job that died holding one must not lock its capture out of
        deletion forever, which is why the guard compares against now rather
        than merely checking for a non-null owner.
        """
        now = datetime.now(UTC)
        expires = (now + timedelta(seconds=ttl_s)).isoformat().replace("+00:00", "Z")
        stamp = now.isoformat().replace("+00:00", "Z")
        with self._conn() as conn:
            cur = conn.execute(
                "UPDATE captures SET lease_owner = ?, lease_expires_at = ?, "
                "updated_at = ? WHERE capture_id = ? AND ("
                "  lease_owner IS NULL OR lease_owner = ? "
                "  OR lease_expires_at IS NULL OR lease_expires_at <= ?)",
                (owner, expires, stamp, capture_id, owner, stamp),
            )
        return cur.rowcount > 0

    def release_lease(self, capture_id: str, owner: str) -> bool:
        """Drop the lease if *owner* still holds it."""
        with self._conn() as conn:
            cur = conn.execute(
                "UPDATE captures SET lease_owner = NULL, lease_expires_at = NULL, "
                "updated_at = ? WHERE capture_id = ? AND lease_owner = ?",
                (utc_now_iso8601(), capture_id, owner),
            )
        return cur.rowcount > 0

    def has_live_lease(self, capture_id: str) -> bool:
        """Whether an unexpired lease is held on this capture."""
        stamp = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        with self._conn() as conn:
            row = conn.execute(
                "SELECT 1 FROM captures WHERE capture_id = ? "
                "AND lease_owner IS NOT NULL AND lease_expires_at > ?",
                (capture_id, stamp),
            ).fetchone()
        return row is not None

    def holds_lease(self, capture_id: str, owner: str) -> bool:
        """Whether *owner* still holds an unexpired lease (mid-job re-check)."""
        stamp = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        with self._conn() as conn:
            row = conn.execute(
                "SELECT 1 FROM captures WHERE capture_id = ? AND lease_owner = ? "
                "AND lease_expires_at > ?",
                (capture_id, owner, stamp),
            ).fetchone()
        return row is not None

    # ---- replicas ----------------------------------------------------------

    def upsert_replica(
        self,
        capture_id: str,
        instance_id: str,
        state: str,
        *,
        path: str | None = None,
        manifest_digest: str | None = None,
        verified_at: str | None = None,
    ) -> None:
        """Record where one installation's copy of a capture stands.

        ``verified_at`` is stamped automatically when the state becomes
        ``present_verified`` and the caller did not supply one — that state is
        only reachable through the digest job, so the moment of the write *is*
        the moment of verification (§9-4).
        """
        now = utc_now_iso8601()
        if verified_at is None and str(state) == ReplicaState.present_verified.value:
            verified_at = now
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO replicas
                    (capture_id, instance_id, state, path, manifest_digest,
                     verified_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(capture_id, instance_id) DO UPDATE SET
                    state = excluded.state,
                    path = COALESCE(excluded.path, replicas.path),
                    manifest_digest =
                        COALESCE(excluded.manifest_digest, replicas.manifest_digest),
                    verified_at =
                        COALESCE(excluded.verified_at, replicas.verified_at),
                    updated_at = excluded.updated_at
                """,
                (
                    capture_id,
                    instance_id,
                    str(state),
                    path,
                    manifest_digest,
                    verified_at,
                    now,
                ),
            )

    def get_replica(self, capture_id: str, instance_id: str) -> Replica | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM replicas WHERE capture_id = ? AND instance_id = ?",
                (capture_id, instance_id),
            ).fetchone()
        return self._replica_from_row(row) if row is not None else None

    def count_present_replicas(self, instance_id: str) -> int:
        """§9-3's denominator: this instance's copies that are on disk now."""
        placeholders = ", ".join("?" for _ in PRESENT_REPLICA_STATES)
        with self._conn() as conn:
            row = conn.execute(
                f"SELECT COUNT(*) AS n FROM replicas WHERE instance_id = ? "
                f"AND state IN ({placeholders})",
                (instance_id, *sorted(PRESENT_REPLICA_STATES)),
            ).fetchone()
        return int(row["n"])

    def list_replicas_by_state(
        self, instance_id: str, states: Iterable[str]
    ) -> list[tuple[str, Replica]]:
        """``(capture_id, replica)`` for this instance in any of *states*."""
        values = [str(s) for s in states]
        if not values:
            return []
        placeholders = ", ".join("?" for _ in values)
        with self._conn() as conn:
            rows = conn.execute(
                f"SELECT * FROM replicas WHERE instance_id = ? "
                f"AND state IN ({placeholders})",
                (instance_id, *values),
            ).fetchall()
        return [(row["capture_id"], self._replica_from_row(row)) for row in rows]

    def captures_needing_digest(self, instance_id: str) -> list[str]:
        """Terminal captures whose local copy is present but unverified.

        The digest job's work queue, and the set the reconciler re-enqueues
        after a crash (§8, §11). Anything tombstoned or leased is excluded here
        rather than at the job, so a full queue does not churn on rows that can
        never be processed.
        """
        stamp = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        terminal = sorted(
            {
                CaptureState.completed.value,
                CaptureState.interrupted.value,
                CaptureState.failed.value,
            }
        )
        placeholders = ", ".join("?" for _ in terminal)
        with self._conn() as conn:
            rows = conn.execute(
                f"""
                SELECT c.capture_id FROM captures c
                JOIN replicas r ON r.capture_id = c.capture_id
                WHERE r.instance_id = ?
                  AND r.state = ?
                  AND c.state IN ({placeholders})
                  AND (c.lease_owner IS NULL OR c.lease_expires_at <= ?)
                ORDER BY c.seq
                """,
                (
                    instance_id,
                    ReplicaState.present_unverified.value,
                    *terminal,
                    stamp,
                ),
            ).fetchall()
        return [row["capture_id"] for row in rows]

    # ---- datasets (§6) -----------------------------------------------------

    def create_dataset(
        self,
        dataset_id: str,
        *,
        name: str,
        operator: str | None = None,
        task: str | None = None,
        created_at: str | None = None,
    ) -> None:
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO datasets "
                "(dataset_id, name, operator, task, status, created_at) "
                "VALUES (?, ?, ?, ?, 'active', ?)",
                (dataset_id, name, operator, task, created_at or utc_now_iso8601()),
            )

    def get_dataset(self, dataset_id: str) -> dict[str, Any] | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM datasets WHERE dataset_id = ?", (dataset_id,)
            ).fetchone()
        return dict(row) if row is not None else None

    def list_datasets(self) -> list[dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT d.*, "
                "(SELECT COUNT(*) FROM dataset_members m "
                " WHERE m.dataset_id = d.dataset_id) AS member_count "
                "FROM datasets d ORDER BY d.created_at DESC, d.dataset_id DESC"
            ).fetchall()
        return [dict(row) for row in rows]

    def delete_dataset(self, dataset_id: str) -> bool:
        with self._conn() as conn:
            conn.execute(
                "DELETE FROM dataset_members WHERE dataset_id = ?", (dataset_id,)
            )
            cur = conn.execute(
                "DELETE FROM datasets WHERE dataset_id = ?", (dataset_id,)
            )
        return cur.rowcount > 0

    def set_display_index_high_water(self, dataset_id: str, value: int) -> None:
        """Raise a dataset's issued-number watermark (never lower it).

        A rebuild replays ``dataset_member_added`` events and knows which
        numbers were once issued even though no member row survives. Lowering
        the mark would re-issue a retired number, so this only ever raises it.
        """
        with self._conn() as conn:
            conn.execute(
                "UPDATE datasets SET index_high_water = MAX(index_high_water, ?) "
                "WHERE dataset_id = ?",
                (value, dataset_id),
            )

    def add_dataset_member(
        self,
        dataset_id: str,
        capture_id: str,
        *,
        membership_id: str | None = None,
        display_index: int | None = None,
    ) -> DatasetMember:
        """Add a capture to a dataset, allocating the next unused number.

        Allocation happens inside the same transaction as the insert (under the
        store lock), so two concurrent adds cannot read the same watermark.
        Raises :class:`DatasetMemberExistsError` if the capture is already a
        member.
        """
        membership_id = membership_id or new_membership_id()
        created_at = utc_now_iso8601()
        with self._conn() as conn:
            if display_index is None:
                row = conn.execute(
                    "SELECT index_high_water FROM datasets WHERE dataset_id = ?",
                    (dataset_id,),
                ).fetchone()
                if row is None:
                    raise KeyError(dataset_id)
                display_index = int(row["index_high_water"]) + 1
            try:
                conn.execute(
                    "INSERT INTO dataset_members "
                    "(membership_id, dataset_id, capture_id, display_index, "
                    " created_at) VALUES (?, ?, ?, ?, ?)",
                    (
                        membership_id,
                        dataset_id,
                        capture_id,
                        display_index,
                        created_at,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise DatasetMemberExistsError(dataset_id, capture_id) from exc
            conn.execute(
                "UPDATE datasets SET index_high_water = MAX(index_high_water, ?) "
                "WHERE dataset_id = ?",
                (display_index, dataset_id),
            )
        return DatasetMember(
            membership_id=membership_id,
            dataset_id=dataset_id,
            capture_id=capture_id,
            display_index=display_index,
            created_at=created_at,
        )

    def remove_dataset_member(self, dataset_id: str, membership_id: str) -> bool:
        """Remove one member. Its display_index stays retired (§6)."""
        with self._conn() as conn:
            cur = conn.execute(
                "DELETE FROM dataset_members WHERE dataset_id = ? "
                "AND membership_id = ?",
                (dataset_id, membership_id),
            )
        return cur.rowcount > 0

    def get_dataset_member(self, membership_id: str) -> DatasetMember | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM dataset_members WHERE membership_id = ?",
                (membership_id,),
            ).fetchone()
        return self._member_from_row(row) if row is not None else None

    def list_dataset_members(self, dataset_id: str) -> list[DatasetMember]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM dataset_members WHERE dataset_id = ? "
                "ORDER BY display_index",
                (dataset_id,),
            ).fetchall()
        return [self._member_from_row(row) for row in rows]

    def dataset_memberships_for(self, capture_id: str) -> list[DatasetMember]:
        """Every dataset this capture belongs to — §7's delete guard."""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM dataset_members WHERE capture_id = ?", (capture_id,)
            ).fetchall()
        return [self._member_from_row(row) for row in rows]

    def list_view_entries(self) -> list[dict[str, Any]]:
        """Everything the views tree needs, from committed member rows only (§6).

        Active datasets only: an archiving/archived dataset's bytes are leaving
        or gone, and its disappearance from ``views/`` should be this filter —
        a decision — rather than the regenerator's missing-source skip, which
        logs each member as a surprise.
        """
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT m.capture_id, m.display_index, d.name AS dataset_name,
                       COALESCE(d.operator, c.operator) AS operator,
                       COALESCE(d.task, c.task) AS task
                FROM dataset_members m
                JOIN datasets d ON d.dataset_id = m.dataset_id
                LEFT JOIN captures c ON c.capture_id = m.capture_id
                WHERE d.status = 'active'
                ORDER BY d.name, m.display_index
                """
            ).fetchall()
        return [dict(row) for row in rows]

    # ---- dataset archive (§6.x) --------------------------------------------

    def begin_dataset_archive(
        self, dataset_id: str, *, destination: str, at: str | None = None
    ) -> bool:
        """active → archiving, exactly once. ``False`` = it was not active.

        The WHERE clause is the whole concurrency story: two racing starts both
        reach this UPDATE, one flips the row, the other sees rowcount 0 and
        reports the conflict. No lock outlives the statement.
        """
        with self._conn() as conn:
            cur = conn.execute(
                "UPDATE datasets SET status = 'archiving', "
                "archive_destination = ?, archive_started_at = ? "
                "WHERE dataset_id = ? AND status = 'active'",
                (destination, at or utc_now_iso8601(), dataset_id),
            )
        return cur.rowcount > 0

    def abort_dataset_archive(self, dataset_id: str) -> None:
        """Roll archiving back to active — only for a start whose ledger append
        failed, i.e. before any byte moved. Once a member has been copied the
        run must go forward (resume), never back."""
        with self._conn() as conn:
            conn.execute(
                "UPDATE datasets SET status = 'active', "
                "archive_destination = NULL, archive_started_at = NULL "
                "WHERE dataset_id = ? AND status = 'archiving'",
                (dataset_id,),
            )

    def finish_dataset_archive(self, dataset_id: str, *, at: str | None = None) -> bool:
        """archiving → archived (terminal). ``False`` = it was not archiving."""
        with self._conn() as conn:
            cur = conn.execute(
                "UPDATE datasets SET status = 'archived', archived_at = ? "
                "WHERE dataset_id = ? AND status = 'archiving'",
                (at or utc_now_iso8601(), dataset_id),
            )
        return cur.rowcount > 0

    def mark_dataset_archiving(
        self, dataset_id: str, *, destination: str, at: str | None
    ) -> None:
        """Replay form of :meth:`begin_dataset_archive` — no CAS, idempotent.

        The ledger already serialized the run; a rebuild just copies its
        verdict onto the row, including a run that crashed mid-archive and must
        come back as ``archiving`` so the operator can resume it.
        """
        with self._conn() as conn:
            conn.execute(
                "UPDATE datasets SET status = 'archiving', "
                "archive_destination = ?, archive_started_at = ? "
                "WHERE dataset_id = ? AND status != 'archived'",
                (destination, at, dataset_id),
            )

    def mark_dataset_archived(self, dataset_id: str, *, at: str | None) -> None:
        """Replay form of :meth:`finish_dataset_archive` — no CAS, idempotent."""
        with self._conn() as conn:
            conn.execute(
                "UPDATE datasets SET status = 'archived', archived_at = ? "
                "WHERE dataset_id = ?",
                (at, dataset_id),
            )

    def count_archived_members(self, dataset_id: str) -> tuple[int, int]:
        """(done, total) members of one dataset, "done" = capture archived.

        Progress derived from durable rows rather than kept as its own state:
        a member capture's ``archived_at`` can only have come from this
        dataset's run (§6.x refuses shared members), so the join needs no
        run identity.
        """
        with self._conn() as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS total,
                       SUM(CASE WHEN c.archived_at IS NOT NULL THEN 1 ELSE 0 END)
                           AS done
                FROM dataset_members m
                LEFT JOIN captures c ON c.capture_id = m.capture_id
                WHERE m.dataset_id = ?
                """,
                (dataset_id,),
            ).fetchone()
        return (int(row["done"] or 0), int(row["total"]))

    # ---- batches -----------------------------------------------------------

    def create_batch(self, batch: Batch) -> Batch:
        """Insert a batch, allocating its per-(robot, local day) number."""
        with self._conn() as conn:
            seq = self._next_batch_seq(conn, batch.robot, batch.created_at)
            try:
                conn.execute(
                    """
                    INSERT INTO batches
                        (batch_id, robot, project, task, condition, operator,
                         target_episodes, status, ended_reason, created_at,
                         ended_at, batch_seq)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        batch.batch_id,
                        batch.robot,
                        batch.project,
                        batch.task,
                        batch.condition,
                        batch.operator,
                        batch.target_episodes,
                        batch.status,
                        batch.ended_reason,
                        batch.created_at,
                        batch.ended_at,
                        seq,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise BatchExistsError(batch.batch_id) from exc
            batch.batch_seq = seq
        return batch

    @staticmethod
    def _next_batch_seq(
        conn: sqlite3.Connection, robot: str | None, created_at: str | None
    ) -> int:
        """``1 + MAX(batch_seq)`` for this robot on this local calendar day."""
        row = conn.execute(
            """
            SELECT MAX(batch_seq) AS m FROM batches
            WHERE robot IS ?
              AND date(created_at, 'localtime') = date(?, 'localtime')
            """,
            (robot, created_at or utc_now_iso8601()),
        ).fetchone()
        current = row["m"] if row and row["m"] is not None else 0
        return int(current) + 1

    def update_batch(self, batch_id: str, **fields: Any) -> Batch:
        if not fields:
            return self.get_batch_or_raise(batch_id)
        for name in fields:
            if name not in _BATCH_UPDATE_FIELDS:
                raise KeyError(f"Unknown batch field: {name}")
        assignments = ", ".join(f"{name} = ?" for name in fields)
        with self._conn() as conn:
            cur = conn.execute(
                f"UPDATE batches SET {assignments} WHERE batch_id = ?",
                (*fields.values(), batch_id),
            )
            if cur.rowcount == 0:
                raise KeyError(batch_id)
        return self.get_batch_or_raise(batch_id)

    def increment_episodes_recorded(self, batch_id: str) -> None:
        """Bump the monotone recorded counter (a no-op for an unknown batch)."""
        with self._conn() as conn:
            conn.execute(
                "UPDATE batches SET episodes_recorded = episodes_recorded + 1 "
                "WHERE batch_id = ?",
                (batch_id,),
            )

    def get_batch(self, batch_id: str) -> Batch | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM batches WHERE batch_id = ?", (batch_id,)
            ).fetchone()
        return self._batch_from_row(row) if row is not None else None

    def get_batch_or_raise(self, batch_id: str) -> Batch:
        batch = self.get_batch(batch_id)
        if batch is None:
            raise KeyError(batch_id)
        return batch

    def batch_seqs_for_ids(self, batch_ids: list[str]) -> dict[str, int | None]:
        if not batch_ids:
            return {}
        placeholders = ", ".join("?" for _ in batch_ids)
        with self._conn() as conn:
            rows = conn.execute(
                f"SELECT batch_id, batch_seq FROM batches "
                f"WHERE batch_id IN ({placeholders})",
                batch_ids,
            ).fetchall()
        return {row["batch_id"]: row["batch_seq"] for row in rows}

    def list_batches(
        self,
        status: str | None = None,
        *,
        robot: str | None = None,
        operator: str | None = None,
    ) -> list[Batch]:
        params: list[Any] = []
        clauses: list[str] = []
        for column, value in (
            ("status", status),
            ("robot", robot),
            ("operator", operator),
        ):
            if value is not None:
                clauses.append(f"{column} = ?")
                params.append(value)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._conn() as conn:
            rows = conn.execute(
                f"SELECT * FROM batches {where} ORDER BY seq DESC", params
            ).fetchall()
        return [self._batch_from_row(r) for r in rows]

    def list_captures_by_batch(self, batch_id: str) -> list[Capture]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM captures WHERE batch_id = ? "
                "ORDER BY index_in_batch, seq",
                (batch_id,),
            ).fetchall()
        return [self._capture_from_row(r) for r in rows]

    # ---- jobs --------------------------------------------------------------

    def upsert_job(
        self,
        job: JobStatus | JobCreateResponse,
        *,
        result: JobResult | dict[str, Any] | None = None,
        created_at: str | None = None,
        updated_at: str | None = None,
    ) -> JobStatus:
        result_json = None
        if result is not None:
            result_json = json.dumps(
                result.model_dump() if isinstance(result, JobResult) else result
            )
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO jobs
                    (job_id, capture_id, pipeline, state, progress, logs_tail,
                     result, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
                    capture_id = excluded.capture_id,
                    pipeline = excluded.pipeline,
                    state = excluded.state,
                    progress = excluded.progress,
                    logs_tail = excluded.logs_tail,
                    result = COALESCE(excluded.result, jobs.result),
                    updated_at = excluded.updated_at
                """,
                (
                    job.job_id,
                    job.capture_id,
                    job.pipeline,
                    job.state.value,
                    job.progress,
                    json.dumps(job.logs_tail),
                    result_json,
                    created_at,
                    updated_at,
                ),
            )
        return self.get_job_or_raise(job.job_id)

    def get_job(self, job_id: str) -> JobStatus | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
        return self._job_from_row(row) if row is not None else None

    def get_job_or_raise(self, job_id: str) -> JobStatus:
        job = self.get_job(job_id)
        if job is None:
            raise KeyError(job_id)
        return job

    def get_job_result(self, job_id: str) -> JobResult | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT result FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
        if row is None:
            raise KeyError(job_id)
        if not row["result"]:
            return None
        return JobResult.model_validate(json.loads(row["result"]))

    # ---- validation templates + plan catalog (mirrored to sidecars) --------

    def create_template(self, template: ValidationTemplate) -> ValidationTemplate:
        """Persist a validation template and mirror the catalog to disk."""
        with self._conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO validation_templates "
                "(name, version, required_topics) VALUES (?, ?, ?)",
                (
                    template.name,
                    template.version,
                    json.dumps([t.model_dump() for t in template.required_topics]),
                ),
            )
        self._mirror_templates()
        return template

    def list_templates(
        self, limit: int, cursor: int | None = None
    ) -> tuple[list[ValidationTemplate], int | None]:
        params: list[Any] = []
        where = ""
        if cursor is not None:
            where = "WHERE seq < ?"
            params.append(cursor)
        params.append(limit + 1)
        with self._conn() as conn:
            rows = conn.execute(
                f"SELECT * FROM validation_templates {where} ORDER BY seq DESC LIMIT ?",
                params,
            ).fetchall()
        has_more = len(rows) > limit
        page = rows[:limit]
        templates = [self._template_from_row(r) for r in page]
        next_cursor = int(page[-1]["seq"]) if has_more and page else None
        return templates, next_cursor

    def get_plan_catalog(self) -> tuple[list[Any], str] | None:
        """``(projects, updated_at)``, or ``None`` if it was NEVER set.

        ``None`` is distinct from an explicitly emptied catalog (``([], ts)``):
        the client seeds the server from its local copy only in the never-set
        case, so conflating them would resurrect a catalog somebody cleared.
        """
        with self._conn() as conn:
            row = conn.execute(
                "SELECT payload, updated_at FROM plan_catalog WHERE id = 1"
            ).fetchone()
        if row is None:
            return None
        try:
            projects = json.loads(row["payload"])
        except ValueError:
            return None
        if not isinstance(projects, list):
            return None
        return projects, row["updated_at"]

    def set_plan_catalog(self, projects: list[Any], updated_at: str) -> None:
        """Replace the shared plan catalog and mirror it to disk."""
        payload = json.dumps(projects, ensure_ascii=False)
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO plan_catalog (id, payload, updated_at) VALUES (1, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET "
                "payload = excluded.payload, updated_at = excluded.updated_at",
                (payload, updated_at),
            )
        self._mirror_plan_catalog(projects, updated_at)

    def _catalog_dir(self) -> Path | None:
        return None if self._data_dir is None else self._data_dir / CATALOG_DIRNAME

    def _mirror_templates(self) -> None:
        """Write every template to ``catalog/validation_templates.json``.

        The whole set, not a delta: this file is read as the complete truth by
        :meth:`restore_catalog_from_sidecars`, and an append-only mirror would
        have to reproduce the DB's uniqueness rules to stay consistent with it.
        """
        catalog = self._catalog_dir()
        if catalog is None:
            return
        templates, _ = self.list_templates(limit=10_000)
        try:
            atomic_write_json(
                catalog / TEMPLATES_SIDECAR,
                {
                    "schema_version": SCHEMA_VERSION,
                    "items": [t.model_dump() for t in templates],
                },
            )
        except OSError as exc:
            # The template is already in the DB; failing the request would be
            # worse than a catalog that needs re-saving after a rebuild.
            logger.error("validation template sidecar write failed: %s", exc)

    def _mirror_plan_catalog(self, projects: list[Any], updated_at: str) -> None:
        catalog = self._catalog_dir()
        if catalog is None:
            return
        try:
            atomic_write_json(
                catalog / PLAN_CATALOG_SIDECAR,
                {
                    "schema_version": SCHEMA_VERSION,
                    "projects": projects,
                    "updated_at": updated_at,
                },
            )
        except OSError as exc:
            logger.error("plan catalog sidecar write failed: %s", exc)

    def restore_catalog_from_sidecars(self) -> dict[str, int]:
        """Load ``catalog/*.json`` back into an empty database (§8).

        Called after a rebuild. Returns what was restored so the caller can
        report it; a missing or unparseable sidecar restores nothing rather
        than raising — the catalog is UI vocabulary, and losing it must not
        block a startup that is already recovering.
        """
        restored = {"validation_templates": 0, "plan_catalog": 0}
        catalog = self._catalog_dir()
        if catalog is None:
            return restored

        payload = _read_json(catalog / TEMPLATES_SIDECAR)
        for item in (payload or {}).get("items", []):
            try:
                template = ValidationTemplate.model_validate(item)
            except ValueError:
                logger.warning("skipping unparseable validation template in sidecar")
                continue
            with self._conn() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO validation_templates "
                    "(name, version, required_topics) VALUES (?, ?, ?)",
                    (
                        template.name,
                        template.version,
                        json.dumps([t.model_dump() for t in template.required_topics]),
                    ),
                )
            restored["validation_templates"] += 1

        plan = _read_json(catalog / PLAN_CATALOG_SIDECAR)
        if plan is not None and isinstance(plan.get("projects"), list):
            with self._conn() as conn:
                conn.execute(
                    "INSERT INTO plan_catalog (id, payload, updated_at) "
                    "VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET "
                    "payload = excluded.payload, updated_at = excluded.updated_at",
                    (
                        json.dumps(plan["projects"], ensure_ascii=False),
                        plan.get("updated_at") or utc_now_iso8601(),
                    ),
                )
            restored["plan_catalog"] = 1
        return restored

    # ---- rebuild application (§8) ------------------------------------------

    def apply_rebuild(
        self,
        *,
        captures: Iterable[CaptureRow],
        replicas: Iterable[ReplicaRow],
    ) -> int:
        """Write the rows a scan concluded, in one transaction.

        A row whose ``review_from_sidecar`` is ``False`` keeps whatever review
        state the database already holds. That is §4.1-4's asymmetry made
        concrete: a sidecar ahead of the DB wins, but a DB ahead of its sidecar
        is *reported* rather than corrected, because overwriting it would
        destroy a newer review to match an older file.
        """
        now = utc_now_iso8601()
        applied = 0
        with self._conn() as conn:
            for row in captures:
                self._upsert_rebuilt_capture(conn, row, now)
                applied += 1
            for replica in replicas:
                conn.execute(
                    """
                    INSERT INTO replicas
                        (capture_id, instance_id, state, path, manifest_digest,
                         verified_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(capture_id, instance_id) DO UPDATE SET
                        state = excluded.state,
                        path = excluded.path,
                        manifest_digest = excluded.manifest_digest,
                        updated_at = excluded.updated_at
                    """,
                    (
                        replica.capture_id,
                        replica.instance_id,
                        str(replica.state),
                        replica.path,
                        replica.manifest_digest,
                        replica.verified_at,
                        now,
                    ),
                )
        return applied

    @staticmethod
    def _upsert_rebuilt_capture(
        conn: sqlite3.Connection, row: CaptureRow, now: str
    ) -> None:
        columns: dict[str, Any] = {
            "capture_id": row.capture_id,
            "run_id": row.run_id,
            "source_instance_id": row.source_instance_id,
            "state": str(row.state),
            "operator": row.operator,
            "task": row.task,
            "robot": row.robot,
            "started_at": row.started_at,
            "ended_at": row.ended_at,
            "topics": json.dumps([dict(t) for t in row.topics]),
            "compression": row.compression or Compression.none.value,
            "split": json.dumps(row.split) if row.split is not None else None,
            "error": json.dumps(row.error) if row.error is not None else None,
            "message_count": row.message_count,
            "bytes": row.bytes,
            "deleted_at": row.deleted_at,
            "delete_kind": row.delete_kind,
            "delete_reason": row.delete_reason,
            "archived_at": row.archived_at,
            "archive_destination": row.archive_destination,
            "updated_at": now,
        }
        if row.review_from_sidecar:
            columns.update(
                {
                    "task_result": row.task_result,
                    "failure_reason": row.failure_reason,
                    "quality": row.quality,
                    "quality_source": row.quality_source,
                    "review_status": str(row.review_status),
                    "review_revision": row.review_revision,
                    "batch_id": row.batch_id,
                    "index_in_batch": row.index_in_batch,
                }
            )
        names = ", ".join([*columns, "created_at"])
        placeholders = ", ".join("?" for _ in range(len(columns) + 1))
        updates = ", ".join(
            f"{name} = excluded.{name}" for name in columns if name != "capture_id"
        )
        conn.execute(
            f"INSERT INTO captures ({names}) VALUES ({placeholders}) "
            f"ON CONFLICT(capture_id) DO UPDATE SET {updates}",
            [*columns.values(), now],
        )

    # ---- (de)serialization -------------------------------------------------

    @staticmethod
    def _encode(name: str, value: Any) -> Any:
        """Encode one model-level field into its column representation."""
        if name == "topics":
            return json.dumps(
                [
                    t.model_dump() if isinstance(t, CaptureTopic) else t
                    for t in (value or [])
                ]
            )
        if name in _JSON_COLUMNS:
            if value is None:
                return None
            if hasattr(value, "model_dump"):
                return json.dumps(value.model_dump(mode="json"))
            return json.dumps(value)
        if name in {"state", "compression", "review_status"}:
            return None if value is None else str(getattr(value, "value", value))
        return value

    def _capture_columns(self, capture: Capture) -> dict[str, Any]:
        """Render a full :class:`Capture` into its INSERT column mapping."""
        return {
            "capture_id": capture.capture_id,
            "run_id": capture.run_id,
            "source_instance_id": capture.source_instance_id,
            "state": str(capture.state),
            "operator": capture.operator,
            "task": capture.task,
            "robot": capture.robot,
            "started_at": capture.started_at,
            "ended_at": capture.ended_at,
            "topics": self._encode("topics", capture.topics),
            "compression": str(capture.compression),
            "split": self._encode("split", capture.split),
            "error": self._encode("error", capture.error),
            "message_count": capture.message_count,
            "bytes": capture.bytes,
            "quick_check": self._encode("quick_check", capture.quick_check),
            "task_result": capture.task_result,
            "failure_reason": capture.failure_reason,
            "quality": capture.quality,
            "quality_source": capture.quality_source,
            "review_status": capture.review_status,
            "review_revision": capture.review_revision,
            "batch_id": capture.batch_id,
            "index_in_batch": capture.index_in_batch,
            "deleted_at": capture.deleted_at,
            "delete_kind": capture.delete_kind,
            "delete_reason": capture.delete_reason,
            "archived_at": capture.archived_at,
            "archive_destination": capture.archive_destination,
            "lease_owner": capture.lease_owner,
            "lease_expires_at": capture.lease_expires_at,
            "created_at": capture.created_at,
            "updated_at": capture.updated_at,
        }

    @staticmethod
    def _capture_from_row(row: sqlite3.Row) -> Capture:
        topics_raw = json.loads(row["topics"]) if row["topics"] else []
        split_raw = json.loads(row["split"]) if row["split"] else None
        error_raw = json.loads(row["error"]) if row["error"] else None
        qc_raw = json.loads(row["quick_check"]) if row["quick_check"] else None
        return Capture(
            capture_id=row["capture_id"],
            run_id=row["run_id"],
            source_instance_id=row["source_instance_id"],
            state=CaptureState(row["state"]),
            operator=row["operator"],
            task=row["task"],
            robot=row["robot"],
            started_at=row["started_at"],
            ended_at=row["ended_at"],
            topics=[CaptureTopic.model_validate(t) for t in topics_raw],
            compression=Compression(row["compression"]),
            split=Split.model_validate(split_raw) if split_raw else None,
            error=coerce_error(error_raw),
            message_count=row["message_count"],
            bytes=row["bytes"],
            quick_check=QuickCheck.model_validate(qc_raw) if qc_raw else None,
            task_result=row["task_result"],
            failure_reason=row["failure_reason"],
            quality=row["quality"],
            quality_source=row["quality_source"],
            review_status=row["review_status"],
            review_revision=row["review_revision"],
            batch_id=row["batch_id"],
            index_in_batch=row["index_in_batch"],
            deleted_at=row["deleted_at"],
            delete_kind=row["delete_kind"],
            delete_reason=row["delete_reason"],
            archived_at=row["archived_at"],
            archive_destination=row["archive_destination"],
            lease_owner=row["lease_owner"],
            lease_expires_at=row["lease_expires_at"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _replica_from_row(row: sqlite3.Row) -> Replica:
        return Replica(
            instance_id=row["instance_id"],
            state=ReplicaState(row["state"]),
            path=row["path"],
            manifest_digest=row["manifest_digest"],
            verified_at=row["verified_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _attach_replica(
        conn: sqlite3.Connection, captures: list[Capture], instance_id: str | None
    ) -> None:
        """Attach this installation's replica row and derive ``digest_state``.

        One batched query for the whole page rather than a lookup per row: the
        capture list is the most-read endpoint in the UI and an N+1 here would
        be felt on every poll.
        """
        if instance_id is None or not captures:
            return
        ids = [c.capture_id for c in captures]
        placeholders = ", ".join("?" for _ in ids)
        rows = conn.execute(
            f"SELECT * FROM replicas WHERE instance_id = ? "
            f"AND capture_id IN ({placeholders})",
            (instance_id, *ids),
        ).fetchall()
        by_id = {row["capture_id"]: row for row in rows}
        for capture in captures:
            row = by_id.get(capture.capture_id)
            if row is None:
                continue
            capture.replica = CaptureStore._replica_from_row(row)
            capture.digest_state = (
                DigestState.complete
                if row["state"] == ReplicaState.present_verified.value
                else DigestState.pending
            )

    @staticmethod
    def _attach_memberships(conn: sqlite3.Connection, captures: list[Capture]) -> None:
        if not captures:
            return
        ids = [c.capture_id for c in captures]
        placeholders = ", ".join("?" for _ in ids)
        rows = conn.execute(
            f"SELECT m.membership_id, m.dataset_id, m.capture_id, m.display_index, "
            f"d.name AS dataset_name FROM dataset_members m "
            f"LEFT JOIN datasets d ON d.dataset_id = m.dataset_id "
            f"WHERE m.capture_id IN ({placeholders})",
            ids,
        ).fetchall()
        by_capture: dict[str, list[DatasetMembership]] = {}
        for row in rows:
            by_capture.setdefault(row["capture_id"], []).append(
                DatasetMembership(
                    membership_id=row["membership_id"],
                    dataset_id=row["dataset_id"],
                    dataset_name=row["dataset_name"],
                    display_index=row["display_index"],
                )
            )
        for capture in captures:
            capture.memberships = by_capture.get(capture.capture_id, [])

    @staticmethod
    def _member_from_row(row: sqlite3.Row) -> DatasetMember:
        return DatasetMember(
            membership_id=row["membership_id"],
            dataset_id=row["dataset_id"],
            capture_id=row["capture_id"],
            display_index=row["display_index"],
            created_at=row["created_at"],
        )

    @staticmethod
    def _job_from_row(row: sqlite3.Row) -> JobStatus:
        return JobStatus(
            job_id=row["job_id"],
            capture_id=row["capture_id"],
            pipeline=row["pipeline"],
            state=JobState(row["state"]),
            progress=float(row["progress"]),
            logs_tail=json.loads(row["logs_tail"]) if row["logs_tail"] else [],
        )

    @staticmethod
    def _template_from_row(row: sqlite3.Row) -> ValidationTemplate:
        return ValidationTemplate(
            name=row["name"],
            version=row["version"],
            required_topics=(
                json.loads(row["required_topics"]) if row["required_topics"] else []
            ),
        )

    @staticmethod
    def _batch_from_row(row: sqlite3.Row) -> Batch:
        return Batch(
            batch_id=row["batch_id"],
            robot=row["robot"],
            project=row["project"],
            task=row["task"],
            condition=row["condition"],
            operator=row["operator"],
            target_episodes=row["target_episodes"],
            status=row["status"],
            ended_reason=row["ended_reason"],
            created_at=row["created_at"],
            ended_at=row["ended_at"],
            episodes_recorded=row["episodes_recorded"],
            batch_seq=row["batch_seq"],
        )


def _read_json(path: Path) -> dict[str, Any] | None:
    """Best-effort read of a JSON sidecar (``None`` on any failure)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None
