# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""SQLite outbox for durable Validation Runs.

This is intentionally not part of ``kairos.db``. The capture catalog is rebuilt
from sidecars; a submitted validation intent is control-plane state and must
survive that rebuild so the supervisor can restore its capture leases.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import AbstractContextManager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from kairos_common import JobState, utc_now_iso8601
from kairos_common.sqlite_store import SqliteConnection, set_user_version, user_version

from api_orchestrator.models import JobResult, JobStatus
from api_orchestrator.validation_models import ValidationRun, ValidationRunJob

_SCHEMA_VERSION = 4
_ACTIVE_DISPATCH = ("pending_lease", "submitting", "accepted")
_TERMINAL_STATES = {JobState.succeeded, JobState.failed, JobState.canceled}


def _deadline(seconds: float = 1200.0) -> str:
    return (
        (datetime.now(UTC) + timedelta(seconds=seconds))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


_SCHEMA = """
CREATE TABLE IF NOT EXISTS validation_runs (
    run_id TEXT PRIMARY KEY,
    pipeline TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    request_id TEXT UNIQUE,
    selection_id TEXT,
    state TEXT NOT NULL,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE TABLE IF NOT EXISTS validation_run_jobs (
    run_job_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    capture_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    pipeline TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    attempt INTEGER NOT NULL,
    submission_key TEXT NOT NULL UNIQUE,
    submission_payload TEXT,
    job_id TEXT UNIQUE,
    dispatch_state TEXT NOT NULL,
    remote_state TEXT,
    progress REAL,
    logs_tail TEXT NOT NULL DEFAULT '[]',
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    execution_active INTEGER,
    legacy_release_at TEXT,
    last_observed_at TEXT,
    safety_deadline_at TEXT NOT NULL,
    lease_released INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    failure_code TEXT,
    failure_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, capture_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_validation_run_jobs_active
    ON validation_run_jobs(dispatch_state, remote_state);
CREATE INDEX IF NOT EXISTS idx_validation_run_jobs_run ON validation_run_jobs(run_id);
"""


class ValidationRunStore:
    """Owns durable run intent, while dora_runner owns worker execution."""

    def __init__(self, path: str | Path) -> None:
        self._db = SqliteConnection(
            path, connect_pragmas=("PRAGMA busy_timeout = 5000",)
        )
        with self._conn() as conn:
            version = user_version(conn)
            if not self._db.is_memory:
                conn.execute("PRAGMA journal_mode=WAL")
            if version not in (0, 1, 2, 3, _SCHEMA_VERSION):
                raise RuntimeError("validation run database schema is unsupported")
            conn.executescript(_SCHEMA)
            if version == 1:
                conn.execute("ALTER TABLE validation_runs ADD COLUMN request_id TEXT")
                conn.execute(
                    "CREATE UNIQUE INDEX idx_validation_runs_request_id "
                    "ON validation_runs(request_id) WHERE request_id IS NOT NULL"
                )
                conn.execute(
                    "ALTER TABLE validation_run_jobs ADD COLUMN last_observed_at TEXT"
                )
                conn.execute(
                    "ALTER TABLE validation_run_jobs ADD COLUMN safety_deadline_at TEXT"
                )
                conn.execute(
                    "UPDATE validation_run_jobs SET safety_deadline_at = updated_at "
                    "WHERE safety_deadline_at IS NULL"
                )
            if version in (1, 2):
                conn.execute("ALTER TABLE validation_runs ADD COLUMN selection_id TEXT")
            if version in (1, 2, 3):
                conn.execute(
                    "ALTER TABLE validation_run_jobs ADD COLUMN submission_payload TEXT"
                )
            set_user_version(conn, _SCHEMA_VERSION)

    def _conn(self) -> AbstractContextManager[sqlite3.Connection]:
        return self._db.connect()

    def close(self) -> None:
        self._db.close()

    def create_run(
        self,
        pipeline: str,
        capture_ids: list[str],
        params: dict[str, Any],
        request_id: str | None = None,
        selection_id: str | None = None,
    ) -> ValidationRun:
        now = utc_now_iso8601()
        run_id = f"validation_run_{uuid.uuid4().hex}"
        # Preserve target order but never create two workers for a duplicated id.
        unique_ids = list(dict.fromkeys(capture_ids))
        with self._conn() as conn:
            # The request-id lookup and reservation must be one SQLite critical
            # section: a browser retry racing the original response cannot mint
            # two runs with the same intent.
            conn.execute("BEGIN IMMEDIATE")
            if request_id is not None:
                prior = conn.execute(
                    "SELECT run_id, pipeline, params, selection_id "
                    "FROM validation_runs "
                    "WHERE request_id = ?",
                    (request_id,),
                ).fetchone()
                if prior is not None:
                    prior_ids = [
                        row["capture_id"]
                        for row in conn.execute(
                            "SELECT capture_id FROM validation_run_jobs "
                            "WHERE run_id = ? AND attempt = 1 ORDER BY ordinal",
                            (prior["run_id"],),
                        )
                    ]
                    if (
                        prior["pipeline"] == pipeline
                        and json.loads(prior["params"]) == params
                        and prior_ids == unique_ids
                        and prior["selection_id"] == selection_id
                    ):
                        return self.get_run_or_raise(prior["run_id"])
                    raise ValueError("validation_run_idempotency_conflict")
            conn.execute(
                "INSERT INTO validation_runs "
                "(run_id, pipeline, params, request_id, selection_id, state, "
                "cancel_requested, "
                "created_at, updated_at, completed_at) "
                "VALUES (?, ?, ?, ?, ?, 'creating', 0, ?, ?, NULL)",
                (
                    run_id,
                    pipeline,
                    json.dumps(params),
                    request_id,
                    selection_id,
                    now,
                    now,
                ),
            )
            for ordinal, capture_id in enumerate(unique_ids):
                run_job_id = f"validation_run_job_{uuid.uuid4().hex}"
                conn.execute(
                    """INSERT INTO validation_run_jobs
                    (run_job_id, run_id, capture_id, ordinal, pipeline, params, attempt,
                     submission_key, dispatch_state, safety_deadline_at, created_at,
                     updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'pending_lease', ?, ?, ?)""",
                    (
                        run_job_id,
                        run_id,
                        capture_id,
                        ordinal,
                        pipeline,
                        json.dumps(params),
                        f"{run_id}:{capture_id}:1",
                        _deadline(),
                        now,
                        now,
                    ),
                )
        return self.get_run_or_raise(run_id)

    def list_runs(self, *, active: bool, limit: int = 20) -> list[ValidationRun]:
        where = "WHERE state != 'finished'" if active else ""
        with self._conn() as conn:
            rows = conn.execute(
                (
                    f"SELECT run_id FROM validation_runs {where} "
                    "ORDER BY created_at DESC LIMIT ?"
                ),
                (limit,),
            ).fetchall()
        return [self.get_run_or_raise(row["run_id"]) for row in rows]

    def get_run(self, run_id: str) -> ValidationRun | None:
        with self._conn() as conn:
            run = conn.execute(
                "SELECT * FROM validation_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
            if run is None:
                return None
            children = conn.execute(
                "SELECT * FROM validation_run_jobs WHERE run_id = ? "
                "ORDER BY ordinal, attempt",
                (run_id,),
            ).fetchall()
        return self._run_from_rows(run, children)

    def get_run_or_raise(self, run_id: str) -> ValidationRun:
        run = self.get_run(run_id)
        if run is None:
            raise KeyError(run_id)
        return run

    def recover_selection_request(
        self,
        request_id: str,
        pipeline: str,
        params: dict[str, Any],
        selection_id: str,
    ) -> ValidationRun | None:
        """Return a prior selection intent before an expired snapshot is resolved."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT run_id, pipeline, params, selection_id FROM validation_runs "
                "WHERE request_id = ?",
                (request_id,),
            ).fetchone()
        if row is None:
            return None
        if (
            row["pipeline"] != pipeline
            or json.loads(row["params"]) != params
            or row["selection_id"] != selection_id
        ):
            raise ValueError("validation_run_idempotency_conflict")
        return self.get_run_or_raise(row["run_id"])

    def active_jobs(self) -> list[sqlite3.Row]:
        return self.active_jobs_for_run()

    def active_jobs_for_run(self, run_id: str | None = None) -> list[sqlite3.Row]:
        with self._conn() as conn:
            run_filter = "" if run_id is None else "AND j.run_id = ?"
            params = () if run_id is None else (run_id,)
            return conn.execute(
                f"""SELECT j.*, r.cancel_requested AS run_cancel_requested
                FROM validation_run_jobs j JOIN validation_runs r USING (run_id)
                WHERE j.dispatch_state IN ('pending_lease', 'submitting', 'accepted')
                  AND (j.remote_state IS NULL
                       OR j.remote_state NOT IN ('succeeded', 'failed', 'canceled')
                       OR j.execution_active = 1
                       OR (j.execution_active IS NULL AND j.lease_released = 0)
                       OR (j.remote_state IN ('succeeded', 'failed')
                           AND j.result IS NULL AND j.failure_code IS NULL))
                  {run_filter}
                ORDER BY j.created_at""",
                params,
            ).fetchall()

    def mark_submitting(self, run_job_id: str) -> None:
        self._update_child(run_job_id, dispatch_state="submitting")

    def freeze_submission_payload(
        self, run_job_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Persist the exact remote POST body once for response-loss retries."""
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        with self._conn() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT submission_payload FROM validation_run_jobs "
                "WHERE run_job_id = ?",
                (run_job_id,),
            ).fetchone()
            if row is None:
                raise KeyError(run_job_id)
            if row["submission_payload"] is None:
                conn.execute(
                    "UPDATE validation_run_jobs SET submission_payload = ?, "
                    "updated_at = ? WHERE run_job_id = ?",
                    (encoded, utc_now_iso8601(), run_job_id),
                )
                return payload
            value = json.loads(row["submission_payload"])
            if not isinstance(value, dict):
                raise ValueError("stored submission payload is not an object")
            return value

    def mark_submission_failed(self, run_job_id: str, code: str, message: str) -> None:
        self._update_child(
            run_job_id,
            dispatch_state="submission_failed",
            failure_code=code,
            failure_message=message,
        )

    def mark_canceled_before_submit(self, run_job_id: str) -> None:
        self._update_child(
            run_job_id,
            dispatch_state="canceled_before_submit",
            remote_state=JobState.canceled.value,
            progress=1.0,
        )

    def record_remote_status(
        self, run_job_id: str, status: JobStatus, result: JobResult | None = None
    ) -> None:
        fields: dict[str, Any] = {
            "job_id": status.job_id,
            "dispatch_state": "accepted",
            "remote_state": status.state.value,
            "progress": status.progress,
            "logs_tail": json.dumps(status.logs_tail),
            "cancel_requested": int(status.cancel_requested),
            "execution_active": (
                int(status.execution_active)
                if status.execution_active is not None
                else None
            ),
        }
        if result is not None:
            fields["result"] = json.dumps(result.model_dump())
        self._update_child(run_job_id, **fields)

    def mark_accepted_job(self, run_job_id: str, job_id: str) -> None:
        """Durably bind the remote id before any follow-up status request."""
        self._update_child(
            run_job_id,
            job_id=job_id,
            dispatch_state="accepted",
        )

    def set_legacy_release_at(self, run_job_id: str, deadline: str) -> None:
        self._update_child(run_job_id, legacy_release_at=deadline)

    def mark_legacy_lease_released(self, run_job_id: str) -> None:
        self._update_child(run_job_id, lease_released=1)

    def mark_live_observed(self, run_job_id: str, *, ttl_s: float) -> None:
        now = utc_now_iso8601()
        self._update_child(
            run_job_id,
            last_observed_at=now,
            safety_deadline_at=_deadline(ttl_s),
        )

    def mark_unreachable(self, run_job_id: str, code: str) -> None:
        self._update_child(
            run_job_id,
            dispatch_state="submission_failed",
            remote_state=JobState.failed.value,
            failure_code=code,
            failure_message=(
                "The runner could not be reached before the safety lease expired."
            ),
        )

    def mark_result_unavailable(self, run_job_id: str) -> None:
        """Settle a terminal child whose result stayed unreadable to deadline."""
        self._update_child(
            run_job_id,
            failure_code="result_unavailable_timeout",
            failure_message=(
                "The job reached a terminal state, but its result could not be "
                "retrieved before the supervision deadline."
            ),
        )

    def safety_deadline_at(self, run_job_id: str) -> str | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT safety_deadline_at FROM validation_run_jobs "
                "WHERE run_job_id = ?",
                (run_job_id,),
            ).fetchone()
        return None if row is None else row["safety_deadline_at"]

    def legacy_release_at(self, run_job_id: str) -> str | None:
        with self._conn() as conn:
            row = conn.execute(
                (
                    "SELECT legacy_release_at FROM validation_run_jobs "
                    "WHERE run_job_id = ?"
                ),
                (run_job_id,),
            ).fetchone()
        return None if row is None else row["legacy_release_at"]

    def request_cancel(self, run_id: str) -> ValidationRun:
        now = utc_now_iso8601()
        with self._conn() as conn:
            row = conn.execute(
                "SELECT state FROM validation_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
            if row is None:
                raise KeyError(run_id)
            if row["state"] == "finished":
                return self.get_run_or_raise(run_id)
            conn.execute(
                "UPDATE validation_runs SET cancel_requested = 1, "
                "state = 'cancel_requested', "
                "updated_at = ? WHERE run_id = ?",
                (now, run_id),
            )
        return self.get_run_or_raise(run_id)

    def retry_failed(self, run_id: str) -> ValidationRun:
        now = utc_now_iso8601()
        with self._conn() as conn:
            run = conn.execute(
                "SELECT * FROM validation_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
            if run is None:
                raise KeyError(run_id)
            if run["state"] != "finished":
                raise ValueError("validation_run_not_retryable")
            all_rows = conn.execute(
                "SELECT * FROM validation_run_jobs WHERE run_id = ? "
                "ORDER BY capture_id, attempt DESC",
                (run_id,),
            ).fetchall()
            latest: dict[str, sqlite3.Row] = {}
            for row in all_rows:
                latest.setdefault(row["capture_id"], row)
            rows = [
                row
                for row in latest.values()
                if (
                    row["dispatch_state"] == "submission_failed"
                    or row["remote_state"]
                    in (JobState.failed.value, JobState.canceled.value)
                    or row["failure_code"] is not None
                )
                and row["execution_active"] != 1
                and not (row["execution_active"] is None and not row["lease_released"])
            ]
            for row in rows:
                attempt = int(row["attempt"]) + 1
                run_job_id = f"validation_run_job_{uuid.uuid4().hex}"
                conn.execute(
                    """INSERT INTO validation_run_jobs
                    (run_job_id, run_id, capture_id, ordinal, pipeline, params, attempt,
                     submission_key, dispatch_state, safety_deadline_at, created_at,
                     updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_lease', ?, ?, ?)""",
                    (
                        run_job_id,
                        run_id,
                        row["capture_id"],
                        row["ordinal"],
                        row["pipeline"],
                        row["params"],
                        attempt,
                        f"{run_id}:{row['capture_id']}:{attempt}",
                        _deadline(),
                        now,
                        now,
                    ),
                )
            if rows:
                conn.execute(
                    "UPDATE validation_runs SET state = 'creating', "
                    "cancel_requested = 0, "
                    "completed_at = NULL, updated_at = ? WHERE run_id = ?",
                    (now, run_id),
                )
        return self.get_run_or_raise(run_id)

    def _update_child(self, run_job_id: str, **fields: Any) -> None:
        now = utc_now_iso8601()
        fields["updated_at"] = now
        assignments = ", ".join(f"{name} = ?" for name in fields)
        with self._conn() as conn:
            row = conn.execute(
                "SELECT run_id FROM validation_run_jobs WHERE run_job_id = ?",
                (run_job_id,),
            ).fetchone()
            if row is None:
                raise KeyError(run_job_id)
            conn.execute(
                f"UPDATE validation_run_jobs SET {assignments} WHERE run_job_id = ?",
                (*fields.values(), run_job_id),
            )
            self._refresh_run_state(conn, row["run_id"], now)

    @staticmethod
    def _refresh_run_state(conn: sqlite3.Connection, run_id: str, now: str) -> None:
        run = conn.execute(
            "SELECT cancel_requested FROM validation_runs WHERE run_id = ?", (run_id,)
        ).fetchone()
        all_rows = conn.execute(
            "SELECT capture_id, dispatch_state, remote_state, result, failure_code, "
            "execution_active, lease_released FROM validation_run_jobs "
            "WHERE run_id = ? ORDER BY capture_id, attempt DESC",
            (run_id,),
        ).fetchall()
        rows: list[sqlite3.Row] = []
        seen: set[str] = set()
        for row in all_rows:
            # History is intentionally retained but cannot keep a newer retry
            # from settling its run.
            capture_id = row["capture_id"]
            if capture_id not in seen:
                rows.append(row)
                seen.add(capture_id)
        unfinished = any(
            row["dispatch_state"] in _ACTIVE_DISPATCH
            and (
                row["remote_state"] is None
                or row["remote_state"]
                not in {state.value for state in _TERMINAL_STATES}
                or row["execution_active"] == 1
                or (row["execution_active"] is None and not row["lease_released"])
                or (
                    row["remote_state"]
                    in (JobState.succeeded.value, JobState.failed.value)
                    and row["result"] is None
                    and row["failure_code"] is None
                )
            )
            for row in rows
        )
        if not unfinished:
            state, completed_at = "finished", now
        elif run["cancel_requested"]:
            state, completed_at = "cancel_requested", None
        elif any(
            row["dispatch_state"] in ("pending_lease", "submitting") for row in rows
        ):
            state, completed_at = "creating", None
        else:
            state, completed_at = "running", None
        conn.execute(
            "UPDATE validation_runs SET state = ?, completed_at = ?, "
            "updated_at = ? WHERE run_id = ?",
            (state, completed_at, now, run_id),
        )

    @staticmethod
    def _run_from_rows(run: sqlite3.Row, children: list[sqlite3.Row]) -> ValidationRun:
        jobs: list[ValidationRunJob] = []
        for row in children:
            job = None
            if row["job_id"] is not None and row["remote_state"] is not None:
                job = JobStatus(
                    job_id=row["job_id"],
                    capture_id=row["capture_id"],
                    pipeline=row["pipeline"],
                    state=JobState(row["remote_state"]),
                    progress=float(row["progress"] or 0),
                    logs_tail=json.loads(row["logs_tail"] or "[]"),
                    cancel_requested=bool(row["cancel_requested"]),
                    execution_active=(
                        bool(row["execution_active"])
                        if row["execution_active"] is not None
                        else None
                    ),
                )
            result = (
                JobResult.model_validate(json.loads(row["result"]))
                if row["result"]
                else None
            )
            jobs.append(
                ValidationRunJob(
                    run_job_id=row["run_job_id"],
                    capture_id=row["capture_id"],
                    attempt=int(row["attempt"]),
                    dispatch_state=row["dispatch_state"],
                    job=job,
                    failure_code=row["failure_code"],
                    failure_message=row["failure_message"],
                    result=result,
                )
            )
        return ValidationRun(
            run_id=run["run_id"],
            pipeline=run["pipeline"],
            params=json.loads(run["params"]),
            selection_id=run["selection_id"],
            state=run["state"],
            cancel_requested=bool(run["cancel_requested"]),
            created_at=run["created_at"],
            updated_at=run["updated_at"],
            completed_at=run["completed_at"],
            jobs=jobs,
        )
