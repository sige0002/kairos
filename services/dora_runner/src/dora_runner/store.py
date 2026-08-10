"""Persistent job and validation-template state for dora_runner.

The store is SQLite-backed so job/template state survives a process restart
(release-readiness finding F4/MS-6: an in-memory store orphaned in-flight work on
restart, breaking the crash-recovery symmetry the recorder/orchestrator uphold).
Connection management is :mod:`kairos_common.sqlite_store`, shared with
``api_orchestrator.store``: a lock serializes connection use, a file DB gets a
fresh connection per call and ``:memory:`` reuses one held connection. The
schema POLICY stays here — a stale ``PRAGMA user_version`` drops this service's
``jobs`` table (see :meth:`RunnerStore._recreate_outdated`), which is a
different decision from the orchestrator's, and deliberately so.

Execution stays in-process: a running job keeps a live :class:`JobRecord` (holding
its ``asyncio.Task``) in :attr:`RunnerStore.jobs`, guarded by the asyncio
:attr:`RunnerStore.lock`; that in-memory handle is *checkpointed* to the ``jobs``
table on each state transition (queued -> running -> terminal). We persist STATE,
not a distributed queue. On startup :meth:`reconcile_interrupted_jobs` marks any
row still ``queued``/``running`` as ``failed`` with an honest interrupted reason,
so ``GET /jobs/{id}/status`` and ``/result`` serve a terminal outcome even for a
job whose worker vanished with the old process.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from kairos_common import JobState, utc_now_iso8601
from kairos_common.sqlite_store import SqliteConnection, set_user_version, user_version

from dora_runner.models import JobResult, JobStatus, ValidationTemplate

# Bumped whenever the schema changes in a non-additive way; recorded via
# ``PRAGMA user_version``. Version 2 keys jobs by capture_id (§10.5).
_SCHEMA_VERSION = 2

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    -- Monotonic insertion order (unused today, but mirrors the orchestrator and
    -- keeps a stable ordering key for a future job list).
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id     TEXT NOT NULL UNIQUE,
    capture_id TEXT NOT NULL,
    pipeline   TEXT NOT NULL,
    -- The job's params (JSON): makes the persisted row self-describing.
    params     TEXT NOT NULL DEFAULT '{}',
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
    UNIQUE(name, version)
);
CREATE INDEX IF NOT EXISTS idx_validation_templates_seq
    ON validation_templates (seq DESC);
"""

# The honest terminal outcome written to a job whose worker was lost to a restart.
# ``state`` is ``failed`` (not a new enum member): the shared ``JobState`` has no
# ``interrupted`` value, and the orchestrator's ``run_job_to_completion`` only
# treats succeeded/failed/canceled as terminal — so an interrupted job must land on
# ``failed`` and carry the reason in the summary (exactly like the timeout path),
# which ``datasets._job_failure_reason`` and the Validation UI already surface.
_INTERRUPTED_MESSAGE = "dora_runner restarted while the job was in flight."
_INTERRUPTED_SUMMARY: dict[str, Any] = {
    "result": "fail",
    "reason": "interrupted",
    "error": {"code": "job_interrupted", "message": _INTERRUPTED_MESSAGE},
}


@dataclass
class JobRecord:
    """Mutable in-process handle for a running job.

    Holds the live ``asyncio.Task`` and the working copy of the job's state that
    the worker mutates directly; :meth:`RunnerStore.persist_job` checkpoints it to
    SQLite at each transition.
    """

    job_id: str
    capture_id: str
    pipeline: str
    params: dict[str, Any]
    state: JobState = JobState.queued
    progress: float = 0.0
    logs_tail: list[str] = field(default_factory=list)
    result: JobResult | None = None
    task: asyncio.Task[None] | None = None
    # Cooperative cancellation: cancel of a RUNNING job sets this event (a
    # ``threading.Event`` because the heavy work runs in a threadpool or a
    # subprocess watcher) and the worker stops at its next checkpoint. The
    # state stays ``running`` until the work is actually dead — see
    # ``JobStatus.cancel_requested`` for why the flag is public.
    cancel_requested: bool = False
    cancel_event: threading.Event = field(default_factory=threading.Event)

    def status(self) -> JobStatus:
        """Return the public status view."""
        return JobStatus(
            job_id=self.job_id,
            capture_id=self.capture_id,
            pipeline=self.pipeline,
            state=self.state,
            progress=self.progress,
            logs_tail=self.logs_tail[-50:],
            cancel_requested=self.cancel_requested,
        )


class RunnerStore:
    """SQLite-backed store for dora_runner jobs/templates.

    Args:
        db_path: Path to the SQLite file (``/data/dora_runner.db`` in production).
            Parent directories are created. Defaults to ``":memory:"`` (a single
            shared connection) so a bare ``RunnerStore()`` — used by unit tests and
            in-process runners — stays isolated and needs no filesystem.

    :attr:`jobs` and :attr:`lock` preserve the previous in-memory surface: the
    asyncio worker still tracks live jobs in the dict under the asyncio lock (that
    guard is what keeps a cancel from racing the worker — BUG-D). The SQLite
    connection carries its own threading lock (inside ``_db``), independent of the
    asyncio lock, so a checkpoint taken while holding the asyncio lock never
    deadlocks.
    """

    def __init__(self, db_path: str | Path = ":memory:") -> None:
        # Live in-process handles (asyncio.Task + working state) for running jobs.
        self.jobs: dict[str, JobRecord] = {}
        # Serializes async worker state transitions (queued/running/terminal) and
        # mutation of ``jobs`` — unchanged from the pre-persistence store.
        self.lock = asyncio.Lock()

        # busy_timeout is per-connection: wait for a competing writer rather
        # than raising "database is locked" at once.
        self._db = SqliteConnection(
            db_path, connect_pragmas=("PRAGMA busy_timeout = 5000",)
        )
        self._path = self._db.path
        with self._conn() as conn:
            if not self._db.is_memory:
                # WAL persists in the file header and lets readers run
                # concurrently with the single writer, so a job-status poll
                # never blocks a running job's checkpoint.
                conn.execute("PRAGMA journal_mode=WAL")
            self._recreate_outdated(conn)
            conn.executescript(_SCHEMA)
            set_user_version(conn, _SCHEMA_VERSION)

    @staticmethod
    def _recreate_outdated(conn: sqlite3.Connection) -> None:
        """Drop a ``jobs`` table written by an older schema, before recreating it.

        Contract §8 calls jobs **volatile** — they are excluded from rebuild
        precisely because nothing downstream depends on a finished job's row
        surviving. So a schema change here recreates the table instead of
        migrating it: the v1 table is keyed by ``run_id``, and a run_id is not a
        capture_id that a v2 job could resolve to a directory. Keeping those rows
        would mean serving job history that points at a source layout which no
        longer exists.

        ``validation_templates`` is deliberately left alone: it is a cache the
        orchestrator refills (it injects the full template object into a job's
        params), and it has not changed shape.
        """
        if user_version(conn) < _SCHEMA_VERSION:
            conn.execute("DROP TABLE IF EXISTS jobs")

    def _conn(self) -> AbstractContextManager[sqlite3.Connection]:
        """Yield a connection under the lock, committing on success."""
        return self._db.connect()

    def close(self) -> None:
        """Close the shared in-memory connection (no-op for file DBs)."""
        self._db.close()

    # ---- jobs -------------------------------------------------------------

    def persist_job(self, job: JobRecord) -> None:
        """Checkpoint a live :class:`JobRecord` to the ``jobs`` table.

        Called on each state transition (coarse by design — not per log line). An
        upsert: ``created_at`` is set once on insert; ``result`` is only overwritten
        when the record carries one, so an intermediate ``running`` checkpoint never
        wipes a result written earlier.
        """
        now = utc_now_iso8601()
        result_json = (
            json.dumps(job.result.model_dump()) if job.result is not None else None
        )
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO jobs
                    (job_id, capture_id, pipeline, params, state, progress,
                     logs_tail, result, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
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
                    json.dumps(job.params),
                    job.state.value,
                    job.progress,
                    json.dumps(job.logs_tail),
                    result_json,
                    now,
                    now,
                ),
            )

    def get_persisted_job(self, job_id: str) -> JobStatus | None:
        """Return the persisted job status, or ``None`` if absent.

        The read-path fallback for a job with no live :class:`JobRecord` — e.g. one
        marked ``failed``/interrupted at startup after the worker's process died.
        """
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
        if row is None:
            return None
        logs = json.loads(row["logs_tail"]) if row["logs_tail"] else []
        return JobStatus(
            job_id=row["job_id"],
            capture_id=row["capture_id"],
            pipeline=row["pipeline"],
            state=JobState(row["state"]),
            progress=float(row["progress"]),
            logs_tail=logs[-50:],
        )

    def get_persisted_result(self, job_id: str) -> JobResult | None:
        """Return the persisted terminal result for a job, or ``None``."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT result FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
        if row is None or not row["result"]:
            return None
        return JobResult.model_validate(json.loads(row["result"]))

    def reconcile_interrupted_jobs(self) -> int:
        """Fail any job left ``queued``/``running`` by a previous process.

        In-flight execution does not survive a restart (state is persisted, work is
        not), so an orphaned row is resolved to a terminal ``failed`` state carrying
        the interrupted reason — mirroring the orchestrator's honest-reason
        reconciliation for interrupted runs. Returns the number reconciled.
        """
        now = utc_now_iso8601()
        result_json = json.dumps({"summary": _INTERRUPTED_SUMMARY, "artifacts": []})
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT job_id, logs_tail FROM jobs "
                "WHERE state IN ('queued', 'running')"
            ).fetchall()
            for row in rows:
                logs = json.loads(row["logs_tail"]) if row["logs_tail"] else []
                logs.append(_INTERRUPTED_MESSAGE)
                conn.execute(
                    """
                    UPDATE jobs
                    SET state = ?, progress = 1.0, logs_tail = ?, result = ?,
                        updated_at = ?
                    WHERE job_id = ?
                    """,
                    (
                        JobState.failed.value,
                        json.dumps(logs),
                        result_json,
                        now,
                        row["job_id"],
                    ),
                )
        return len(rows)

    # ---- validation templates --------------------------------------------

    async def add_template(self, template: ValidationTemplate) -> ValidationTemplate:
        """Create or replace a template by ``(name, version)``.

        Async only for call-site compatibility; the body is a fast synchronous
        upsert. A collision on ``(name, version)`` overwrites ``required_topics``.
        """
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO validation_templates (name, version, required_topics)
                VALUES (?, ?, ?)
                ON CONFLICT(name, version) DO UPDATE SET
                    required_topics = excluded.required_topics
                """,
                (
                    template.name,
                    template.version,
                    json.dumps([t.model_dump() for t in template.required_topics]),
                ),
            )
        return template

    async def list_templates(
        self, limit: int, cursor: int | None
    ) -> tuple[list[ValidationTemplate], int | None]:
        """Return a newest-first template page and the next cursor (a ``seq``)."""
        params: list[Any] = []
        where = ""
        if cursor is not None:
            where = "WHERE seq < ?"
            params.append(cursor)
        params.append(limit + 1)
        with self._conn() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM validation_templates {where}
                ORDER BY seq DESC LIMIT ?
                """,
                params,
            ).fetchall()
        has_more = len(rows) > limit
        page = rows[:limit]
        templates = [self._template_from_row(r) for r in page]
        next_cursor = int(page[-1]["seq"]) if has_more and page else None
        return templates, next_cursor

    async def get_template(self, name: str) -> ValidationTemplate | None:
        """Return the newest template with *name* (highest ``seq``)."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM validation_templates WHERE name = ? "
                "ORDER BY seq DESC LIMIT 1",
                (name,),
            ).fetchone()
        return self._template_from_row(row) if row is not None else None

    @staticmethod
    def _template_from_row(row: sqlite3.Row) -> ValidationTemplate:
        """Rebuild a validation template from a database row."""
        raw = json.loads(row["required_topics"]) if row["required_topics"] else []
        return ValidationTemplate(
            name=row["name"], version=row["version"], required_topics=raw
        )
