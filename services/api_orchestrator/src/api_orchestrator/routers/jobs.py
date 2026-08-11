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
from pathlib import PurePosixPath

from fastapi import APIRouter, Request, status
from kairos_common import ApiError, JobState

from api_orchestrator.events import EVENT_JOB
from api_orchestrator.models import (
    UNFINALIZED_STATES,
    Capture,
    CaptureState,
    JobCreateRequest,
    JobCreateResponse,
    JobResult,
    JobStatus,
)
from api_orchestrator.store import PRESENT_REPLICA_STATES

logger = logging.getLogger("kairos")

router = APIRouter(prefix="/api/v1/jobs", tags=["jobs"])

# Capture states for which an export must be refused: the bag is still being
# written, so exporting it would read a recording mid-flight.
_UNFINISHED_STATES = UNFINALIZED_STATES

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
        store.release_lease(job.capture_id, owner)
        return
    store.acquire_lease(job.capture_id, owner, ttl_s=_lease_ttl_s())


# Pipelines whose `template` param is a Config-catalog template id: the id is
# resolved to the full object before forwarding (dora_runner's template store is
# empty at boot). fast_validation matches the template's topics directly;
# full_validation hands them to its flow as ${KAIROS_REQUIRED_TOPICS}, so the
# Config tab's active template drives both.
_TEMPLATE_PIPELINES = {"fast_validation", "full_validation"}


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
    payload = body.model_dump()
    capture = store.get_capture(body.capture_id)
    if capture is None:
        raise ApiError(
            status_code=404,
            code="capture_not_found",
            message=f"Capture not found: {body.capture_id}",
            details={"capture_id": body.capture_id},
        )
    if str(capture.state) in _UNFINISHED_STATES:
        raise ApiError(
            status_code=409,
            code="capture_not_finished",
            message="Cannot run a job on a capture that is still recording.",
            details={"capture_id": body.capture_id, "state": str(capture.state)},
        )
    _reject_tombstoned(capture)
    _reject_not_local(request, capture)
    # No lease gate here any more. §7.1's lease became SHARED precisely so that
    # several jobs can work on one capture at once — the N camera encoders of a
    # single recording are the case it exists for — and a pre-flight "somebody
    # else holds this" would refuse exactly the submissions the change is meant
    # to allow. What the lease still protects is unchanged and lives on the
    # delete path: discard and delete refuse while any holder remains.
    if body.pipeline in _TEMPLATE_PIPELINES:
        raw = body.params.get("template")
        if not isinstance(raw, dict):
            catalog = request.app.state.config_catalog
            template = None
            if isinstance(raw, str) and raw:
                template = catalog.validation_template_by_id(raw)
            if template is None:  # blank id, or id not in the catalog
                template = catalog.active_validation_template()
            if template is not None:
                payload["params"] = {**body.params, "template": template.model_dump()}
    created = await client.create_job(payload)
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


def _reject_not_local(request: Request, capture: Capture) -> None:
    """Refuse a job whose bytes the CATALOG says are not on this installation.

    Complements ``_reject_tombstoned`` without crossing its line: that guard
    deliberately refuses to stat the filesystem on every submission, and this
    one still doesn't — it reads the replica row (§8), which is a durable
    catalog claim, not a race. A capture that is still on the robot awaiting
    transfer, or whose local copy was archived away or observed missing, used
    to be accepted here and die minutes later inside dora_runner with a bare
    "no capture found" (timing sweep S1-5 note: nothing server-side checked
    replica presence before submission). Refusing up front names the actual
    condition the operator can act on: pull it, restore it, or stop expecting
    a job to run against bytes this machine does not have.

    No replica row at all is treated as present: rebuild only writes rows for
    what it can see, and an old catalog that predates replicas must not lock
    every capture out of validation.
    """
    store = request.app.state.capture_store
    replica = store.get_replica(capture.capture_id, request.app.state.instance_id)
    if replica is None or str(replica.state) in PRESENT_REPLICA_STATES:
        return
    raise ApiError(
        status_code=409,
        code="capture_not_local",
        message=(
            f"{capture.capture_id} has no local copy on this installation "
            f"(replica state: {replica.state}); transfer or restore it before "
            "running a job."
        ),
        details={
            "capture_id": capture.capture_id,
            "replica_state": str(replica.state),
        },
    )


def _reject_tombstoned(capture: Capture) -> None:
    """Refuse a job on a capture that is being, or has been, deleted (§7).

    ``delete_pending`` is included for the same reason review saves include it
    (``captures._reject_review_on_delete``): it is the window between the ledger
    append and the rename, and a job admitted inside it would read a capture
    whose bytes are already on their way to ``.trash`` — and write a report for
    it, leaving ``report/<pipeline>/<capture_id>/`` behind for a recording that
    no longer exists. The operator's delete already won.

    A capture whose bytes were removed *outside* kairos (``rm -rf``) is
    deliberately NOT covered here: its row still says ``completed``, which is an
    honest claim that the bytes should be there, and the job fails late with a
    clear "No capture found". Guessing at the filesystem on every submission
    would trade that clarity for a check that races anyway.
    """
    if capture.state not in (
        CaptureState.delete_pending,
        CaptureState.discarded,
        CaptureState.deleted,
    ):
        return
    pending = capture.state == CaptureState.delete_pending
    kind = capture.delete_kind or ("delete" if pending else "deleted")
    raise ApiError(
        status_code=409,
        code="capture_deleting" if pending else "capture_deleted",
        message=(
            f"{capture.capture_id} is being {kind}d; no new job can be run against it."
            if pending
            else (
                f"{capture.capture_id} was {kind}"
                f"{f' on {capture.deleted_at}' if capture.deleted_at else ''}; "
                "no job can be run against it."
            )
        ),
        details={"capture_id": capture.capture_id, "state": str(capture.state)},
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


@router.get("/{job_id}/result", response_model=JobResult)
async def job_result(request: Request, job_id: str) -> JobResult:
    """Return a terminal job result (artifacts normalised to data-relative)."""
    body = await request.app.state.dora_runner_client.job_result(job_id)
    result = JobResult.model_validate(body)
    result.artifacts = _data_relative_artifacts(
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
