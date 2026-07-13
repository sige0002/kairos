"""SQLite runs store — the single source of truth for runs.

Per ``api_orchestrator.md`` the orchestrator's SQLite is canonical; the
recorder's ``manifest.json`` is audit-only. This module owns the ``runs``
table and translates between rows and the :class:`~api_orchestrator.models.Run`
model. Scalar lifecycle fields are columns; variable-shape fields (topics,
split, error) are stored as JSON text.

The store is deliberately small and synchronous (stdlib ``sqlite3``). SQLite
calls are fast and local; FastAPI handlers call it directly. A reentrant lock
serializes connection use so concurrent requests (and FastAPI's thread pool)
can't interleave access to the shared in-memory connection.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from kairos_common import Compression, JobState

from api_orchestrator.models import (
    Batch,
    Episode,
    JobCreateResponse,
    JobResult,
    JobStatus,
    Run,
    RunError,
    RunState,
    RunTopic,
    Split,
    ValidationTemplate,
)


class RunExistsError(Exception):
    """Raised by :meth:`RunStore.create` when ``run_id`` already exists.

    Lets the run-allocation path re-allocate a unique id and retry instead of
    surfacing an opaque ``sqlite3.IntegrityError`` (which would become a 500).
    """

    def __init__(self, run_id: str) -> None:
        super().__init__(f"Run already exists: {run_id}")
        self.run_id = run_id


class BatchExistsError(Exception):
    """Raised by :meth:`RunStore.create_batch` when ``batch_id`` already exists.

    Lets the batch-allocation path re-allocate a unique id and retry, mirroring
    :class:`RunExistsError`.
    """

    def __init__(self, batch_id: str) -> None:
        super().__init__(f"Batch already exists: {batch_id}")
        self.batch_id = batch_id


class EpisodeRunExistsError(Exception):
    """Raised by :meth:`RunStore.create_episode` when ``run_id`` already has one.

    ``episodes.run_id`` is UNIQUE (1 episode = 1 run), so a second episode for
    the same run is a conflict the router maps to ``409`` rather than a 500.
    """

    def __init__(self, run_id: str) -> None:
        super().__init__(f"Run already has an episode: {run_id}")
        self.run_id = run_id


_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    -- Monotonic insertion order; the cursor pages on this, newest first.
    -- AUTOINCREMENT lets SQLite assign it (no read-modify-write), so insertion
    -- order is correct even across processes (future-proof beyond the lock).
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT NOT NULL UNIQUE,
    state         TEXT NOT NULL,
    started_at    TEXT,
    ended_at      TEXT,
    topics        TEXT NOT NULL DEFAULT '[]',
    compression   TEXT NOT NULL DEFAULT 'none',
    split         TEXT,
    message_count INTEGER,
    bytes         INTEGER,
    error         TEXT,
    -- Session metadata captured at record start.
    operator      TEXT,
    task          TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_seq ON runs (seq DESC);

CREATE TABLE IF NOT EXISTS jobs (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id        TEXT NOT NULL UNIQUE,
    run_id        TEXT NOT NULL,
    pipeline      TEXT NOT NULL,
    state         TEXT NOT NULL,
    progress      REAL NOT NULL DEFAULT 0,
    logs_tail     TEXT NOT NULL DEFAULT '[]',
    result        TEXT,
    created_at    TEXT,
    updated_at    TEXT
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

-- Console v2 Phase 2: a Collect batch groups the episodes recorded in one run
-- of a task/condition. Kept separate from runs/jobs so the recording path is
-- untouched (an episode only references a run; runs never reference a batch).
CREATE TABLE IF NOT EXISTS batches (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id        TEXT NOT NULL UNIQUE,
    robot           TEXT,
    project         TEXT NOT NULL,
    task            TEXT NOT NULL,
    condition       TEXT,
    operator        TEXT,
    target_episodes INTEGER NOT NULL DEFAULT 30,
    status          TEXT NOT NULL DEFAULT 'active',
    ended_reason    TEXT,
    created_at      TEXT,
    ended_at        TEXT,
    -- Monotone count of episodes ever recorded into this batch: incremented on
    -- every POST /episodes and NEVER decremented (a run-delete cascade removes
    -- the episode row but leaves this untouched), so Collect's "N / 30" stays
    -- truthful to what was captured even after a Review exclude/delete.
    episodes_recorded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_batches_seq ON batches (seq DESC);

-- One episode == one run (episodes.run_id UNIQUE). The operator's task result +
-- quality call, and Review's adopt/exclude, are persisted here so Review shows
-- real data on any terminal (replacing the browser-local episodeBridge).
CREATE TABLE IF NOT EXISTS episodes (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id      TEXT NOT NULL UNIQUE,
    batch_id        TEXT NOT NULL,
    run_id          TEXT NOT NULL UNIQUE,
    index_in_batch  INTEGER NOT NULL,
    task_result     TEXT,
    failure_reason  TEXT,
    quality         TEXT,
    quality_source  TEXT NOT NULL DEFAULT 'operator',
    review_status   TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT,
    updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_episodes_seq ON episodes (seq DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_batch ON episodes (batch_id);
"""

# Columns an update_batch / update_episode patch may target (typo guard). All
# scalar text/int columns, so patch values pass straight through to SQLite.
_BATCH_UPDATE_FIELDS = {
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
_EPISODE_UPDATE_FIELDS = {
    "batch_id",
    "run_id",
    "index_in_batch",
    "task_result",
    "failure_reason",
    "quality",
    "quality_source",
    "review_status",
    "created_at",
    "updated_at",
}


class RunStore:
    """Persistent runs table backed by SQLite.

    Args:
        db_path: Path to the SQLite file (``/data/kairos.db`` in production).
            Parent directories are created. ``":memory:"`` is supported for
            tests via a single shared connection.
    """

    def __init__(self, db_path: str | Path) -> None:
        self._path = str(db_path)
        # Serializes every connection use (reentrant: write helpers nest reads).
        self._lock = threading.RLock()
        self._shared: sqlite3.Connection | None = None
        if self._path != ":memory:":
            Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        else:
            # In-memory DBs vanish when their connection closes, so keep one.
            # check_same_thread=False: FastAPI runs sync handlers in a thread
            # pool, so the shared connection is touched from worker threads;
            # the module lock serializes access.
            self._shared = sqlite3.connect(self._path, check_same_thread=False)
            self._shared.row_factory = sqlite3.Row
        with self._conn() as conn:
            conn.executescript(_SCHEMA)
            self._migrate(conn)

    @staticmethod
    def _migrate(conn: sqlite3.Connection) -> None:
        """Additive migrations for DBs created before a column existed.

        ``CREATE TABLE IF NOT EXISTS`` never alters an existing table, so add any
        newly-introduced nullable columns here (idempotent: guarded by PRAGMA).
        """
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(runs)")}
        for column in ("operator", "task"):
            if column not in existing:
                conn.execute(f"ALTER TABLE runs ADD COLUMN {column} TEXT")
        # Console v2 Phase 2: monotone recorded-episode counter on batches. For a
        # DB created before this column, add it and backfill from the current
        # episode count (best available truth for pre-existing batches).
        batch_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(batches)")
        }
        if "episodes_recorded" not in batch_cols:
            conn.execute(
                "ALTER TABLE batches ADD COLUMN "
                "episodes_recorded INTEGER NOT NULL DEFAULT 0"
            )
            conn.execute(
                "UPDATE batches SET episodes_recorded = (SELECT COUNT(*) FROM "
                "episodes WHERE episodes.batch_id = batches.batch_id) "
                "WHERE episodes_recorded = 0"
            )

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        """Yield a connection under the lock, committing on success.

        The lock serializes all access so the shared connection is safe across
        FastAPI's thread pool. For a file DB a fresh connection is opened per
        call and closed afterwards (no leaked descriptors); the in-memory DB
        reuses its single shared connection (closing it would drop the data).
        """
        with self._lock:
            if self._shared is not None:
                yield self._shared
                self._shared.commit()
                return
            conn = sqlite3.connect(self._path)
            conn.row_factory = sqlite3.Row
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

    # ---- writes -----------------------------------------------------------

    def create(self, run: Run) -> Run:
        """Insert a new run row (state typically ``created``).

        ``seq`` is assigned by SQLite (AUTOINCREMENT). Raises
        :class:`RunExistsError` if ``run_id`` already exists, so the caller can
        re-allocate and retry rather than surface an opaque 500.
        """
        with self._conn() as conn:
            try:
                conn.execute(
                    """
                    INSERT INTO runs
                        (run_id, state, started_at, ended_at, topics,
                         compression, split, message_count, bytes, error,
                         operator, task)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    self._to_columns(run),
                )
            except sqlite3.IntegrityError as exc:
                raise RunExistsError(run.run_id) from exc
        return run

    def update(self, run_id: str, **fields: Any) -> Run:
        """Patch selected columns of an existing run and return the new state.

        Accepts model-level field names (``state``, ``topics``, ``split``,
        ``error``, ``ended_at``, ``message_count``, ``bytes``, ``compression``,
        ``started_at``). Unknown fields raise ``KeyError`` to catch typos.
        """
        if not fields:
            return self.get_or_raise(run_id)
        columns = {k: self._encode_field(k, v) for k, v in fields.items()}
        assignments = ", ".join(f"{name} = ?" for name in columns)
        with self._conn() as conn:
            cur = conn.execute(
                f"UPDATE runs SET {assignments} WHERE run_id = ?",
                (*columns.values(), run_id),
            )
            if cur.rowcount == 0:
                raise KeyError(run_id)
        return self.get_or_raise(run_id)

    def delete(self, run_id: str) -> bool:
        """Delete a run row. Returns ``True`` if a row was removed."""
        with self._conn() as conn:
            cur = conn.execute("DELETE FROM runs WHERE run_id = ?", (run_id,))
        return cur.rowcount > 0

    # ---- reads ------------------------------------------------------------

    def get(self, run_id: str) -> Run | None:
        """Return the run, or ``None`` if it does not exist."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM runs WHERE run_id = ?", (run_id,)
            ).fetchone()
        return self._from_row(row) if row is not None else None

    def get_or_raise(self, run_id: str) -> Run:
        """Return the run or raise ``KeyError`` if absent."""
        run = self.get(run_id)
        if run is None:
            raise KeyError(run_id)
        return run

    def list_runs(
        self, limit: int, cursor: int | None = None
    ) -> tuple[list[Run], int | None]:
        """Return one page of runs (newest first) and the next cursor.

        The cursor is the ``seq`` of the last item on the previous page; rows
        with a strictly smaller ``seq`` follow. One extra row is fetched to
        decide whether a ``next_cursor`` exists. Returns ``(runs, next_cursor)``
        where ``next_cursor`` is the ``seq`` to resume from, or ``None``.
        """
        params: list[Any] = []
        where = ""
        if cursor is not None:
            where = "WHERE seq < ?"
            params.append(cursor)
        params.append(limit + 1)
        with self._conn() as conn:
            rows = conn.execute(
                f"SELECT * FROM runs {where} ORDER BY seq DESC LIMIT ?", params
            ).fetchall()
        has_more = len(rows) > limit
        page = rows[:limit]
        runs = [self._from_row(r) for r in page]
        next_cursor = int(page[-1]["seq"]) if has_more and page else None
        return runs, next_cursor

    def list_by_states(self, states: list[RunState]) -> list[Run]:
        """Return every run currently in one of *states* (for reconciliation)."""
        if not states:
            return []
        placeholders = ", ".join("?" for _ in states)
        with self._conn() as conn:
            rows = conn.execute(
                f"SELECT * FROM runs WHERE state IN ({placeholders}) ORDER BY seq",
                [s.value for s in states],
            ).fetchall()
        return [self._from_row(r) for r in rows]

    # ---- jobs -------------------------------------------------------------

    def upsert_job(
        self,
        job: JobStatus | JobCreateResponse,
        *,
        result: JobResult | dict[str, Any] | None = None,
        created_at: str | None = None,
        updated_at: str | None = None,
    ) -> JobStatus:
        """Insert or update a job row from dora_runner state."""
        result_json = None
        if result is not None:
            result_json = json.dumps(
                result.model_dump() if isinstance(result, JobResult) else result
            )
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO jobs
                    (job_id, run_id, pipeline, state, progress, logs_tail,
                     result, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
                    run_id = excluded.run_id,
                    pipeline = excluded.pipeline,
                    state = excluded.state,
                    progress = excluded.progress,
                    logs_tail = excluded.logs_tail,
                    result = COALESCE(excluded.result, jobs.result),
                    updated_at = excluded.updated_at
                """,
                (
                    job.job_id,
                    job.run_id,
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

    def update_job(self, job_id: str, **fields: Any) -> JobStatus:
        """Patch selected columns of an existing job and return it."""
        if not fields:
            return self.get_job_or_raise(job_id)
        columns = {k: self._encode_job_field(k, v) for k, v in fields.items()}
        assignments = ", ".join(f"{name} = ?" for name in columns)
        with self._conn() as conn:
            cur = conn.execute(
                f"UPDATE jobs SET {assignments} WHERE job_id = ?",
                (*columns.values(), job_id),
            )
            if cur.rowcount == 0:
                raise KeyError(job_id)
        return self.get_job_or_raise(job_id)

    def get_job(self, job_id: str) -> JobStatus | None:
        """Return a job status, or ``None`` if absent."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
        return self._job_from_row(row) if row is not None else None

    def get_job_or_raise(self, job_id: str) -> JobStatus:
        """Return a job or raise ``KeyError`` if absent."""
        job = self.get_job(job_id)
        if job is None:
            raise KeyError(job_id)
        return job

    def get_job_result(self, job_id: str) -> JobResult | None:
        """Return the stored terminal result for a job, if any."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT result FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
        if row is None:
            raise KeyError(job_id)
        if not row["result"]:
            return None
        return JobResult.model_validate(json.loads(row["result"]))

    # ---- validation templates -------------------------------------------

    def create_template(self, template: ValidationTemplate) -> ValidationTemplate:
        """Persist a validation template."""
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO validation_templates
                    (name, version, required_topics)
                VALUES (?, ?, ?)
                """,
                (
                    template.name,
                    template.version,
                    json.dumps([t.model_dump() for t in template.required_topics]),
                ),
            )
        return template

    def list_templates(
        self, limit: int, cursor: int | None = None
    ) -> tuple[list[ValidationTemplate], int | None]:
        """Return one page of validation templates, newest first."""
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

    # ---- batches ----------------------------------------------------------

    def create_batch(self, batch: Batch) -> Batch:
        """Insert a new batch row. Raises :class:`BatchExistsError` on a
        ``batch_id`` collision so the caller can re-allocate and retry."""
        with self._conn() as conn:
            try:
                conn.execute(
                    """
                    INSERT INTO batches
                        (batch_id, robot, project, task, condition, operator,
                         target_episodes, status, ended_reason, created_at,
                         ended_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise BatchExistsError(batch.batch_id) from exc
        return batch

    def update_batch(self, batch_id: str, **fields: Any) -> Batch:
        """Patch selected columns of a batch and return it (``KeyError`` if
        absent). Unknown fields raise ``KeyError`` to catch typos."""
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

    def get_batch(self, batch_id: str) -> Batch | None:
        """Return the batch, or ``None`` if it does not exist."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM batches WHERE batch_id = ?", (batch_id,)
            ).fetchone()
        return self._batch_from_row(row) if row is not None else None

    def get_batch_or_raise(self, batch_id: str) -> Batch:
        """Return the batch or raise ``KeyError`` if absent."""
        batch = self.get_batch(batch_id)
        if batch is None:
            raise KeyError(batch_id)
        return batch

    def list_batches(self, status: str | None = None) -> list[Batch]:
        """Return batches newest-first, optionally filtered by ``status``."""
        params: list[Any] = []
        where = ""
        if status is not None:
            where = "WHERE status = ?"
            params.append(status)
        with self._conn() as conn:
            rows = conn.execute(
                f"SELECT * FROM batches {where} ORDER BY seq DESC", params
            ).fetchall()
        return [self._batch_from_row(r) for r in rows]

    # ---- episodes ---------------------------------------------------------

    def create_episode(self, episode: Episode) -> Episode:
        """Insert a new episode row. Raises :class:`EpisodeRunExistsError` when
        the run already has an episode (``episodes.run_id`` UNIQUE)."""
        with self._conn() as conn:
            try:
                conn.execute(
                    """
                    INSERT INTO episodes
                        (episode_id, batch_id, run_id, index_in_batch,
                         task_result, failure_reason, quality, quality_source,
                         review_status, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        episode.episode_id,
                        episode.batch_id,
                        episode.run_id,
                        episode.index_in_batch,
                        episode.task_result,
                        episode.failure_reason,
                        episode.quality,
                        episode.quality_source,
                        episode.review_status,
                        episode.created_at,
                        episode.updated_at,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise EpisodeRunExistsError(episode.run_id) from exc
            # Bump the batch's monotone recorded counter in the same transaction.
            # A no-op if the batch is absent (the caller validates it first).
            conn.execute(
                "UPDATE batches SET episodes_recorded = episodes_recorded + 1 "
                "WHERE batch_id = ?",
                (episode.batch_id,),
            )
        return episode

    def update_episode(self, episode_id: str, **fields: Any) -> Episode:
        """Patch selected columns of an episode and return it (``KeyError`` if
        absent). Unknown fields raise ``KeyError`` to catch typos."""
        if not fields:
            return self.get_episode_or_raise(episode_id)
        for name in fields:
            if name not in _EPISODE_UPDATE_FIELDS:
                raise KeyError(f"Unknown episode field: {name}")
        assignments = ", ".join(f"{name} = ?" for name in fields)
        with self._conn() as conn:
            cur = conn.execute(
                f"UPDATE episodes SET {assignments} WHERE episode_id = ?",
                (*fields.values(), episode_id),
            )
            if cur.rowcount == 0:
                raise KeyError(episode_id)
        return self.get_episode_or_raise(episode_id)

    def get_episode(self, episode_id: str) -> Episode | None:
        """Return the episode, or ``None`` if it does not exist."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM episodes WHERE episode_id = ?", (episode_id,)
            ).fetchone()
        return self._episode_from_row(row) if row is not None else None

    def get_episode_or_raise(self, episode_id: str) -> Episode:
        """Return the episode or raise ``KeyError`` if absent."""
        episode = self.get_episode(episode_id)
        if episode is None:
            raise KeyError(episode_id)
        return episode

    def get_episode_by_run_id(self, run_id: str) -> Episode | None:
        """Return the episode attached to *run_id*, or ``None`` (1 run = 1 ep)."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM episodes WHERE run_id = ?", (run_id,)
            ).fetchone()
        return self._episode_from_row(row) if row is not None else None

    def list_episodes_by_batch(self, batch_id: str) -> list[Episode]:
        """Return a batch's episodes ordered by ``index_in_batch``."""
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT * FROM episodes WHERE batch_id = ?
                ORDER BY index_in_batch, seq
                """,
                (batch_id,),
            ).fetchall()
        return [self._episode_from_row(r) for r in rows]

    def episodes_by_run_ids(self, run_ids: list[str]) -> dict[str, Episode]:
        """Return ``{run_id: Episode}`` for the given runs that have an episode.

        Batch lookup for the ``GET /runs`` list join (avoids N+1 per-run reads).
        """
        if not run_ids:
            return {}
        placeholders = ", ".join("?" for _ in run_ids)
        with self._conn() as conn:
            rows = conn.execute(
                f"SELECT * FROM episodes WHERE run_id IN ({placeholders})", run_ids
            ).fetchall()
        return {row["run_id"]: self._episode_from_row(row) for row in rows}

    def delete_episode_by_run_id(self, run_id: str) -> bool:
        """Delete the episode attached to *run_id*. Returns ``True`` if removed.

        Called when a run is deleted so the episode is cascaded in code (we do
        not rely on a SQLite FK pragma).
        """
        with self._conn() as conn:
            cur = conn.execute("DELETE FROM episodes WHERE run_id = ?", (run_id,))
        return cur.rowcount > 0

    # ---- (de)serialization ------------------------------------------------

    @staticmethod
    def _encode_field(name: str, value: Any) -> Any:
        """Encode one model-level field into its column representation."""
        if name == "topics":
            topics = value or []
            return json.dumps(
                [t.model_dump() if isinstance(t, RunTopic) else t for t in topics]
            )
        if name == "split":
            if value is None:
                return None
            return json.dumps(value.model_dump() if isinstance(value, Split) else value)
        if name == "error":
            if value is None:
                return None
            return json.dumps(
                value.model_dump() if isinstance(value, RunError) else value
            )
        if name in {"state", "compression"}:
            # Accept either a StrEnum member or a plain string.
            return value.value if hasattr(value, "value") else str(value)
        if name in {
            "started_at",
            "ended_at",
            "message_count",
            "bytes",
            "run_id",
            "operator",
            "task",
        }:
            return value
        raise KeyError(f"Unknown run field: {name}")

    def _to_columns(self, run: Run) -> tuple[Any, ...]:
        """Render a full :class:`Run` into the INSERT column tuple (no seq)."""
        return (
            run.run_id,
            run.state.value,
            run.started_at,
            run.ended_at,
            self._encode_field("topics", run.topics),
            run.compression.value,
            self._encode_field("split", run.split),
            run.message_count,
            run.bytes,
            self._encode_field("error", run.error),
            run.operator,
            run.task,
        )

    @staticmethod
    def _from_row(row: sqlite3.Row) -> Run:
        """Rebuild a :class:`Run` from a database row."""
        topics_raw = json.loads(row["topics"]) if row["topics"] else []
        split_raw = json.loads(row["split"]) if row["split"] else None
        error_raw = json.loads(row["error"]) if row["error"] else None
        keys = row.keys()
        return Run(
            run_id=row["run_id"],
            state=RunState(row["state"]),
            started_at=row["started_at"],
            ended_at=row["ended_at"],
            topics=[RunTopic.model_validate(t) for t in topics_raw],
            compression=Compression(row["compression"]),
            split=Split.model_validate(split_raw) if split_raw else None,
            message_count=row["message_count"],
            bytes=row["bytes"],
            error=RunError.model_validate(error_raw) if error_raw else None,
            operator=row["operator"] if "operator" in keys else None,
            task=row["task"] if "task" in keys else None,
        )

    @staticmethod
    def _encode_job_field(name: str, value: Any) -> Any:
        """Encode one job model field for SQLite."""
        if name == "logs_tail":
            return json.dumps(list(value or []))
        if name == "result":
            if value is None:
                return None
            payload = value.model_dump() if isinstance(value, JobResult) else value
            return json.dumps(payload)
        if name == "state":
            return value.value if hasattr(value, "value") else str(value)
        if name in {
            "job_id",
            "run_id",
            "pipeline",
            "progress",
            "created_at",
            "updated_at",
        }:
            return value
        raise KeyError(f"Unknown job field: {name}")

    @staticmethod
    def _job_from_row(row: sqlite3.Row) -> JobStatus:
        """Rebuild a :class:`JobStatus` from a database row."""
        return JobStatus(
            job_id=row["job_id"],
            run_id=row["run_id"],
            pipeline=row["pipeline"],
            state=JobState(row["state"]),
            progress=float(row["progress"]),
            logs_tail=json.loads(row["logs_tail"]) if row["logs_tail"] else [],
        )

    @staticmethod
    def _template_from_row(row: sqlite3.Row) -> ValidationTemplate:
        """Rebuild a validation template from a database row."""
        return ValidationTemplate(
            name=row["name"],
            version=row["version"],
            required_topics=json.loads(row["required_topics"])
            if row["required_topics"]
            else [],
        )

    @staticmethod
    def _batch_from_row(row: sqlite3.Row) -> Batch:
        """Rebuild a :class:`Batch` from a database row."""
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
        )

    @staticmethod
    def _episode_from_row(row: sqlite3.Row) -> Episode:
        """Rebuild an :class:`Episode` from a database row."""
        return Episode(
            episode_id=row["episode_id"],
            batch_id=row["batch_id"],
            run_id=row["run_id"],
            index_in_batch=row["index_in_batch"],
            task_result=row["task_result"],
            failure_reason=row["failure_reason"],
            quality=row["quality"],
            quality_source=row["quality_source"],
            review_status=row["review_status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
