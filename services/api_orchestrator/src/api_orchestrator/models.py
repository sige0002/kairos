"""Pydantic models and shared enums for the api_orchestrator run lifecycle.

These mirror the schemas in ``docs/specs/ja/api_orchestrator.md`` and the
shared vocabulary in ``docs/specs/ja/config.md`` (run state enum, QoS, error
shape). They are the OpenAPI-visible request/response contracts for the public
``/api/v1`` run-lifecycle endpoints.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from kairos_common import Compression, Durability, JobState, Reliability
from pydantic import BaseModel, Field

# Console v2 Phase 2 controlled vocabularies (design doc
# console_v2_phase2_episode_model). Kept as Literal aliases so they are visible
# in the OpenAPI schema and validated at the request boundary.
TaskResult = Literal["success", "failure"]
Quality = Literal["good", "needs_review", "not_usable"]
QualitySource = Literal["operator", "quick_check", "validator"]
ReviewStatus = Literal["pending", "adopted", "excluded"]
BatchStatus = Literal["active", "completed", "ended_early"]


class RunState(StrEnum):
    """Run lifecycle state (shared vocabulary, config.md).

    Orchestrator owns this enum; recorder reports a compatible subset.
    """

    created = "created"
    recording = "recording"
    stopping = "stopping"
    completed = "completed"
    failed = "failed"
    interrupted = "interrupted"


class TopicQos(BaseModel):
    """Resolved per-topic QoS as recorded for a run."""

    reliability: Reliability
    durability: Durability
    depth: int = Field(ge=0)


class RunTopic(BaseModel):
    """A topic captured in a run, with its resolved type and QoS.

    Sourced from the recorder ``GET /record/metadata`` (the ``"all"`` selector
    is expanded there); the orchestrator only syncs it into the run row.
    """

    name: str
    type: str
    qos: TopicQos | None = None


class Split(BaseModel):
    """rosbag2 split configuration (size and/or duration)."""

    max_size_mb: int | None = None
    max_duration_s: int | None = None


class RunError(BaseModel):
    """Structured reason attached to a run (e.g. a failed start)."""

    code: str
    message: str


class RunEpisode(BaseModel):
    """Compact episode summary attached to a run (Console v2 Phase 2).

    Additively joined onto ``GET /api/v1/runs`` and ``GET /api/v1/runs/{id}`` so
    the Review tab shows the operator's task result + quality and the adopt /
    exclude state on any terminal, without an existing run field changing.
    ``null`` when the run has no episode.
    """

    episode_id: str
    batch_id: str
    # Per-(robot, local day) batch number of this episode's batch (Console v2
    # Phase 2). Surfaced on the join so Review/Datasets can label a row
    # "MM/DD · #N" without a second fetch. Null if the batch predates numbering.
    batch_seq: int | None = None
    index_in_batch: int
    task_result: TaskResult
    failure_reason: str | None = None
    quality: Quality
    review_status: ReviewStatus


# ---- stop-time quick-check settlement -----------------------------------
# A two-layer "quick check" settled once, at recording stop, and persisted on
# the run (see ``quick_check.py`` for the settlement logic + verdict rules).
# Layer 0 is a no-MCAP pull (monitor snapshot + incidents + recorder integrity);
# Layer 1 is an MCAP summary-only read (per-channel counts, no message scan).
# The whole object degrades honestly: each layer carries ``available`` flags so
# an unreachable monitor or an absent MCAP summary never fails the settlement —
# it just narrows what the verdict can vouch for. Frozen contract: the frontend
# codes against this exact shape.


class QuickCheckL0Topic(BaseModel):
    """Per-topic Layer 0 snapshot (live monitor metrics at stop)."""

    hz: float | None = None
    expected_hz: float | None = None
    rate_shortfall: float | None = None
    gap_max_ms: float | None = None
    # Whole-window DDS samples lost (stop minus the start baseline when one was
    # captured; else the monitor's cumulative value). None if unknown.
    dds_samples_lost: int | None = None


class QuickCheckLayer0(BaseModel):
    """Layer 0 — no MCAP read (~ms): monitor snapshot + incidents + integrity.

    ``available`` is the monitor-derived reachability (metrics/incidents). The
    recorder-sourced ``integrity`` is populated independently of it (the recorder
    is a separate service), so a monitor outage still leaves integrity intact.
    """

    available: bool = False
    integrity: str | None = None
    topics: dict[str, QuickCheckL0Topic] = Field(default_factory=dict)
    # Monitor ``/incidents`` items overlapping the recording window (raw pass-
    # through of the monitor's contract; see MonitorClient.incidents).
    incidents: list[dict[str, Any]] = Field(default_factory=list)
    # Additive: the recorder's auto-stop note when MAX_RECORD_SECONDS/BYTES
    # tripped the stop (else null). Informational — not a verdict trigger.
    backstop: str | None = None


class QuickCheckL1Topic(BaseModel):
    """Per-topic Layer 1 summary (from the MCAP statistics section)."""

    message_count: int
    avg_hz: float | None = None
    expected_hz: float | None = None


class QuickCheckLayer1(BaseModel):
    """Layer 1 — MCAP summary-only read (<1s): per-channel counts + duration.

    ``summary_available`` is False when the bag has no summary/statistics section
    (an unclean stop); we deliberately do NOT fall back to a full scan — instead
    the missing summary is treated as a strong ``needs_review`` signal.
    """

    available: bool = False
    summary_available: bool = False
    topics: dict[str, QuickCheckL1Topic] = Field(default_factory=dict)
    missing_topics: list[str] = Field(default_factory=list)
    empty_topics: list[str] = Field(default_factory=list)
    duration_s: float | None = None


class QuickCheckVerdict(BaseModel):
    """The settled quality call + every specific reason that triggered it.

    ``quality`` is ``good`` only when ``reasons`` is empty; any trigger flips it
    to ``needs_review`` and appends a human-readable, specific reason.
    """

    quality: Literal["good", "needs_review"] = "good"
    reasons: list[str] = Field(default_factory=list)


class QuickCheck(BaseModel):
    """The persisted stop-time quick-check settlement (frozen contract)."""

    computed_at: str
    elapsed_ms: int = 0
    layer0: QuickCheckLayer0 = Field(default_factory=QuickCheckLayer0)
    layer1: QuickCheckLayer1 = Field(default_factory=QuickCheckLayer1)
    verdict: QuickCheckVerdict = Field(default_factory=QuickCheckVerdict)


class Run(BaseModel):
    """A run as returned by ``GET /api/v1/runs/{id}`` and the record endpoints."""

    run_id: str
    state: RunState
    started_at: str | None = None
    ended_at: str | None = None
    topics: list[RunTopic] = Field(default_factory=list)
    compression: Compression = Compression.none
    split: Split | None = None
    message_count: int | None = None
    bytes: int | None = None
    error: RunError | None = None
    # Session metadata captured at record start (who recorded, what task).
    operator: str | None = None
    task: str | None = None
    # Console v2 Phase 2: the episode this run belongs to (null when none). Set
    # by the runs-list / run-detail read path; never persisted on the run row.
    episode: RunEpisode | None = None
    # Stop-time quick-check settlement, persisted on the run row (null until the
    # stop-path settlement completes, or for runs that predate the feature).
    quick_check: QuickCheck | None = None
    # Whether a FINALISED local copy of the recording exists on THIS host
    # (``recorded/<run_id>/metadata.yaml`` present in the FINAL path — the
    # importer stages pulls under .incoming/ and atomic-renames on completion,
    # so this doubles as the "fully imported" marker). False on a split
    # recording PC until the run is pulled from the robot; the Review transfer
    # UI keys on it. Derived at read time by the list/detail paths, never
    # persisted (null on write-path responses that don't compute it).
    bag_local: bool | None = None


class RecordStartRequest(BaseModel):
    """Body for ``POST /api/v1/record/start``.

    ``topics`` may be an explicit list or the literal ``"all"``; when omitted,
    the orchestrator falls back to ``recording.yaml`` ``default_topics``.
    """

    topics: list[str] | Literal["all"] | None = None
    compression: Compression = Compression.none
    split: Split | None = None
    qos_default: TopicQos | None = None
    qos_overrides: dict[str, TopicQos] | None = None
    # Optional session metadata, persisted on the run and written to the run's
    # session.json sidecar (who collected the data, and the task being recorded).
    operator: str | None = None
    task: str | None = None


class RecordPrepareResponse(BaseModel):
    """Response for ``POST /api/v1/record/prepare`` (two-phase start).

    No ``Run`` row exists yet at this point — prepare state lives only in
    memory on the orchestrator (``RunService._prepared``) until a matching
    ``POST /api/v1/record/start`` actually persists a row — so this is a
    distinct shape from :class:`Run`, not a partial/optional-field version of
    it. ``arming`` is a permissive pass-through of the recorder's readiness
    snapshot (matched/missing topics, etc.) rather than a tightly-coupled
    submodel, so a minor field-name difference on the recorder side does not
    hard-fail this response.
    """

    run_id: str
    state: Literal["armed"] = "armed"
    arming: dict[str, Any] = Field(default_factory=dict)
    disarm_at: str | None = None


class RunDetail(Run):
    """A single run plus on-disk audit/report sidecars (``GET /runs/{id}``).

    The base ``Run`` is the SQLite source of truth; these extra fields are read
    best-effort from disk when present (absent -> ``null``):
    - ``manifest``: the recorder's ``recorded/<run_id>/manifest.json`` audit.
    - ``validation``: the latest ``fast_validation`` report summary.
    - ``dataset_stats``: the latest ``dataset_export`` report summary.
    - ``loss``: the latest ``loss_report`` per-topic loss summary.
    """

    manifest: dict[str, Any] | None = None
    validation: dict[str, Any] | None = None
    dataset_stats: dict[str, Any] | None = None
    loss: dict[str, Any] | None = None


class RunListResponse(BaseModel):
    """Cursor-paginated run list (``GET /api/v1/runs``)."""

    items: list[Run]
    next_cursor: str | None = None


class RetentionCandidate(BaseModel):
    """One recording surfaced by ``GET /api/v1/retention`` as old-and-unexported.

    A *candidate*, never an action: the retention feature only SURFACES runs the
    operator may want to reclaim (terminal state, still in ``recorded/`` — i.e.
    not exported — and older than ``RETENTION_DAYS``). Nothing here is deleted
    automatically; the operator deletes through the existing confirmed
    ``DELETE /api/v1/runs/{id}`` path. Exported datasets are never candidates.
    """

    run_id: str
    started_at: str | None = None
    bytes: int | None = None
    state: RunState
    has_episode: bool = False


class RetentionResponse(BaseModel):
    """``GET /api/v1/retention`` — deletion candidates by retention period.

    ``days`` echoes the active ``RETENTION_DAYS`` (``0`` = feature off, always an
    empty candidate set). ``total_bytes`` sums the candidates' best-effort sizes
    so the UI can show how much storage reviewing them could reclaim.
    """

    days: int
    candidates: list[RetentionCandidate] = Field(default_factory=list)
    total_bytes: int = 0


class DatasetDetail(BaseModel):
    """One exported dataset dir + its on-disk sidecars.

    (``GET /api/v1/datasets/{operator}/{task}/{index}``) — the post-export
    counterpart of :class:`RunDetail`. The run row is deleted on export, so
    everything here is read best-effort from the dataset directory
    (``dataset.json`` / ``session.json`` / ``manifest.json``) plus the
    run-keyed report sidecars that survive export, letting the Datasets tab
    show the same inspection view as Recordings (absent -> ``null``).
    """

    operator: str
    task: str
    index: str
    # Relative "<operator>/<task>/<index>" under data_dir — pass this as the
    # `dataset_dir` job param for post-export video_check / loss_report.
    path: str
    dataset_dir: str
    run_id: str | None = None
    state: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    exported_at: str | None = None
    bytes: int | None = None
    message_count: int | None = None
    files: list[str] = Field(default_factory=list)
    # From manifest.json when present (name+type+QoS); else the name-only list
    # from session.json / dataset.json (type == "").
    topics: list[RunTopic] = Field(default_factory=list)
    manifest: dict[str, Any] | None = None
    dataset: dict[str, Any] | None = None
    # Episode labels persisted at export time (from episode.json): task_result /
    # failure_reason / quality / quality_source / review_status + batch context.
    # ``null`` when the exported run had no episode. Additive (Console v2 Phase 2).
    episode: dict[str, Any] | None = None
    validation: dict[str, Any] | None = None
    loss: dict[str, Any] | None = None


class PipelineDefinition(BaseModel):
    """Pipeline entry surfaced by dora_runner."""

    id: str
    name: str
    description: str | None = None
    enabled: bool = True
    schema_: dict[str, Any] = Field(default_factory=dict, alias="schema")


class JobCreateRequest(BaseModel):
    """Body for ``POST /api/v1/jobs``."""

    run_id: str
    pipeline: str
    params: dict[str, Any] = Field(default_factory=dict)


class JobCreateResponse(BaseModel):
    """Response returned after creating a pipeline job."""

    job_id: str
    run_id: str
    pipeline: str
    state: JobState
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    logs_tail: list[str] = Field(default_factory=list)


class JobStatus(BaseModel):
    """OpenAPI-visible job status contract."""

    job_id: str
    run_id: str
    pipeline: str
    state: JobState
    progress: float = Field(ge=0.0, le=1.0)
    logs_tail: list[str] = Field(default_factory=list)


class JobResult(BaseModel):
    """Terminal job result."""

    summary: dict[str, Any]
    artifacts: list[str] = Field(default_factory=list)


class RequiredTopicTemplate(BaseModel):
    """Required topic entry in a validation template."""

    name: str
    type: str | None = None


class ValidationTemplate(BaseModel):
    """Validation template schema from api_orchestrator.md."""

    name: str
    version: int
    required_topics: list[RequiredTopicTemplate] = Field(default_factory=list)


class ValidationTemplateListResponse(BaseModel):
    """Cursor-paginated validation template list."""

    items: list[ValidationTemplate]
    next_cursor: str | None = None


class TemplateGenerateRequest(BaseModel):
    """Body for ``POST /api/v1/validation/templates/generate``."""

    run_id: str


class ValidationPresetInfo(BaseModel):
    """A one-click validation preset plus its live not-yet-validated targets.

    (``GET /api/v1/validation/presets``) The static fields (``id`` / ``name`` /
    ``description`` / ``pipeline`` / ``params``) come from the active robot's
    ``validation_presets.yaml``; the dynamic ones are computed per request:
    ``total`` completed recordings eligible, of which ``pending`` (listed in
    ``pending_run_ids``) have no report for this preset's pipeline yet. The
    Validation tab runs the preset over ``pending_run_ids`` with a single click.
    """

    id: str
    name: str
    description: str = ""
    pipeline: str
    params: dict[str, Any] = Field(default_factory=dict)
    total: int
    pending: int
    pending_run_ids: list[str] = Field(default_factory=list)


class ValidationPresetListResponse(BaseModel):
    """List of one-click validation presets (``GET /api/v1/validation/presets``)."""

    items: list[ValidationPresetInfo] = Field(default_factory=list)


# ---- Console v2 Phase 2: batches & episodes -----------------------------


class Batch(BaseModel):
    """A Collect batch: the episodes recorded in one run of a task/condition.

    ``project`` is a plain string sourced from the Plan; modelling the Plan
    (Projects/Tasks/Conditions) itself is deferred to Phase 2.5. ``Session`` (the
    UX-spec Session > Batch > Episode outer level) is also Phase 2.5 TBD.
    """

    batch_id: str
    robot: str | None = None
    project: str
    task: str
    condition: str | None = None
    operator: str | None = None
    target_episodes: int = 30
    status: BatchStatus = "active"
    ended_reason: str | None = None
    created_at: str | None = None
    ended_at: str | None = None
    # Monotone count of episodes ever recorded into this batch (incremented on
    # POST /episodes, never decremented on a run-delete cascade) — the truthful
    # "N recorded" for Collect's counts, independent of the live episode_count
    # which shrinks when an episode is deleted.
    episodes_recorded: int = 0
    # Per-(robot, local day) batch number, allocated by the server at create
    # time (see store._next_batch_seq) — the single human-readable number across
    # Collect/Review/Datasets. Null only for a row predating numbering.
    batch_seq: int | None = None


class Episode(BaseModel):
    """One episode == one run (``run_id`` is unique across episodes)."""

    episode_id: str
    batch_id: str
    run_id: str
    index_in_batch: int
    task_result: TaskResult
    failure_reason: str | None = None
    quality: Quality
    quality_source: QualitySource = "operator"
    review_status: ReviewStatus = "pending"
    created_at: str | None = None
    updated_at: str | None = None


class BatchCreateRequest(BaseModel):
    """Body for ``POST /api/v1/batches``.

    ``robot`` defaults to the orchestrator's active robot when omitted.
    """

    robot: str | None = None
    project: str
    task: str
    condition: str | None = None
    operator: str | None = None
    target_episodes: int = Field(default=30, ge=1)


class BatchPatchRequest(BaseModel):
    """Body for ``PATCH /api/v1/batches/{id}`` (early stop / condition /
    mid-batch target change).

    ``project``/``task`` are patchable for the empty-batch case only: Collect
    updates a not-yet-recorded batch in place when the operator switches
    project/task before the first recording (a batch with recordings rolls over
    to a new one instead). Without these, such a batch kept its original
    project/task server-side and later episodes drifted from the operator's
    choice in ``index.jsonl``.
    """

    status: BatchStatus | None = None
    ended_reason: str | None = None
    project: str | None = None
    task: str | None = None
    condition: str | None = None
    target_episodes: int | None = Field(default=None, ge=1, le=500)


class EpisodeCreateRequest(BaseModel):
    """Body for ``POST /api/v1/episodes`` (Collect Save).

    ``quality`` is optional: when omitted the backend derives the default from
    the run's stop-time ``quick_check.verdict.quality`` (with
    ``quality_source="quick_check"``). Sending an explicit ``quality`` is the
    operator override and is stored as-is (``quality_source`` then defaults to
    ``operator``). See ``routers/episodes._resolve_episode_quality``.
    """

    batch_id: str
    run_id: str
    index_in_batch: int = Field(ge=0)
    task_result: TaskResult
    failure_reason: str | None = None
    quality: Quality | None = None
    quality_source: QualitySource = "operator"


class EpisodePatchRequest(BaseModel):
    """Body for ``PATCH /api/v1/episodes/{id}`` (Review adopt/exclude/override)."""

    task_result: TaskResult | None = None
    failure_reason: str | None = None
    quality: Quality | None = None
    quality_source: QualitySource | None = None
    review_status: ReviewStatus | None = None


class BatchEpisodeSummary(BaseModel):
    """Compact per-episode row in a batch list item."""

    index: int
    run_id: str
    # The parent batch's per-(robot, local day) number (same for every row in
    # the batch); carried here so a flattened episode list can label rows.
    batch_seq: int | None = None
    task_result: TaskResult
    quality: Quality
    review_status: ReviewStatus


class BatchSummary(Batch):
    """A batch plus its episode count and compact episode summaries.

    Returned by ``GET /api/v1/batches`` (list) so Collect can restore an active
    batch and show progress without a second round-trip per batch.
    """

    episode_count: int = 0
    episodes: list[BatchEpisodeSummary] = Field(default_factory=list)


class BatchDetail(Batch):
    """A batch plus its full episodes (``GET /api/v1/batches/{id}``)."""

    episode_count: int = 0
    episodes: list[Episode] = Field(default_factory=list)


class BatchListResponse(BaseModel):
    """Batch list newest-first (``GET /api/v1/batches``)."""

    items: list[BatchSummary] = Field(default_factory=list)
