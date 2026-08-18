# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
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
import os
import sqlite3
from collections.abc import Iterable, Sequence
from contextlib import AbstractContextManager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from kairos_common import Compression
from kairos_common.atomic_io import atomic_write_json
from kairos_common.capture_sidecars import DigestState
from kairos_common.ids import new_membership_id
from kairos_common.rebuild import CaptureRow, ReplicaRow, ReplicaState
from kairos_common.sqlite_store import SqliteConnection, set_user_version, user_version
from kairos_common.time import utc_iso8601_of, utc_now_iso8601

from api_orchestrator import row_mappers
from api_orchestrator.layout import read_json
from api_orchestrator.models import (
    Batch,
    Capture,
    CaptureState,
    DatasetMember,
    DatasetMembership,
    JobCreateResponse,
    JobResult,
    JobStatus,
    Replica,
    ValidationTemplate,
)
from api_orchestrator.schema import (
    BATCH_UPDATE_FIELDS as _BATCH_UPDATE_FIELDS,
)
from api_orchestrator.schema import (
    CAPTURE_COLUMNS as _CAPTURE_COLUMNS,
)
from api_orchestrator.schema import (
    REVIEW_COLUMNS as _REVIEW_COLUMNS,
)
from api_orchestrator.schema import (
    SCHEMA as _SCHEMA,
)
from api_orchestrator.schema import (
    SCHEMA_VERSION,
)

logger = logging.getLogger("kairos")

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


class BatchLabelsFrozenError(Exception):
    """A non-empty batch attempted to alter recording-provenance labels."""

    def __init__(self, batch_id: str, fields: Iterable[str]) -> None:
        self.batch_id = batch_id
        self.fields = tuple(sorted(fields))
        super().__init__(
            f"Batch labels are frozen after recording begins: {batch_id} "
            f"({', '.join(self.fields)})"
        )


class ArchiveDestinationTakenError(Exception):
    """Another dataset already holds this archive destination.

    A destination is one dataset's folder: numbered member directories plus a
    single manifest naming whose they are. A second dataset landing in it
    interleaves its numbers with the first's, overwrites the manifest, and —
    because each run reads the other's directories as its own unrecorded
    debris — deletes bytes the ledger has already recorded as archived.
    """

    def __init__(self, dataset_id: str, destination: str, held_by: str) -> None:
        super().__init__(f"{destination} is already held by dataset {held_by}")
        self.dataset_id = dataset_id
        self.destination = destination
        self.held_by = held_by


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
        # busy_timeout is per-connection: wait for a competing writer rather
        # than raising "database is locked" at once. Opening nothing yet for a
        # file DB is what lets the version check below delete it first.
        self._db = SqliteConnection(
            db_path, connect_pragmas=("PRAGMA busy_timeout = 5000",)
        )
        self._path = self._db.path
        self._data_dir = Path(data_dir) if data_dir is not None else None
        self._instance_id = instance_id
        self.was_discarded = False
        # Whether a database file was already there when this process opened it.
        # ``False`` is one of §8's three rebuild triggers ("kairos.db missing"),
        # and it can only be observed here — a moment later the file exists
        # because we just created it.
        self.existed_at_open = False

        if not self._db.is_memory:
            self.existed_at_open = Path(self._path).exists()
            self.was_discarded = self._discard_if_wrong_version(Path(self._path))

        with self._conn() as conn:
            if not self._db.is_memory:
                # WAL persists in the file header and lets readers run
                # concurrently with the single writer, so a long capture list
                # never blocks a recording-state write.
                conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(_SCHEMA)
            set_user_version(conn, SCHEMA_VERSION)

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
                version = user_version(conn)
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

    def _conn(self) -> AbstractContextManager[sqlite3.Connection]:
        """Yield a connection under the lock, committing on success."""
        return self._db.connect()

    def close(self) -> None:
        """Close the shared in-memory connection (no-op for file DBs)."""
        self._db.close()

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
                "SELECT * FROM captures_with_lease WHERE capture_id = ?", (capture_id,)
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

        **Most filter columns are unindexed, and the case is open.** At 5,000
        captures (E-27) a filtered page on ``task`` or ``review_status`` serves
        in **1.8 ms** — no worse than the unfiltered page at 3.7 ms. The plan
        behind that: ``seq`` is INTEGER PRIMARY KEY, so it is the rowid and the
        page seeks straight through the table B-tree in the order it already
        wants (``SEARCH captures USING INTEGER PRIMARY KEY (rowid<?)``),
        stopping at the limit — an unmatched row costs a comparison, not a sort.

        A second measurement points the other way and is recorded here rather
        than lost: on ``WHERE operator = ? ORDER BY seq DESC LIMIT 50`` over
        5,000 rows, an index on ``operator`` took the query from **0.75 ms
        (SCAN) to 0.35 ms (SEARCH … USING INDEX)** — 2.1x faster. That filter
        is unselective, so it is not the last word either.

        So: neither number is a mandate. Both are sub-millisecond against a
        round trip of several, which is why nothing has been added. Anyone who
        wants the index has a measurement to start from instead of an
        intuition, and should take their own on a selective filter.
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
                f"SELECT * FROM captures_with_lease {where} ORDER BY seq DESC LIMIT ?",
                params,
            ).fetchall()
            has_more = len(rows) > limit
            page = rows[:limit]
            captures = [self._capture_from_row(r) for r in page]
            self._attach_replica(conn, captures, instance_id or self._instance_id)
            self._attach_memberships(conn, captures)
        next_cursor = int(page[-1]["seq"]) if has_more and page else None
        return captures, next_cursor

    def present_terminal_ids(
        self, states: Iterable[str], *, instance_id: str
    ) -> list[str]:
        """Ids of captures in one of *states* whose local replica is present.

        Ids rather than rows, because the caller counts them and subtracts a
        set from them. Building a model per capture to do that costs ~78 ms on
        a 5,000-capture store (measured) for information the query already has,
        and the presets screen polls.
        """
        values = [str(s) for s in states]
        if not values:
            return []
        state_slots = ", ".join("?" for _ in values)
        replica_slots = ", ".join("?" for _ in PRESENT_REPLICA_STATES)
        with self._conn() as conn:
            rows = conn.execute(
                f"SELECT c.capture_id FROM captures c "
                f"JOIN replicas r ON r.capture_id = c.capture_id "
                f"WHERE r.instance_id = ? AND c.state IN ({state_slots}) "
                f"AND r.state IN ({replica_slots}) ORDER BY c.seq",
                (instance_id, *values, *sorted(PRESENT_REPLICA_STATES)),
            ).fetchall()
        return [row["capture_id"] for row in rows]

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
                f"SELECT * FROM captures_with_lease "
                f"WHERE state IN ({placeholders}) ORDER BY seq",
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
                "SELECT * FROM captures_with_lease WHERE run_id = ?", (run_id,)
            ).fetchone()
        return self._capture_from_row(row) if row is not None else None

    def save_review_cas(
        self,
        capture_id: str,
        *,
        base_revision: int,
        fields: dict[str, Any],
        renumber_index: bool = False,
    ) -> bool:
        """Step 3 of §4.1: update the review columns **only if unchanged**.

        Returns ``False`` when the row's ``review_revision`` no longer equals
        *base_revision* (or the capture is gone), which the caller turns into a
        409. This is the whole concurrency story for review edits: no merge, no
        last-writer-wins, and no lock held across the HTTP round-trip.

        The sidecar has already been written at ``base_revision + 1`` by the
        time this runs, so a loss here means ``record.json`` holds a decision
        this row rejected. The caller restamps it from the winning row rather
        than leaving it: §8 rebuilds the catalog from the sidecars, so a file
        left disagreeing with the database would outlive the 409.

        *renumber_index* turns ``index_in_batch`` from a value into a request:
        the contract calls it a client HINT, and this is where the hint is
        resolved against everything else in the batch. The caller sets it only
        when the request actually offered a number to a batch. Read the row
        afterwards for what was stored — the whole point is that it may not be
        what was asked for.
        """
        unknown = set(fields) - _REVIEW_COLUMNS
        if unknown:
            raise KeyError(f"Not review fields: {sorted(unknown)}")
        with self._conn() as conn:
            if renumber_index:
                # BEGIN IMMEDIATE takes the write lock before the scan, so the
                # number is allocated by the DATABASE rather than by this
                # process's lock. That matters more here than it does for
                # ``begin_dataset_archive`` (which documents the opposite
                # trade): the value being handed out is printed on the strip
                # chip, the Review row and every "episode #N" in a delete
                # dialog, so two orchestrators over one data dir issuing one
                # number is visible to an operator rather than theoretical.
                # Scoped to this statement — no other caller of ``_conn``
                # changes discipline.
                if not conn.in_transaction:
                    conn.execute("BEGIN IMMEDIATE")
                fields = dict(fields)
                fields["index_in_batch"] = self._free_index(
                    conn,
                    capture_id,
                    batch_id=fields["batch_id"],
                    hint=fields["index_in_batch"],
                )
            assignments = ", ".join(f"{name} = ?" for name in fields)
            prefix = f"{assignments}, " if assignments else ""
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

    @staticmethod
    def _free_index(
        conn: sqlite3.Connection, capture_id: str, *, batch_id: str, hint: int
    ) -> int:
        """*hint* if this batch has it free, else the next number above them all.

        **Retired numbers are not reissued.** Tombstones are counted as holders
        (no state filter), because a capture deleted in Review is still the
        thing an operator, a ledger line and an archived folder call "#3" — and
        the same rule the dataset display index settled on under E-29. So the
        replacement goes above the high-water mark rather than into the gap.

        Called with the write lock held, so the maximum it reads cannot grow
        before the UPDATE that follows it.
        """
        row = conn.execute(
            "SELECT MAX(index_in_batch) AS high, "
            "SUM(index_in_batch = ?) AS taken FROM captures "
            "WHERE batch_id = ? AND capture_id != ? AND index_in_batch IS NOT NULL",
            (hint, batch_id, capture_id),
        ).fetchone()
        if not row["taken"]:
            return hint
        # ``high`` is the maximum over every OTHER row, so high + 1 is free
        # whatever this row currently holds — it is about to be overwritten.
        return int(row["high"]) + 1

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
        """Take or renew *owner*'s hold on a capture. Always succeeds.

        §7.1's lease is SHARED: several readers may hold one capture at once,
        which is what lets the N camera encoders of a single recording run in
        parallel. So this no longer arbitrates between jobs — it records that
        one more of them is touching ``objects/<capture_id>``, and the thing it
        protects is unchanged: discard and delete refuse while any live holder
        remains.

        Renewal is the same statement as acquisition, scoped to this owner's row
        by the primary key, so a poll for one job cannot extend another's.

        Expired rows for this capture are swept here rather than by a timer.
        An expired lease is already not a lease (every read compares against
        now), so the sweep is hygiene, not correctness — which is exactly why it
        can ride on a write that was happening anyway instead of needing a task
        that could itself die.
        """
        now = datetime.now(UTC)
        stamp = utc_iso8601_of(now)
        expires = utc_iso8601_of(now + timedelta(seconds=ttl_s))
        with self._conn() as conn:
            conn.execute(
                "DELETE FROM capture_leases WHERE capture_id = ? AND expires_at <= ?",
                (capture_id, stamp),
            )
            conn.execute(
                "INSERT INTO capture_leases (capture_id, owner, expires_at, "
                "acquired_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT (capture_id, owner) DO UPDATE SET expires_at = "
                "excluded.expires_at",
                (capture_id, owner, expires, stamp),
            )
        return True

    def release_lease(self, capture_id: str, owner: str) -> bool:
        """Drop *owner*'s hold. Other holders are untouched.

        Owner-scoped for the same reason it always was: a stale poll for a
        finished job must not be able to release the hold of a job that is still
        working. With several holders that matters more, not less.
        """
        with self._conn() as conn:
            cur = conn.execute(
                "DELETE FROM capture_leases WHERE capture_id = ? AND owner = ?",
                (capture_id, owner),
            )
        return cur.rowcount > 0

    def lease_holders(self, capture_id: str) -> list[dict[str, str]]:
        """Every live holder, soonest expiry first. ``[]`` = nobody.

        The list is what a 409 reports: with N encoders running, "a job is
        working on this" is true but useless, and an operator deciding whether
        to wait needs to see how many and until when.
        """
        stamp = utc_now_iso8601()
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT owner, expires_at FROM capture_leases "
                "WHERE capture_id = ? AND expires_at > ? ORDER BY expires_at, owner",
                (capture_id, stamp),
            ).fetchall()
        return [
            {"owner": row["owner"], "expires_at": row["expires_at"]} for row in rows
        ]

    def has_live_lease(self, capture_id: str) -> bool:
        """Whether ANY unexpired hold remains — the delete guard's question."""
        stamp = utc_now_iso8601()
        with self._conn() as conn:
            row = conn.execute(
                "SELECT 1 FROM capture_leases WHERE capture_id = ? "
                "AND expires_at > ? LIMIT 1",
                (capture_id, stamp),
            ).fetchone()
        return row is not None

    def holds_lease(self, capture_id: str, owner: str) -> bool:
        """Whether *owner*'s own hold is still live (the mid-job re-check).

        Unchanged in meaning by the shared rewrite: a job re-checks that IT
        still holds the capture before its final write, and another reader
        holding one says nothing about that.
        """
        stamp = utc_now_iso8601()
        with self._conn() as conn:
            row = conn.execute(
                "SELECT 1 FROM capture_leases WHERE capture_id = ? AND owner = ? "
                "AND expires_at > ?",
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
        stamp = utc_now_iso8601()
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
                  AND NOT EXISTS (
                        SELECT 1 FROM capture_leases l
                         WHERE l.capture_id = c.capture_id AND l.expires_at > ?
                      )
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

    def update_dataset_labels(
        self,
        dataset_id: str,
        *,
        name: str,
        operator: str | None,
        task: str | None,
    ) -> bool:
        """Rewrite a dataset's three labels. ``False`` = no such dataset.

        Labels only — status, timestamps and the high-water mark are owned by
        their own transitions and must not ride along on a rename.
        """
        with self._conn() as conn:
            cur = conn.execute(
                "UPDATE datasets SET name = ?, operator = ?, task = ? "
                "WHERE dataset_id = ?",
                (name, operator, task, dataset_id),
            )
        return cur.rowcount > 0

    def get_dataset(self, dataset_id: str) -> dict[str, Any] | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM datasets WHERE dataset_id = ?", (dataset_id,)
            ).fetchone()
        return dict(row) if row is not None else None

    def find_active_dataset_by_labels(
        self,
        *,
        name: str,
        operator: str | None,
        task: str | None,
        exclude: str | None = None,
    ) -> dict[str, Any] | None:
        """The active dataset already using these three labels, if any.

        The labels are not decoration: they are the generated path
        ``views/<operator>/<task>/<name>`` (§6), so two active datasets holding
        all three would ask that tree for one folder twice.

        Archived datasets are excluded deliberately. Their bytes have left and
        their folder was written by the archive run, so the name is free again —
        refusing it would make every archived set permanently poison a name an
        operator wants to keep using. ``IS`` rather than ``=`` because operator
        and task are nullable and ``NULL = NULL`` is not true in SQL.
        """
        sql = (
            "SELECT * FROM datasets WHERE status = 'active' "
            "AND name = ? AND operator IS ? AND task IS ?"
        )
        params: list[Any] = [name, operator, task]
        if exclude is not None:
            sql += " AND dataset_id != ?"
            params.append(exclude)
        with self._conn() as conn:
            row = conn.execute(sql, params).fetchone()
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

        ``dataset_id`` is carried so the regenerator can tell two datasets with
        the same three labels apart, and the ordering breaks that tie by
        creation time. Both matter for stability rather than correctness of the
        query: whichever dataset comes first keeps the plain folder name, so a
        tie left to SQLite's row order could hand the folder to the other one on
        the next regeneration and move a path somebody is globbing.
        """
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT m.capture_id, m.display_index, m.dataset_id,
                       d.name AS dataset_name,
                       COALESCE(d.operator, c.operator) AS operator,
                       COALESCE(d.task, c.task) AS task
                FROM dataset_members m
                JOIN datasets d ON d.dataset_id = m.dataset_id
                LEFT JOIN captures c ON c.capture_id = m.capture_id
                WHERE d.status = 'active'
                ORDER BY d.name, d.created_at, d.dataset_id, m.display_index
                """
            ).fetchall()
        return [dict(row) for row in rows]

    # ---- dataset archive (§6.x) --------------------------------------------

    def begin_dataset_archive(
        self,
        dataset_id: str,
        *,
        destination: str,
        mode: str = "move",
        at: str | None = None,
    ) -> bool:
        """active → archiving, and the destination claimed with it.

        ``False`` = the dataset was not active. Raises
        :class:`ArchiveDestinationTakenError` if another dataset already holds
        the destination.

        Two racing starts of the SAME dataset are settled by the WHERE clause:
        both reach this UPDATE, one flips the row, the other sees rowcount 0.
        Two racing starts of DIFFERENT datasets at one destination are settled
        by the claim scan above it, which cannot interleave with the UPDATE
        because ``_conn`` holds the store lock across both — the scan and the
        CAS are **serialized by that lock, not by one transaction**: Python's
        legacy isolation opens a transaction before DML only, so the SELECT
        sits outside one, and WAL makes readers non-blocking rather than making
        the pair atomic.

        **Known limit, deliberate.** That lock is process-wide, so this is
        closed against FastAPI's threadpool and the event loop, and NOT against
        a second orchestrator process on one ``kairos.db`` — both could pass
        the scan and claim one destination. kairos runs one orchestrator per
        data dir by design, and buying the cross-process case would mean
        ``BEGIN IMMEDIATE`` before the scan, changing the transaction
        discipline for every caller of ``_conn``. If that deployment
        assumption ever stops holding, this is the line to revisit.

        The check has to live down here at all because the caller's own look at
        the folder happened earlier, and the folder stays empty until a runner
        is scheduled — so nothing above this point can tell the two apart.

        The claim is the row, not the directory: an archived dataset holds its
        folder permanently, and a halted run holds its folder even after an
        operator clears the debris out of it, because Resume will come back.
        """
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT dataset_id, archive_destination FROM datasets "
                "WHERE dataset_id != ? AND archive_destination IS NOT NULL "
                "AND status IN ('archiving', 'archived')",
                (dataset_id,),
            ).fetchall()
            for row in rows:
                if _paths_collide(destination, row["archive_destination"]):
                    raise ArchiveDestinationTakenError(
                        dataset_id, destination, row["dataset_id"]
                    )
            cur = conn.execute(
                "UPDATE datasets SET status = 'archiving', "
                "archive_destination = ?, archive_mode = ?, "
                "archive_started_at = ? "
                "WHERE dataset_id = ? AND status = 'active'",
                (destination, mode, at or utc_now_iso8601(), dataset_id),
            )
        return cur.rowcount > 0

    def datasets_sharing_archive_destination(self) -> dict[str, list[str]]:
        """Destinations recorded by more than one dataset row.

        Only a replay can build this: :meth:`begin_dataset_archive` refuses a
        second live claimant. But a ledger written before that guard existed
        can hold two archives of one folder, and replaying it is correct — the
        events happened. Somebody should be told, which is what this is for.
        """
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT archive_destination AS destination, dataset_id "
                "FROM datasets WHERE archive_destination IS NOT NULL "
                "AND status IN ('archiving', 'archived') "
                "ORDER BY archive_destination, dataset_id"
            ).fetchall()
        grouped: dict[str, list[str]] = {}
        for row in rows:
            grouped.setdefault(os.path.normpath(row["destination"]), []).append(
                row["dataset_id"]
            )
        return {dest: ids for dest, ids in grouped.items() if len(ids) > 1}

    def abort_dataset_archive(self, dataset_id: str) -> None:
        """Roll archiving back to active — only for a start whose ledger append
        failed, i.e. before a durable run exists. Operator cancellation uses a
        separate ledger-first method and is never routed through this helper."""
        with self._conn() as conn:
            conn.execute(
                "UPDATE datasets SET status = 'active', "
                "archive_destination = NULL, archive_mode = NULL, "
                "archive_started_at = NULL "
                "WHERE dataset_id = ? AND status = 'archiving'",
                (dataset_id,),
            )

    def cancel_dataset_archive(self, dataset_id: str) -> bool:
        """Release a durably canceled, zero-progress archive attempt."""
        with self._conn() as conn:
            cur = conn.execute(
                "UPDATE datasets SET status = 'active', "
                "archive_destination = NULL, archive_mode = NULL, "
                "archive_started_at = NULL "
                "WHERE dataset_id = ? AND status = 'archiving'",
                (dataset_id,),
            )
        return cur.rowcount > 0

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
        self, dataset_id: str, *, destination: str, mode: str = "move", at: str | None
    ) -> None:
        """Replay form of :meth:`begin_dataset_archive` — no CAS, idempotent.

        The ledger already serialized the run; a rebuild just copies its
        verdict onto the row, including a run that crashed mid-archive and must
        come back as ``archiving`` so the operator can resume it.
        """
        with self._conn() as conn:
            conn.execute(
                "UPDATE datasets SET status = 'archiving', "
                "archive_destination = ?, archive_mode = ?, "
                "archive_started_at = ? "
                "WHERE dataset_id = ? AND status != 'archived'",
                (destination, mode, at, dataset_id),
            )

    def mark_dataset_archived(self, dataset_id: str, *, at: str | None) -> None:
        """Replay form of :meth:`finish_dataset_archive` — no CAS, idempotent."""
        with self._conn() as conn:
            conn.execute(
                "UPDATE datasets SET status = 'archived', archived_at = ? "
                "WHERE dataset_id = ?",
                (at, dataset_id),
            )

    def mark_dataset_archive_canceled(self, dataset_id: str) -> None:
        """Replay form of :meth:`cancel_dataset_archive` — idempotent."""
        with self._conn() as conn:
            conn.execute(
                "UPDATE datasets SET status = 'active', "
                "archive_destination = NULL, archive_mode = NULL, "
                "archive_started_at = NULL, archived_at = NULL "
                "WHERE dataset_id = ? AND status != 'archived'",
                (dataset_id,),
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
        """Insert a batch, allocating its per-(robot, local day) number.

        Raises :class:`BatchExistsError` when the id is taken — by a batch row,
        or by **recordings that still name it**. The second case is what "delete
        kairos.db and restart" leaves behind: captures come back from their
        sidecars carrying ``batch_id``, but a batch's own row has no sidecar and
        no ledger event, so the table comes back empty. Since ids are minted
        from the wall clock, the next batch that second would be handed the dead
        one's identity and would silently absorb its recordings. The caller's
        retry loop then picks a suffixed id, which is the same answer it already
        gives for a live collision.
        """
        with self._conn() as conn:
            claimed = conn.execute(
                "SELECT 1 FROM captures WHERE batch_id = ? LIMIT 1",
                (batch.batch_id,),
            ).fetchone()
            if claimed is not None:
                raise BatchExistsError(batch.batch_id)
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

    def delete_batch(self, batch_id: str) -> bool:
        """Remove a batch row. For the create rollback only (§8).

        Not an operator-facing deletion: the only caller is the create path
        undoing a row whose ledger line could not be written, before anything
        else can have seen it. Recordings are never touched — a batch a
        recording names must not vanish under it.
        """
        with self._conn() as conn:
            cur = conn.execute("DELETE FROM batches WHERE batch_id = ?", (batch_id,))
        return cur.rowcount > 0

    def restore_batch(self, batch: Batch) -> bool:
        """Replay form of :meth:`create_batch` — no allocation, no claim check.

        Two differences, both deliberate. The number comes from the event
        rather than from ``1 + MAX``: it was allocated once, and recomputing it
        during a replay is how a watermark drifts upward on every rebuild.
        And the "a capture already names this id" refusal is skipped, because
        during a replay the captures naming it are *this* batch's own — the
        guard exists to stop a NEW batch stealing a dead one's identity, which
        is the opposite situation.

        Idempotent: a batch already in the catalog is left exactly as it is.
        Returns ``True`` if the row was inserted, ``False`` if one was already
        there — which lets the caller tell a replayed batch from two different
        batches claiming one id, a difference ``INSERT OR IGNORE`` swallows.
        """
        with self._conn() as conn:
            cur = conn.execute(
                """
                INSERT OR IGNORE INTO batches
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
                    batch.batch_seq,
                ),
            )
        return cur.rowcount > 0

    def orphaned_batch_ids(self) -> dict[str, int]:
        """Batch ids recordings still name, with no batch row left. Count each.

        Non-empty only after a rebuild: a batch's row lives solely in this
        database — no sidecar, no ledger event — while its recordings carry
        ``batch_id`` in theirs. "Delete kairos.db and restart" therefore
        restores the recordings and loses the batches, and this is what says by
        how much. Not repairable from here: project, operator, target and the
        daily number were never written anywhere else.
        """
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT c.batch_id AS batch_id, COUNT(*) AS n
                FROM captures c
                LEFT JOIN batches b ON b.batch_id = c.batch_id
                WHERE c.batch_id IS NOT NULL AND b.batch_id IS NULL
                GROUP BY c.batch_id
                ORDER BY c.batch_id
                """
            ).fetchall()
        return {row["batch_id"]: row["n"] for row in rows}

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

    def update_batch(
        self,
        batch_id: str,
        *,
        enforce_label_invariant: bool = True,
        **fields: Any,
    ) -> Batch:
        """Update a batch, freezing provenance labels once recording begins.

        The capture-reference/count check and the update run in one immediate
        SQLite transaction. This prevents a review save from assigning a
        capture between an API-layer preflight check and the label update.
        Ledger replay passes ``False`` because it faithfully reapplies history
        after capture rows have already been rebuilt.
        """
        if not fields:
            return self.get_batch_or_raise(batch_id)
        for name in fields:
            if name not in _BATCH_UPDATE_FIELDS:
                raise KeyError(f"Unknown batch field: {name}")
        assignments = ", ".join(f"{name} = ?" for name in fields)
        with self._conn() as conn:
            # A deferred transaction would leave a window after this read for
            # another writer to attach a capture. Reserve the sole SQLite
            # writer before checking so the decision and UPDATE are atomic.
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM batches WHERE batch_id = ?", (batch_id,)
            ).fetchone()
            if row is None:
                raise KeyError(batch_id)
            if enforce_label_invariant:
                provenance_labels = (
                    "project",
                    "task",
                    "condition",
                    "robot",
                    "operator",
                )
                changed_labels = [
                    name
                    for name in provenance_labels
                    if name in fields and fields[name] != row[name]
                ]
                if changed_labels:
                    capture_exists = conn.execute(
                        "SELECT 1 FROM captures WHERE batch_id = ? LIMIT 1",
                        (batch_id,),
                    ).fetchone()
                    if capture_exists is not None or row["episodes_recorded"] > 0:
                        raise BatchLabelsFrozenError(batch_id, changed_labels)
            cur = conn.execute(
                f"UPDATE batches SET {assignments} WHERE batch_id = ?",
                (*fields.values(), batch_id),
            )
            if cur.rowcount == 0:
                raise KeyError(batch_id)
            updated = conn.execute(
                "SELECT * FROM batches WHERE batch_id = ?", (batch_id,)
            ).fetchone()
        assert updated is not None
        return self._batch_from_row(updated)

    def rebuild_episodes_recorded(self, batch_id: str) -> int:
        """Set the counter to how many recordings name this batch. Returns it.

        Called only by the ledger replay. ``episodes_recorded`` counts review
        saves — an event — and §8 restores facts, so a rebuild has nothing to
        replay it from and the batch used to come back at 0 while its episodes
        sat on disk: Collect then showed ``0 / 30`` for a finished batch.

        Counting the captures that name the batch is the best available answer
        and is knowably a FLOOR, so the row is marked as one. Two things it
        cannot see: a capture reviewed in and later deleted (its record.json
        went with it), and a capture reviewed more than once (which the live
        counter also only counts once). Tombstones ARE counted — the row
        survives a delete and it did have a review — so the undercount is
        narrower than "everything deleted".
        """
        with self._conn() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM captures WHERE batch_id = ?",
                (batch_id,),
            ).fetchone()
            counted = int(row["n"] or 0)
            conn.execute(
                "UPDATE batches SET episodes_recorded = ?, "
                "episodes_recorded_is_floor = 1 WHERE batch_id = ?",
                (counted, batch_id),
            )
        return counted

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

    def live_capture_counts(self, batch_ids: Iterable[str]) -> dict[str, int]:
        """Live capture count per batch, in ONE query (§8, E-27).

        Same filter as :meth:`list_captures_by_batch` — tombstones drop out,
        because the count is displayed beside a caption promising "recordings
        still on disk". Grouped rather than asked per batch: the list endpoint
        used to run one query per batch to produce nothing but these numbers.
        """
        ids = [str(b) for b in batch_ids]
        if not ids:
            return {}
        id_slots = ", ".join("?" for _ in ids)
        state_slots = ", ".join("?" for _ in TOMBSTONE_STATES)
        with self._conn() as conn:
            rows = conn.execute(
                f"SELECT batch_id, COUNT(*) AS n FROM captures "
                f"WHERE batch_id IN ({id_slots}) "
                f"AND state NOT IN ({state_slots}) GROUP BY batch_id",
                (*ids, *sorted(TOMBSTONE_STATES)),
            ).fetchall()
        counts = {row["batch_id"]: row["n"] for row in rows}
        return {batch_id: counts.get(batch_id, 0) for batch_id in ids}

    @staticmethod
    def _batch_filters(
        status: str | None, robot: str | None, operator: str | None
    ) -> tuple[str, list[Any]]:
        """The shared ``WHERE`` for the batch list and its count.

        One builder for both so a filter can never scope the page without also
        scoping the total — which would be a paginated list whose own count
        disagrees with it.
        """
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
        return (f"WHERE {' AND '.join(clauses)}" if clauses else ""), params

    def count_batches(
        self,
        status: str | None = None,
        *,
        robot: str | None = None,
        operator: str | None = None,
    ) -> int:
        """How many batches match the filters, ignoring any page window."""
        where, params = self._batch_filters(status, robot, operator)
        with self._conn() as conn:
            row = conn.execute(
                f"SELECT COUNT(*) AS n FROM batches {where}", params
            ).fetchone()
        return int(row["n"])

    def list_batches(
        self,
        status: str | None = None,
        *,
        robot: str | None = None,
        operator: str | None = None,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[Batch]:
        """Batches newest-first, optionally one page at a time.

        The window is applied in SQL rather than by slicing the result: at the
        5000-batch scale that motivated it (E-27), reading every row to return
        fifty is the cost the page was meant to avoid.

        ``limit=None`` means no window, which is the default and the pre-paging
        behaviour. SQLite has no OFFSET without a LIMIT, so an offset asked for
        on its own rides on ``LIMIT -1`` — its spelling for "no bound".
        """
        where, params = self._batch_filters(status, robot, operator)
        window = ""
        if limit is not None or offset:
            window = " LIMIT ? OFFSET ?"
            params.extend([-1 if limit is None else limit, offset])
        with self._conn() as conn:
            rows = conn.execute(
                f"SELECT * FROM batches {where} ORDER BY seq DESC{window}", params
            ).fetchall()
        return [self._batch_from_row(r) for r in rows]

    def coverage_by_condition(self, task: str) -> list[tuple[str, int, bool]]:
        """``(condition, recorded, is_floor)`` per condition of *task*, in SQL.

        Aggregated by the database rather than by summing a batch list: Collect
        polls this every 30s, and at the 5000-batch scale that motivated E-27
        the list it used to add up was 817 KiB per response. Grouping here means
        the wire carries one row per condition — a handful — instead of every
        batch that ever ran.

        ``recorded`` sums the monotone ``episodes_recorded``; ``is_floor`` is a
        MAX over the per-batch floor flags, because a sum is a lower bound as
        soon as one term is (§8.2 rule 6).

        Batches with no condition are excluded, including the literal ``'—'``:
        that is the dash the console displays for "unset", and a console that
        had to send something once wrote it into the catalog as a real value
        (E-5). Counting it would report a condition named after the absence of
        one. Rows come back ordered by condition so the caller merging its plan
        vocabulary in gets a stable list.
        """
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT condition, "
                "SUM(episodes_recorded) AS recorded, "
                "MAX(episodes_recorded_is_floor) AS is_floor "
                "FROM batches "
                "WHERE task = ? AND condition IS NOT NULL "
                "AND condition NOT IN ('', '—') "
                "GROUP BY condition ORDER BY condition",
                (task,),
            ).fetchall()
        return [
            (row["condition"], int(row["recorded"] or 0), bool(row["is_floor"]))
            for row in rows
        ]

    def list_captures_by_batch(self, batch_id: str) -> list[Capture]:
        """LIVE captures of a batch — tombstones excluded.

        The batch summary's episode list feeds Collect's strip chips, quality
        tallies and coverage, whose own caption promises they "only cover
        recordings still on disk" — a capture deleted in Review must therefore
        drop out here. (The batch's monotone ``episodes_recorded`` counter is
        the deliberate opposite and is untouched by this filter.)
        """
        placeholders = ", ".join("?" for _ in TOMBSTONE_STATES)
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM captures_with_lease WHERE batch_id = ? "
                f"AND state NOT IN ({placeholders}) "
                "ORDER BY index_in_batch, seq",
                (batch_id, *sorted(TOMBSTONE_STATES)),
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

    def get_plan_catalog(
        self,
    ) -> tuple[list[Any], list[str] | None, list[str] | None, str] | None:
        """``(projects, failure_reasons, operators, updated_at)`` or ``None``.

        ``None`` is distinct from an explicitly emptied catalog (``([], ts)``):
        the client seeds the server from its local copy only in the never-set
        case, so conflating them would resurrect a catalog somebody cleared.
        ``failure_reasons`` carries the same never-set semantics on its own:
        ``None`` until a client first pushes it (a catalog written before the
        field existed reads back as ``None``, and the payload may still be the
        pre-field bare list of projects).
        """
        with self._conn() as conn:
            row = conn.execute(
                "SELECT payload, updated_at FROM plan_catalog WHERE id = 1"
            ).fetchone()
        if row is None:
            return None
        try:
            payload = json.loads(row["payload"])
        except ValueError:
            return None
        if isinstance(payload, list):  # pre-failure_reasons payload shape
            return payload, None, None, row["updated_at"]
        if not isinstance(payload, dict):
            return None
        if not isinstance(payload.get("projects"), list):
            return None

        def _str_list(key: str) -> list[str] | None:
            value = payload.get(key)
            if isinstance(value, list) and all(isinstance(v, str) for v in value):
                return value
            return None

        return (
            payload["projects"],
            _str_list("failure_reasons"),
            _str_list("operators"),
            row["updated_at"],
        )

    def set_plan_catalog(
        self,
        projects: list[Any],
        updated_at: str,
        failure_reasons: list[str] | None = None,
        operators: list[str] | None = None,
    ) -> None:
        """Replace the shared plan catalog and mirror it to disk.

        A ``None`` vocabulary (failure_reasons / operators) means "leave the
        stored one as it is" (a client that predates the field must not wipe
        it), so the effective values are re-read before writing.
        """
        if failure_reasons is None or operators is None:
            stored = self.get_plan_catalog()
            if stored is not None:
                if failure_reasons is None:
                    failure_reasons = stored[1]
                if operators is None:
                    operators = stored[2]
        payload = json.dumps(
            {
                "projects": projects,
                "failure_reasons": failure_reasons,
                "operators": operators,
            },
            ensure_ascii=False,
        )
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO plan_catalog (id, payload, updated_at) VALUES (1, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET "
                "payload = excluded.payload, updated_at = excluded.updated_at",
                (payload, updated_at),
            )
        self._mirror_plan_catalog(projects, failure_reasons, operators, updated_at)

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

    def _mirror_plan_catalog(
        self,
        projects: list[Any],
        failure_reasons: list[str] | None,
        operators: list[str] | None,
        updated_at: str,
    ) -> None:
        catalog = self._catalog_dir()
        if catalog is None:
            return
        try:
            atomic_write_json(
                catalog / PLAN_CATALOG_SIDECAR,
                {
                    "schema_version": SCHEMA_VERSION,
                    "projects": projects,
                    "failure_reasons": failure_reasons,
                    "operators": operators,
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

        payload = read_json(catalog / TEMPLATES_SIDECAR)
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

        plan = read_json(catalog / PLAN_CATALOG_SIDECAR)
        if plan is not None and isinstance(plan.get("projects"), list):

            def _side_list(key: str) -> list[str] | None:
                value = plan.get(key)  # absent in pre-field sidecars
                if isinstance(value, list) and all(isinstance(v, str) for v in value):
                    return value
                return None

            reasons = _side_list("failure_reasons")
            side_operators = _side_list("operators")
            with self._conn() as conn:
                conn.execute(
                    "INSERT INTO plan_catalog (id, payload, updated_at) "
                    "VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET "
                    "payload = excluded.payload, updated_at = excluded.updated_at",
                    (
                        json.dumps(
                            {
                                "projects": plan["projects"],
                                "failure_reasons": reasons,
                                "operators": side_operators,
                            },
                            ensure_ascii=False,
                        ),
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
                try:
                    self._upsert_rebuilt_capture(conn, row, now)
                except sqlite3.IntegrityError as exc:
                    # The upsert resolves a ``capture_id`` conflict; ``run_id``
                    # is a SECOND unique index and nothing here can merge on
                    # it. Two captures on disk sharing a display name is data
                    # this process did not choose and cannot refuse — but
                    # letting it out of here aborts the whole pass, and this
                    # runs from the periodic reconciler, so one duplicate name
                    # would stop adoption, the incoming sweep, the trash reaper
                    # and the views prune for good. The capture keeps whatever
                    # row it already had (or none) and is reported.
                    logger.error(
                        "rebuild could not write a capture row; skipped",
                        extra={
                            "capture_id": row.capture_id,
                            "run_id": row.run_id,
                            "error": str(exc),
                        },
                    )
                    continue
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
        if row.quick_check is not None:
            # Only when the sidecar HAD one. Absent means "this capture predates
            # quick_check.json, or settlement never ran, or the file was
            # truncated" — none of which is evidence that a verdict the row
            # already holds is wrong, and blanking it would make a reconcile
            # pass over an older store erase the very thing §4.2 added.
            columns["quick_check"] = json.dumps(row.quick_check)
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
    # Implementations live in row_mappers.py. Bound as class attributes (not
    # re-implemented) so every call site keeps going through the class — a
    # class-level patch of e.g. ``_capture_from_row`` still intercepts them.

    _encode = staticmethod(row_mappers.encode_field)
    _capture_columns = staticmethod(row_mappers.capture_columns)
    _capture_from_row = staticmethod(row_mappers.capture_from_row)
    _replica_from_row = staticmethod(row_mappers.replica_from_row)
    _member_from_row = staticmethod(row_mappers.member_from_row)
    _job_from_row = staticmethod(row_mappers.job_from_row)
    _template_from_row = staticmethod(row_mappers.template_from_row)
    _batch_from_row = staticmethod(row_mappers.batch_from_row)

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


def _paths_collide(one: str, other: str) -> bool:
    """Whether two archive destinations are — or contain — one another.

    Nesting counts as a collision: a dataset archived into ``<dest>/sub`` puts
    its numbered directories underneath another dataset's folder, inside the
    reach of that folder's manifest.

    Compared as the normalized strings that are stored, not through
    ``realpath``: a second spelling of one folder through a symlink is left to
    the not-empty check, which sees the bytes whatever the path is called.
    """
    first = os.path.normpath(one)
    second = os.path.normpath(other)
    return (
        first == second
        or first.startswith(second + os.sep)
        or second.startswith(first + os.sep)
    )
