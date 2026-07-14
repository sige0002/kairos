"""Batch & episode endpoints (Console v2 Phase 2).

Persists the Collect batch progression (project/task/condition/target) and each
episode's task result + quality call, plus Review's adopt/exclude, in the
orchestrator's SQLite. This replaces the browser-local ``episodeBridge`` so
Review shows real data on any terminal. The recording path (record/start ->
stop -> MCAP) is untouched: an episode only references a run.

Two routers share this module — one under ``/api/v1/batches`` and one under
``/api/v1/episodes`` — both mounted by the app factory. Logic lives in the
handlers over ``app.state.run_store`` (the ``jobs`` router pattern); the store
is the single source of truth.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from fastapi import APIRouter, Query, Request, status
from kairos_common import ApiError, utc_now_iso8601

from api_orchestrator.models import (
    Batch,
    BatchCreateRequest,
    BatchDetail,
    BatchEpisodeSummary,
    BatchListResponse,
    BatchPatchRequest,
    BatchSummary,
    Episode,
    EpisodeCreateRequest,
    EpisodePatchRequest,
    Quality,
    QualitySource,
    Run,
)
from api_orchestrator.store import (
    BatchExistsError,
    EpisodeRunExistsError,
    RunStore,
)

batches_router = APIRouter(prefix="/api/v1/batches", tags=["batches"])
episodes_router = APIRouter(prefix="/api/v1/episodes", tags=["episodes"])

# Batch statuses whose entry stamps ``ended_at`` (a batch is done once).
_TERMINAL_BATCH_STATUSES = {"completed", "ended_early"}

# Bound on suffix-retries when an allocated batch_id collides (same-second
# starts). One retry practically always suffices, mirroring run allocation.
_MAX_BATCH_ID_ATTEMPTS = 50


def _store(request: Request) -> RunStore:
    return request.app.state.run_store


def _allocate_batch_id(now: datetime | None = None) -> str:
    """Allocate a ``batch_YYYYMMDD_HHMMSS`` id (same shape as run ids)."""
    moment = now or datetime.now(UTC)
    return moment.strftime("batch_%Y%m%d_%H%M%S")


def _default_robot(request: Request, robot: str | None) -> str | None:
    """Fall back to the orchestrator's active robot when the client omits it."""
    if robot is not None:
        return robot
    catalog = getattr(request.app.state, "config_catalog", None)
    return catalog.active_robot() if catalog is not None else None


def _batch_summary(store: RunStore, batch: Batch) -> BatchSummary:
    """Attach a batch's episode count + compact per-episode summaries."""
    episodes = store.list_episodes_by_batch(batch.batch_id)
    return BatchSummary(
        **batch.model_dump(),
        episode_count=len(episodes),
        episodes=[
            BatchEpisodeSummary(
                index=ep.index_in_batch,
                run_id=ep.run_id,
                batch_seq=batch.batch_seq,
                task_result=ep.task_result,
                quality=ep.quality,
                review_status=ep.review_status,
            )
            for ep in episodes
        ],
    )


# ---- batches --------------------------------------------------------------


@batches_router.post("", response_model=Batch, status_code=status.HTTP_201_CREATED)
async def create_batch(request: Request, body: BatchCreateRequest) -> Batch:
    """Start a batch (Collect). ``robot`` defaults to the active robot."""
    store = _store(request)
    robot = _default_robot(request, body.robot)
    now = utc_now_iso8601()
    base = _allocate_batch_id()
    for attempt in range(_MAX_BATCH_ID_ATTEMPTS):
        batch = Batch(
            batch_id=base if attempt == 0 else f"{base}_{attempt}",
            robot=robot,
            project=body.project,
            task=body.task,
            condition=body.condition,
            operator=body.operator,
            target_episodes=body.target_episodes,
            status="active",
            created_at=now,
        )
        try:
            return store.create_batch(batch)
        except BatchExistsError:
            continue
    raise ApiError(
        status_code=409,
        code="batch_id_unavailable",
        message="Could not allocate a unique batch_id; retry shortly.",
    )


@batches_router.patch("/{batch_id}", response_model=Batch)
async def patch_batch(
    request: Request, batch_id: str, body: BatchPatchRequest
) -> Batch:
    """Update a batch: early stop (``status``/``ended_reason``) or condition
    change. Entering a terminal status stamps ``ended_at`` once."""
    store = _store(request)
    batch = store.get_batch(batch_id)
    if batch is None:
        raise _batch_not_found(batch_id)
    fields: dict[str, object] = {}
    if body.status is not None:
        fields["status"] = body.status
    if body.ended_reason is not None:
        fields["ended_reason"] = body.ended_reason
    if body.condition is not None:
        fields["condition"] = body.condition
    if body.target_episodes is not None:
        fields["target_episodes"] = body.target_episodes
    # Stamp ended_at when a batch first reaches a terminal status.
    if body.status in _TERMINAL_BATCH_STATUSES and batch.ended_at is None:
        fields["ended_at"] = utc_now_iso8601()
    try:
        return store.update_batch(batch_id, **fields)
    except KeyError as exc:  # deleted between the read and the write
        raise _batch_not_found(batch_id) from exc


@batches_router.get("", response_model=BatchListResponse)
async def list_batches(
    request: Request,
    status: str | None = Query(None),
    robot: str | None = Query(None),
    operator: str | None = Query(None),
) -> BatchListResponse:
    """List batches newest-first, each with its episode count + compact episode
    summaries. Optional filters: ``status``, ``robot``, ``operator`` — Collect
    scopes its active-batch restore with these so one terminal never silently
    adopts (and appends episodes to) another robot's/operator's batch."""
    store = _store(request)
    return BatchListResponse(
        items=[
            _batch_summary(store, b)
            for b in store.list_batches(status, robot=robot, operator=operator)
        ]
    )


@batches_router.get("/{batch_id}", response_model=BatchDetail)
async def get_batch(request: Request, batch_id: str) -> BatchDetail:
    """Return a batch plus its full episodes (404 if absent)."""
    store = _store(request)
    batch = store.get_batch(batch_id)
    if batch is None:
        raise _batch_not_found(batch_id)
    episodes = store.list_episodes_by_batch(batch_id)
    return BatchDetail(
        **batch.model_dump(), episode_count=len(episodes), episodes=episodes
    )


# ---- episodes -------------------------------------------------------------


@episodes_router.post("", response_model=Episode, status_code=status.HTTP_201_CREATED)
async def create_episode(request: Request, body: EpisodeCreateRequest) -> Episode:
    """Persist an episode on Collect Save.

    404 if the batch or run is unknown; 409 if the run already has an episode
    (``episodes.run_id`` is unique — one episode per run).
    """
    store = _store(request)
    if store.get_batch(body.batch_id) is None:
        raise _batch_not_found(body.batch_id)
    run = store.get(body.run_id)
    if run is None:
        raise ApiError(
            status_code=404,
            code="run_not_found",
            message=f"Run not found: {body.run_id}",
            details={"run_id": body.run_id},
        )
    if store.get_episode_by_run_id(body.run_id) is not None:
        raise _episode_exists(body.run_id)
    quality, quality_source = _resolve_episode_quality(body, run)
    now = utc_now_iso8601()
    episode = Episode(
        episode_id=f"ep_{uuid4().hex}",
        batch_id=body.batch_id,
        run_id=body.run_id,
        index_in_batch=body.index_in_batch,
        task_result=body.task_result,
        failure_reason=body.failure_reason,
        quality=quality,
        quality_source=quality_source,
        review_status="pending",
        created_at=now,
        updated_at=now,
    )
    try:
        return store.create_episode(episode)
    except EpisodeRunExistsError as exc:  # concurrent create for the same run
        raise _episode_exists(body.run_id) from exc


@episodes_router.patch("/{episode_id}", response_model=Episode)
async def patch_episode(
    request: Request, episode_id: str, body: EpisodePatchRequest
) -> Episode:
    """Update an episode: Review adopt/exclude, or override quality/result."""
    store = _store(request)
    if store.get_episode(episode_id) is None:
        raise _episode_not_found(episode_id)
    fields: dict[str, object] = {
        name: value
        for name, value in (
            ("task_result", body.task_result),
            ("failure_reason", body.failure_reason),
            ("quality", body.quality),
            ("quality_source", body.quality_source),
            ("review_status", body.review_status),
        )
        if value is not None
    }
    fields["updated_at"] = utc_now_iso8601()
    try:
        return store.update_episode(episode_id, **fields)
    except KeyError as exc:  # deleted between the read and the write
        raise _episode_not_found(episode_id) from exc


# ---- quality derivation (D-2 seam) ----------------------------------------

# Conservative default when an episode is saved with no explicit quality AND the
# run carries no settled quick_check (e.g. an old run, or settlement that never
# finished): we cannot vouch for the data, so mark it for review rather than
# silently passing it as good.
_UNSETTLED_QUALITY_DEFAULT: Quality = "needs_review"


def _resolve_episode_quality(
    body: EpisodeCreateRequest, run: Run
) -> tuple[Quality, QualitySource]:
    """Resolve an episode's saved quality + its source (extends the D-2 seam).

    - An explicit ``quality`` in the request is the operator's call and is stored
      as-is with the request's ``quality_source`` (defaults to ``operator``).
    - When ``quality`` is omitted, the default derives from the run's stop-time
      ``quick_check.verdict.quality`` with ``quality_source="quick_check"`` — so
      the orchestrator's settled verdict is the single source of the auto value,
      not re-derived per client.
    - With no quick_check to derive from, fall back to a conservative
      ``needs_review`` (still ``quick_check`` source: an absent settlement is
      itself the signal).
    """
    if body.quality is not None:
        return body.quality, body.quality_source
    if run.quick_check is not None:
        return run.quick_check.verdict.quality, "quick_check"
    return _UNSETTLED_QUALITY_DEFAULT, "quick_check"


# ---- error helpers --------------------------------------------------------


def _batch_not_found(batch_id: str) -> ApiError:
    return ApiError(
        status_code=404,
        code="batch_not_found",
        message=f"Batch not found: {batch_id}",
        details={"batch_id": batch_id},
    )


def _episode_not_found(episode_id: str) -> ApiError:
    return ApiError(
        status_code=404,
        code="episode_not_found",
        message=f"Episode not found: {episode_id}",
        details={"episode_id": episode_id},
    )


def _episode_exists(run_id: str) -> ApiError:
    return ApiError(
        status_code=409,
        code="episode_exists",
        message=f"Run already has an episode: {run_id}",
        details={"run_id": run_id},
    )
