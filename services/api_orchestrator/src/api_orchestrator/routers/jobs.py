# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Pipeline job endpoints (``/api/v1/jobs``).

Keyed by ``capture_id`` (§10.5): a job resolves its source as
``objects/<capture_id>`` — there is no ``dataset_dir`` parameter any more — and
writes to ``report/<pipeline>/<capture_id>/``.

**The capture lease lives here** (§7.1). dora_runner is deliberately
lease-ignorant: it reads a capture and writes a report, and knows nothing about
deletion. So the orchestrator — which owns both the catalog and the deletion
path — takes the lease on the job's behalf at submission, extends it whenever it
sees the job still running, and drops it as soon as it sees the job finish.
While any holder is live, discard and delete answer 409 ``capture_busy`` rather
than renaming ``objects/<id>`` out from under a running job.

**What the TTL actually guarantees** (rev.2.6). The lease is renewed on
observation, not on a timer, so the promise is bounded by when someone last
looked:

* from the last observation of a live job, the lease covers a full per-job
  budget plus a margin — so a job that is *executing* is protected, because the
  UI polls its status while it runs and each poll pushes the expiry out;
* it does **not** cover an unbounded queue wait. dora_runner bounds concurrency,
  so a submitted job can sit behind others; if nobody polls it during that wait,
  its lease expires and a delete may then win. The job later fails cleanly on a
  directory that moved to ``.trash`` — a late clean failure, not corruption,
  which is why this is accepted rather than papered over with a renewal loop the
  orchestrator would have to run for jobs it is not watching.

An expired hold is already not a hold (every read compares against *now*), so a
job whose process died never locks its capture out of deletion forever. That is
the property the whole design leans on, and the shared rewrite preserves it
holder by holder: each one expires on its own, and the capture becomes deletable
when the last of them does. Every failure here resolves toward "deletable
again", never toward "permanently stuck".

**The lease does not gate submission** (rev.2.15). It is shared, so several jobs
may hold one capture at once — that is what lets the N camera encoders of one
recording run in parallel, and it is why submitting a job no longer asks whether
somebody else holds it.
"""

from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, Request, status
from kairos_common import ApiError, JobState

from api_orchestrator.events import EVENT_JOB
from api_orchestrator.job_submission import prepare_job_submission
from api_orchestrator.models import (
    JobCreateRequest,
    JobCreateResponse,
    JobResult,
    JobStatus,
)

logger = logging.getLogger("kairos")

router = APIRouter(prefix="/api/v1/jobs", tags=["jobs"])

# The same knob dora_runner reads for its own per-job wall-clock budget. Both
# services load the root .env (compose `env_file`), so tuning it there moves the
# timeout and this lease TTL together — which is the point: a TTL derived from a
# different number than the timeout it is supposed to cover would drift silently.
_JOB_TIMEOUT_ENV = "KAIROS_DORA_JOB_TIMEOUT_S"
_DEFAULT_JOB_TIMEOUT_S = 900.0

# Added on top of the per-job timeout, and re-applied in full on every
# observation of a live job. It buys slack for the gap between two polls (a UI
# that is closed and reopened, a slow client) on top of the job's own budget.
#
# The margin errs long on purpose. Too short and a delete could rename
# ``objects/<id>`` out from under a job that is still reading it; too long and a
# capture stays undeletable for a while after a job died, with the UI naming the
# owner and the expiry. The second is the recoverable failure, and the one an
# operator can understand from the 409 alone.
_LEASE_MARGIN_S = 300.0

# States after which the job will not touch ``objects/<capture_id>`` again.
_TERMINAL_STATES = frozenset({JobState.succeeded, JobState.failed, JobState.canceled})


def _job_timeout_s() -> float:
    """dora_runner's per-job wall-clock budget (default 900s)."""
    try:
        return max(1.0, float(os.environ.get(_JOB_TIMEOUT_ENV, "")))
    except ValueError:
        return _DEFAULT_JOB_TIMEOUT_S


def _lease_ttl_s() -> float:
    return _job_timeout_s() + _LEASE_MARGIN_S


def _lease_owner(job_id: str) -> str:
    """The lease owner string for a job. Also what the 409 shows an operator."""
    return f"job:{job_id}"


def _sync_lease(request: Request, job: JobStatus) -> None:
    """Extend the job's lease while it runs; drop it once it cannot run again.

    Every endpoint that observes a job's state — status, result, cancel — calls
    this, because an observation is the only moment the orchestrator learns
    anything about a job: dora_runner does not call back. So the lease follows
    what was just seen.

    * **Terminal** — release. The job will not touch ``objects/<capture_id>``
      again, and holding the lease for the rest of the TTL would refuse deletes
      for no reason.
    * **Still running** — re-acquire with a full TTL. This is the renewal, and
      it is driven by polling rather than a background timer: the Validation UI
      polls a running job's status, so an executing job's lease keeps moving
      ahead of it without the orchestrator having to track jobs nobody is
      watching. A job that is queued and unobserved can therefore still lose its
      lease (see the module docstring) — an accepted, clean-failure case.

    Both operations are owner-scoped: ``release_lease`` only clears a lease this
    job still owns, and ``acquire_lease`` refuses to take one held by a
    different live owner. A stale poll for a finished job can neither drop nor
    steal the lease of whichever job holds the capture now.
    """
    store = request.app.state.capture_store
    owner = _lease_owner(job.job_id)
    if job.state in _TERMINAL_STATES:
        # Only a runner that explicitly confirmed its worker stopped may open
        # the delete gate. Older runners omit this additive field; their lease
        # expires on the already-bounded TTL rather than racing a surviving
        # timeout thread.
        if job.execution_active is False:
            store.release_lease(job.capture_id, owner)
        return
    store.acquire_lease(job.capture_id, owner, ttl_s=_lease_ttl_s())


async def _emit_job(request: Request, job: JobStatus | JobCreateResponse) -> None:
    await request.app.state.event_hub.publish(
        EVENT_JOB,
        {
            "job_id": job.job_id,
            "capture_id": job.capture_id,
            "pipeline": job.pipeline,
            "state": job.state.value,
            "progress": job.progress,
        },
    )


def _job_event_changed(
    previous: JobStatus | None, job: JobStatus | JobCreateResponse
) -> bool:
    """Whether *job* differs from *previous* in the fields an SSE ``job`` event carries.

    ``GET /{job_id}/status`` is polled, so it must not re-broadcast an identical
    event on every poll. The emitted payload only carries ``state``/``progress``
    (job_id/capture_id/pipeline are fixed per job), so those are the only fields
    that can change what a subscriber sees. A first sighting (``previous is None``)
    always counts as a change.
    """
    if previous is None:
        return True
    return (previous.state, previous.progress) != (job.state, job.progress)


@router.post("", response_model=JobCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_job(request: Request, body: JobCreateRequest) -> JobCreateResponse:
    """Create a dora_runner job and persist its initial status.

    For a template-driven job, resolve the ``template`` param into the FULL
    template object before forwarding. The UI sends a template *id* (file stem,
    e.g. ``airoa_hsr``), but dora_runner's template store starts empty, so a bare
    id always 404s — we look the id up in the Config catalog and inject the
    object. A missing/blank id falls back to the active selection; a param that
    is already a full object (dict) is passed through untouched.
    """
    client = request.app.state.dora_runner_client
    store = request.app.state.capture_store
    payload = prepare_job_submission(request, body)
    # Reader leases remain shared, so parallel jobs are allowed. The atomic
    # acquisition only refuses an exclusive archive/delete writer and happens
    # before remote create, closing the byte-move race without serializing jobs.
    provisional_owner = f"job-submit:{uuid.uuid4()}"
    if not store.acquire_lease(
        body.capture_id, provisional_owner, ttl_s=_lease_ttl_s()
    ):
        raise ApiError(
            status_code=409,
            code="capture_busy",
            message="The capture is being archived or deleted.",
            details={"capture_id": body.capture_id},
        )
    try:
        created = await client.create_job(payload)
    except ApiError as exc:
        if exc.status_code < 500:
            store.release_lease(body.capture_id, provisional_owner)
        raise
    except Exception:
        # The remote POST may have committed. Let this provisional protection
        # expire rather than opening a writer race around an unknown worker.
        raise
    job_id = str(created["job_id"])
    # The lease can only be taken once the job has an id, because the id is what
    # ties the lease to the work: the owner string is what a 409 shows an
    # operator, and what the release below matches on. dora_runner mints it, so
    # the acquire necessarily follows the create — and if the capture turns out
    # to be busy after all, the job we just created is cancelled rather than
    # left running against a capture someone else holds.
    # Shared, so this always succeeds; it records one more holder rather than
    # arbitrating. Still taken AFTER the create because the id is what ties the
    # hold to the work — it is what a 409 shows an operator and what the release
    # below matches on.
    store.acquire_lease(body.capture_id, _lease_owner(job_id), ttl_s=_lease_ttl_s())
    store.release_lease(body.capture_id, provisional_owner)
    try:
        status_body = await client.job_status(job_id)
        job = JobCreateResponse.model_validate(status_body)
        store.upsert_job(job)
    except Exception:
        # We hold the lease but have no row for the job and no id to hand back,
        # so nothing downstream will ever observe this job and nothing would
        # ever release the lease — it would sit there refusing deletes until the
        # TTL ran out. Undo both halves: drop the lease and call the job off.
        store.release_lease(body.capture_id, _lease_owner(job_id))
        await _abandon_job(client, job_id, body.capture_id)
        raise
    # A job that already finished (a fast failure) must not keep the lease it
    # was just handed — nothing else observes this one.
    _sync_lease(request, JobStatus.model_validate(status_body))
    await _emit_job(request, job)
    return job


async def _abandon_job(client, job_id: str, capture_id: str) -> None:
    """Call off a job the orchestrator has decided not to own.

    Best-effort by design: this runs while another error is already on its way
    to the caller, and a failed cancel must not replace it with a less useful
    one. The job it leaves behind is read-only — it produces a report nobody
    asked for — so the honest thing is to log it and let the original error
    stand.
    """
    try:
        await client.cancel_job(job_id)
    except Exception:  # noqa: BLE001 - the original error is the answer
        logger.warning(
            "could not cancel an abandoned job; it will run read-only and its "
            "report is harmless",
            extra={"job_id": job_id, "capture_id": capture_id},
        )


@router.get("/{job_id}/status", response_model=JobStatus)
async def job_status(request: Request, job_id: str) -> JobStatus:
    """Return current job status.

    Emits a ``job`` SSE event ONLY when the state/progress actually changed
    versus the stored row, so polling this endpoint does not flood subscribers
    with duplicate events. The upsert itself is idempotent and always runs.
    """
    body = await request.app.state.dora_runner_client.job_status(job_id)
    job = JobStatus.model_validate(body)
    store = request.app.state.capture_store
    previous = store.get_job(job_id)
    store.upsert_job(job)
    _sync_lease(request, job)
    if _job_event_changed(previous, job):
        await _emit_job(request, job)
    return job


def _data_relative_artifacts(artifacts: list[str], data_dir: str) -> list[str]:
    """Strip the data root from artifact paths so they are fetchable.

    ``GET /api/v1/files/{path}`` resolves its path INSIDE the data dir, so an
    artifact must be reported without that prefix — that is what lets the UI
    render a plugin's image artifacts inline with zero UI edits (the dora-only
    visualisation channel).

    dora_runner reports artifacts prefixed with its own ``data_dir``, which is
    ``./data`` by default and ``/data`` when a deployment sets an absolute one —
    so BOTH forms are stripped here (``data/report/x`` and ``/data/report/x``
    against a configured ``./data``). Matching only the absolute form left every
    artifact link 404ing on the default config. Paths under neither root pass
    through unchanged.
    """
    configured = PurePosixPath(data_dir)
    # Both spellings of the configured root: the services run with the image
    # root as cwd, so "./data" and "/data" name the same tree (compose mounts
    # ${DATA_DIR} at /data), and the two sides may report either one.
    twin = (
        PurePosixPath("/") / configured
        if not configured.is_absolute()
        else PurePosixPath(*configured.parts[1:])
    )
    roots = {configured, twin}
    out: list[str] = []
    for artifact in artifacts:
        path = PurePosixPath(artifact)
        for root in roots:
            try:
                out.append(str(path.relative_to(root)))
                break
            except ValueError:
                continue
        else:  # under no known root: leave it exactly as reported
            out.append(artifact)
    return out


def _available_report_artifacts(artifacts: list[str], data_dir: str) -> list[str]:
    """Drop cleaned report links while preserving non-report artifact semantics.

    Generated-report cleanup intentionally leaves volatile job history in place.
    A succeeded job therefore remains succeeded, but a report-relative link it
    used to expose must not remain a clickable guaranteed-404. Paths outside the
    managed ``report/`` namespace retain the existing pass-through behaviour.
    """
    root = Path(data_dir).resolve()
    available: list[str] = []
    for artifact in artifacts:
        path = PurePosixPath(artifact)
        if path.is_absolute() or not path.parts or path.parts[0] != "report":
            available.append(artifact)
            continue
        candidate = (root / Path(*path.parts)).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            continue
        if candidate.is_file():
            available.append(artifact)
    return available


@router.get("/{job_id}/result", response_model=JobResult)
async def job_result(request: Request, job_id: str) -> JobResult:
    """Return a terminal job result (artifacts normalised to data-relative)."""
    body = await request.app.state.dora_runner_client.job_result(job_id)
    result = JobResult.model_validate(body)
    result.artifacts = _data_relative_artifacts(
        result.artifacts, request.app.state.settings.data_dir
    )
    result.artifacts = _available_report_artifacts(
        result.artifacts, request.app.state.settings.data_dir
    )
    status_body = await request.app.state.dora_runner_client.job_status(job_id)
    job = JobStatus.model_validate(status_body)
    # Before the 409 below, so that reading the result of a job that turns out
    # to still be running counts as an observation and extends its lease.
    _sync_lease(request, job)
    if job.state not in _TERMINAL_STATES:
        raise ApiError(
            status_code=409,
            code="job_not_terminal",
            message=(
                "Job result is only available after the job reaches a terminal state."
            ),
        )
    request.app.state.capture_store.upsert_job(job, result=result)
    return result


@router.post("/{job_id}/cancel", response_model=JobStatus)
async def cancel_job(request: Request, job_id: str) -> JobStatus:
    """Cancel a running or queued job."""
    body = await request.app.state.dora_runner_client.cancel_job(job_id)
    job = JobStatus.model_validate(body)
    request.app.state.capture_store.upsert_job(job)
    _sync_lease(request, job)
    await _emit_job(request, job)
    return job
