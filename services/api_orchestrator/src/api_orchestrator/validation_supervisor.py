# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Server-owned supervision for durable validation runs.

The browser is a viewer, never the thing keeping a capture safe from deletion.
This loop dispatches intent, reconciles it after an orchestrator restart, and
renews each child lease until dora_runner explicitly says its worker stopped.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from kairos_common import ApiError, JobState

from api_orchestrator.dora_runner_client import DoraRunnerClient
from api_orchestrator.job_submission import prepare_job_submission_for
from api_orchestrator.models import JobCreateRequest, JobResult, JobStatus
from api_orchestrator.store import CaptureStore
from api_orchestrator.validation_run_store import ValidationRunStore

logger = logging.getLogger("kairos")

_POLL_S = 3.0
_SYNC_CONCURRENCY = 16
_DEFAULT_TIMEOUT_S = 900.0
_LEASE_MARGIN_S = 300.0


def _lease_ttl_s() -> float:
    try:
        return (
            max(1.0, float(os.environ.get("KAIROS_DORA_JOB_TIMEOUT_S", "")))
            + _LEASE_MARGIN_S
        )
    except ValueError:
        return _DEFAULT_TIMEOUT_S + _LEASE_MARGIN_S


def _owner(run_job_id: str) -> str:
    return f"validation-run:{run_job_id}"


class ValidationRunSupervisor:
    def __init__(
        self,
        store: ValidationRunStore,
        capture_store: CaptureStore,
        client: DoraRunnerClient,
        data_dir: Path,
        *,
        instance_id: str,
        config_catalog,
    ) -> None:
        self._store = store
        self._capture_store = capture_store
        self._client = client
        self._data_dir = data_dir
        self._instance_id = instance_id
        self._config_catalog = config_catalog
        self._task: asyncio.Task[None] | None = None
        self._stopping = False

    async def start(self) -> None:
        """Restore local safety holds, then reconcile remotely in the background."""
        self._stopping = False
        # This is deliberately local-only. A runner with 1,000 old jobs must
        # not make the API unavailable while its network endpoint is slow or
        # down; the durable rows are enough to restore delete protection first.
        self.acquire_local_leases()
        self._task = asyncio.create_task(self._loop())

    def acquire_local_leases(self, run_id: str | None = None) -> None:
        """Restore only durable, still-safe holds without contacting dora_runner."""
        for row in self._store.active_jobs_for_run(run_id):
            if row["execution_active"] == 1:
                self._capture_store.acquire_lease(
                    row["capture_id"],
                    _owner(row["run_job_id"]),
                    ttl_s=_lease_ttl_s(),
                )
            elif not _deadline_expired(row["safety_deadline_at"]):
                self._capture_store.acquire_lease(
                    row["capture_id"],
                    _owner(row["run_job_id"]),
                    ttl_s=_remaining_seconds(row["safety_deadline_at"]),
                )

    async def stop(self) -> None:
        self._stopping = True
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass

    async def _loop(self) -> None:
        while not self._stopping:
            await asyncio.sleep(_POLL_S)
            try:
                await self.tick()
            except Exception:  # noqa: BLE001 - next pass is the recovery path
                logger.exception("validation run supervisor pass failed")

    async def tick(self) -> None:
        slots = asyncio.Semaphore(_SYNC_CONCURRENCY)

        async def reconcile(row: Any) -> None:
            async with slots:
                try:
                    await self._sync(row)
                except Exception:  # noqa: BLE001 - one job must not starve siblings
                    logger.exception(
                        "validation run child supervision failed",
                        extra={"run_job_id": row["run_job_id"]},
                    )

        await asyncio.gather(*(reconcile(row) for row in self._store.active_jobs()))

    async def _sync(self, row: Any) -> None:
        run_job_id = row["run_job_id"]
        owner = _owner(run_job_id)
        dispatch = row["dispatch_state"]
        if dispatch in ("pending_lease", "submitting"):
            if _deadline_expired(row["safety_deadline_at"]):
                self._capture_store.release_lease(row["capture_id"], owner)
                self._store.mark_unreachable(run_job_id, "submission_unknown_timeout")
                return
            if row["run_cancel_requested"]:
                self._capture_store.release_lease(row["capture_id"], owner)
                self._store.mark_canceled_before_submit(run_job_id)
                return
            try:
                if row["submission_payload"]:
                    payload = json.loads(row["submission_payload"])
                else:
                    body = JobCreateRequest(
                        capture_id=row["capture_id"],
                        pipeline=row["pipeline"],
                        params=json.loads(row["params"]),
                        idempotency_key=row["submission_key"],
                    )
                    resolved = prepare_job_submission_for(
                        self._capture_store,
                        self._instance_id,
                        self._config_catalog,
                        body,
                    )
                    payload = self._store.freeze_submission_payload(
                        run_job_id, resolved
                    )
            except ApiError as exc:
                self._capture_store.release_lease(row["capture_id"], owner)
                self._store.mark_submission_failed(run_job_id, exc.code, exc.message)
                return
            # This provisional owner is known before the remote create. It
            # closes the response-loss window; the idempotency key closes its
            # retry without starting a duplicate dora worker.
            if not self._capture_store.acquire_lease(
                row["capture_id"], owner, ttl_s=_lease_ttl_s()
            ):
                # An archive/delete writer won the atomic lease arbitration.
                # Leave the durable child pending; a later tick can submit it
                # after the writer releases without ever racing the bytes.
                return
            self._store.mark_submitting(run_job_id)
            try:
                created = await self._client.create_job(payload)
            except ApiError as exc:
                if exc.status_code >= 500:
                    # BaseServiceClient maps a downstream 5xx and exhausted
                    # transport retries to 503.  The remote POST may already
                    # have committed before its response was lost, so this is
                    # an unknown outcome rather than a definite refusal. Keep
                    # the provisional lease and retry the same idempotency key
                    # until the durable safety deadline resolves the ambiguity.
                    return
                self._capture_store.release_lease(row["capture_id"], owner)
                self._store.mark_submission_failed(run_job_id, exc.code, exc.message)
                return
            except Exception:
                # Unknown remote outcome: retain the provisional lease and
                # retry the same idempotency key on the next pass.
                return
            # The remote worker may already be running. Bind its id BEFORE a
            # second call can fail, otherwise a lost status response would turn
            # a real worker into an unleased, falsely failed submission.
            job_id = str(created["job_id"])
            self._store.mark_accepted_job(run_job_id, job_id)
            try:
                job = JobStatus.model_validate(await self._client.job_status(job_id))
            except Exception:
                return
            await self._record_status(run_job_id, owner, job)
            return

        job_id = row["job_id"]
        if job_id is None:
            return
        if row["run_cancel_requested"] and not bool(row["cancel_requested"]):
            try:
                await self._client.cancel_job(job_id)
            except Exception:  # retry next pass; desired cancellation is durable
                logger.warning(
                    "validation job cancel request failed", extra={"job_id": job_id}
                )
        try:
            job = JobStatus.model_validate(await self._client.job_status(job_id))
        except Exception:
            if _deadline_expired(row["safety_deadline_at"]):
                if bool(row["execution_active"]):
                    # Positive evidence that the worker still owns the bytes
                    # outranks an unreachable control plane. Keep protecting
                    # the capture and retry until dora explicitly reports
                    # execution_active=false (including after its restart
                    # reconciliation).
                    self._capture_store.acquire_lease(
                        row["capture_id"], owner, ttl_s=_lease_ttl_s()
                    )
                elif (
                    row["remote_state"] in {state.value for state in _terminal_states()}
                    and row["result"] is None
                ):
                    self._store.mark_result_unavailable(run_job_id)
                else:
                    self._capture_store.release_lease(row["capture_id"], owner)
                    self._store.mark_unreachable(run_job_id, "runner_unreachable")
            return
        await self._record_status(run_job_id, owner, job)

    async def _record_status(self, run_job_id: str, owner: str, job: JobStatus) -> None:
        result: JobResult | None = None
        result_unavailable = False
        if job.state in _terminal_states():
            try:
                result = JobResult.model_validate(
                    await self._client.job_result(job.job_id)
                )
            except Exception:
                # Canceled jobs may have no result; status is still durable.
                result_unavailable = job.state is not JobState.canceled
        self._store.record_remote_status(run_job_id, job, result)
        self._capture_store.upsert_job(job, result=result)
        if job.execution_active is True:
            # A timeout/failure label can precede the actual worker exit. Keep
            # both the durable deadline and local lease fresh while dora says
            # the process may still touch capture bytes.
            self._store.mark_live_observed(run_job_id, ttl_s=_lease_ttl_s())
            self._capture_store.acquire_lease(
                job.capture_id, owner, ttl_s=_lease_ttl_s()
            )
        elif job.state in _terminal_states() and job.execution_active is False:
            self._capture_store.release_lease(job.capture_id, owner)
        elif job.state in _terminal_states() and job.execution_active is None:
            # A rolling-upgrade runner did not tell us whether work survived
            # its terminal label. Do not turn that omission into an immediate
            # delete race; retain exactly one normal safety window, then make
            # the expiry/release explicit and let the run settle.
            deadline = self._store.legacy_release_at(run_job_id)
            now = datetime.now(UTC)
            if deadline is None:
                self._store.set_legacy_release_at(
                    run_job_id,
                    (now + timedelta(seconds=_lease_ttl_s()))
                    .isoformat(timespec="milliseconds")
                    .replace("+00:00", "Z"),
                )
            elif now >= datetime.fromisoformat(deadline.replace("Z", "+00:00")):
                self._capture_store.release_lease(job.capture_id, owner)
                self._store.mark_legacy_lease_released(run_job_id)
        elif job.state not in _terminal_states():
            self._store.mark_live_observed(run_job_id, ttl_s=_lease_ttl_s())
            self._capture_store.acquire_lease(
                job.capture_id, owner, ttl_s=_lease_ttl_s()
            )
        if result_unavailable and _deadline_expired(
            self._store.safety_deadline_at(run_job_id)
        ):
            self._store.mark_result_unavailable(run_job_id)


def _terminal_states() -> set[JobState]:
    return {JobState.succeeded, JobState.failed, JobState.canceled}


def _deadline_expired(deadline: str | None) -> bool:
    return deadline is None or datetime.now(UTC) >= datetime.fromisoformat(
        deadline.replace("Z", "+00:00")
    )


def _remaining_seconds(deadline: str | None) -> float:
    if deadline is None:
        return 1.0
    seconds = (
        datetime.fromisoformat(deadline.replace("Z", "+00:00")) - datetime.now(UTC)
    ).total_seconds()
    return max(1.0, seconds)
