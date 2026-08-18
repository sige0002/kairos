# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Pydantic models and shared enums for the api_orchestrator capture store v2.

These are the OpenAPI-visible request/response contracts for ``/api/v1``. The
capture-store vocabulary itself (:class:`CaptureState`, :class:`ReplicaState`,
:class:`DigestState`) is **imported** from ``kairos_common`` rather than
restated here: the recorder writes those strings into ``object_manifest.json``
and the rebuild scanner reads them back, so a second definition in this service
would be a second thing to keep in sync with the sidecars on disk.

The v1 ``runs``/``episodes`` split is gone (contract §8). One capture carries
both the recording facts and the operator's review, so what used to be a ``Run``
joined to an ``Episode`` is now a single :class:`Capture`.
"""

from __future__ import annotations

from typing import Any, Literal

from kairos_common import Compression, Durability, JobState, Reliability
from kairos_common.capture_sidecars import (
    TERMINAL_STATES,
    UNFINALIZED_STATES,
    CaptureState,
    DigestState,
)

# Re-exported, not redefined: dora_runner exchanges these exact models with this
# service, so they live in kairos_common.contracts and both sides import one
# definition. Every existing ``from api_orchestrator.models import JobStatus``
# keeps working. ``JobCreateResponse`` stays local — see the contracts docstring.
from kairos_common.contracts.jobs import (
    JobCreateRequest,
    JobResult,
    JobStatus,
    RequiredTopicTemplate,
    TemplateGenerateRequest,
    ValidationTemplate,
    ValidationTemplateListResponse,
)
from kairos_common.rebuild import ReplicaState
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

__all__ = [
    "TERMINAL_STATES",
    "ArchivedFile",
    "UNFINALIZED_STATES",
    "Batch",
    "BatchCoverageResponse",
    "BatchCoverageScope",
    "BatchCreateRequest",
    "BatchDetail",
    "BatchListResponse",
    "BatchPatchRequest",
    "BatchStatus",
    "BatchSummary",
    "Capture",
    "CoverageRow",
    "CaptureDeleteRequest",
    "CaptureDetail",
    "CaptureError",
    "CaptureListResponse",
    "CollectionContextSnapshot",
    "CaptureState",
    "CaptureTopic",
    "DeleteKind",
    "DigestState",
    "JobCreateRequest",
    "JobCreateResponse",
    "JobResult",
    "JobStatus",
    "Quality",
    "QualitySource",
    "QuickCheck",
    "QuickCheckL0Topic",
    "QuickCheckL1Topic",
    "QuickCheckLayer0",
    "QuickCheckLayer1",
    "QuickCheckVerdict",
    "RecordPrepareResponse",
    "RecordStartRequest",
    "Replica",
    "ReplicaState",
    "RequiredTopicTemplate",
    "RetentionCandidate",
    "RetentionResponse",
    "ReviewSaveRequest",
    "ReviewStatus",
    "Split",
    "TaskResult",
    "TemplateGenerateRequest",
    "TopicQos",
    "ValidationPresetInfo",
    "ValidationPresetListResponse",
    "ValidationTemplate",
    "ValidationTemplateListResponse",
]

# Controlled vocabularies, kept as ``Literal`` aliases so they are visible in the
# OpenAPI schema and validated at the request boundary.
TaskResult = Literal["success", "failure"]
Quality = Literal["good", "needs_review", "not_usable"]
QualitySource = Literal["operator", "quick_check", "validator"]
ReviewStatus = Literal["pending", "adopted", "excluded"]
BatchStatus = Literal["active", "completed", "ended_early"]
# §7: one endpoint, two intents. ``discard`` is "this was never uploaded and is
# not worth keeping"; ``delete`` is an ordinary removal. They take the same code
# path and differ only in the ledger kind and what the UI is required to say
# about reversibility (§12), which is why they are one field and not two routes.
DeleteKind = Literal["discard", "delete"]


class TopicQos(BaseModel):
    """Resolved per-topic QoS as recorded for a capture."""

    reliability: Reliability
    durability: Durability
    depth: int = Field(ge=0)


class CaptureTopic(BaseModel):
    """A topic captured in a recording, with its resolved type and QoS."""

    name: str
    # A failed start's sidecar (§3.4) records topics BEFORE type discovery
    # finished, as an explicit null. That is data the rebuild must accept:
    # one such row must never make the whole catalog unreadable (E2E §13-4
    # found exactly that as a permanent GET /captures 500).
    type: str = ""
    qos: TopicQos | None = None

    @field_validator("type", mode="before")
    @classmethod
    def _null_type_is_undiscovered(cls, v: object) -> object:
        return "" if v is None else v


class Split(BaseModel):
    """rosbag2 split configuration (size and/or duration)."""

    max_size_mb: int | None = None
    max_duration_s: int | None = None


class CaptureError(BaseModel):
    """Structured reason attached to a capture (e.g. a failed start).

    The recorder writes ``object_manifest.json``'s ``error`` as a plain string
    (§3), so :func:`coerce_error` widens that into this shape rather than the
    manifest and the API disagreeing about the field's type.
    """

    code: str
    message: str


# The recorder's marker for "this recording ended because it reached a cap I
# was configured with" (MAX_RECORD_SECONDS / MAX_RECORD_BYTES). It rides in the
# manifest's ``error`` field only because that is the one free-text field a
# manifest has — the recorder's own code says "no error occurred" and sets the
# state to ``completed``. This is the one message shape whose code IS knowable.
AUTO_STOP_PREFIX = "auto-stopped:"


def coerce_error(value: Any) -> CaptureError | None:
    """Normalize a manifest/rebuild ``error`` into a :class:`CaptureError`.

    Accepts ``None``, the recorder's plain string, or an already-structured
    mapping. A bare string becomes ``recorder_failed`` — the specific code is
    unknowable from a free-text message, and inventing a more precise one would
    make the code field a guess.

    The single exception is the auto-stop note, which the recorder writes with a
    fixed prefix precisely so it can be told apart. Filing it as
    ``recorder_failed`` was the guess: it puts a completed take that stopped
    exactly where it was told under the code that means the recorder faulted,
    with nothing on the wire to separate it from a kill. It keeps its message —
    the note names the cap, which is the only place that survives — but under a
    code that says what happened.
    """
    if value is None or value == "":
        return None
    if isinstance(value, CaptureError):
        return value
    if isinstance(value, str):
        if value.startswith(AUTO_STOP_PREFIX):
            return CaptureError(code="auto_stopped", message=value)
        return CaptureError(code="recorder_failed", message=value)
    if isinstance(value, dict) and value.get("code"):
        return CaptureError(
            code=str(value["code"]), message=str(value.get("message", ""))
        )
    return None


# ---- stop-time quick-check settlement -------------------------------------
# A two-layer "quick check" settled once, at recording stop, and persisted on
# the capture (see ``quick_check.py`` for the settlement logic + verdict rules).
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
    """Layer 0 — no MCAP read (~ms): monitor snapshot + incidents + integrity."""

    available: bool = False
    integrity: str | None = None
    topics: dict[str, QuickCheckL0Topic] = Field(default_factory=dict)
    incidents: list[dict[str, Any]] = Field(default_factory=list)
    # The recorder's auto-stop note when MAX_RECORD_SECONDS/BYTES tripped the
    # stop (else null). Informational — not a verdict trigger.
    backstop: str | None = None


class QuickCheckL1Topic(BaseModel):
    """Per-topic Layer 1 summary (from the MCAP statistics section)."""

    message_count: int
    avg_hz: float | None = None
    expected_hz: float | None = None


class QuickCheckLayer1(BaseModel):
    """Layer 1 — MCAP summary-only read (<1s): per-channel counts + duration."""

    available: bool = False
    summary_available: bool = False
    topics: dict[str, QuickCheckL1Topic] = Field(default_factory=dict)
    missing_topics: list[str] = Field(default_factory=list)
    empty_topics: list[str] = Field(default_factory=list)
    duration_s: float | None = None


class QuickCheckVerdict(BaseModel):
    """The settled quality call + every specific reason that triggered it."""

    quality: Literal["good", "needs_review"] = "good"
    reasons: list[str] = Field(default_factory=list)


class QuickCheck(BaseModel):
    """The persisted stop-time quick-check settlement (frozen contract)."""

    computed_at: str
    elapsed_ms: int = 0
    layer0: QuickCheckLayer0 = Field(default_factory=QuickCheckLayer0)
    layer1: QuickCheckLayer1 = Field(default_factory=QuickCheckLayer1)
    verdict: QuickCheckVerdict = Field(default_factory=QuickCheckVerdict)


# ---- captures --------------------------------------------------------------


class CollectionContextSnapshot(BaseModel):
    """The batch identity and labels frozen when a recording starts.

    This API wrapper mirrors the shared sidecar model. Keeping it on each
    capture makes a later review prove that the requested batch association is
    the one the recorder started under rather than a mutable UI selection.
    """

    model_config = ConfigDict(extra="allow")

    batch_id: str | None = None
    batch_seq: int | None = None
    project_id: str | None = None
    task_id: str | None = None
    condition_id: str | None = None
    project: str | None = None
    task: str | None = None
    condition: str | None = None
    robot: str | None = None
    operator: str | None = None


class Replica(BaseModel):
    """Where one installation's copy of a capture stands (§8).

    ``missing_unmanaged`` is the interesting value: it is what an external
    ``rm -rf`` produces, and §9-2 requires it to surface as a warning rather
    than be normalised into a completed deletion.
    """

    instance_id: str
    state: ReplicaState
    path: str | None = None
    manifest_digest: str | None = None
    verified_at: str | None = None
    updated_at: str | None = None


class DatasetMembership(BaseModel):
    """A capture's membership in one dataset, as shown on the capture."""

    membership_id: str
    dataset_id: str
    dataset_name: str | None = None
    display_index: int


class CaptureListItem(BaseModel):
    """One recording as the LIST serves it — everything except its topics.

    Replaces v1's ``Run`` + ``Episode`` pair. The review fields here are a
    **cache** of ``record.json``, which is authoritative (§4.1-4);
    ``review_revision`` is the CAS token a client must echo back as
    ``base_revision`` to save an edit.

    The split exists because ``topics`` is per-recording data no list view
    renders, and it dominates the page: at 100 topics a row is ~11.4 KiB of
    which ~91% is the topic array, so a 200-row page measured 2.3 MiB against
    ~208 KiB without it (E-27). Modelled as a base class rather than an
    exclusion so the schema says it outright — a reader of the OpenAPI
    document should not have to know which route filters what.

    ``topics_count`` is what the list keeps of that array: the one thing a row
    actually shows about topics is how many there were, and a client that had
    to fetch each capture's detail to render a number would spend a request per
    row to undo the saving above.
    """

    capture_id: str
    run_id: str | None = None
    source_instance_id: str | None = None
    state: CaptureState
    operator: str | None = None
    task: str | None = None
    robot: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    compression: Compression = Compression.none
    split: Split | None = None
    error: CaptureError | None = None
    message_count: int | None = None
    bytes: int | None = None
    quick_check: QuickCheck | None = None
    # ---- review (record.json is authoritative; these mirror it) ----
    task_result: TaskResult | None = None
    failure_reason: str | None = None
    quality: Quality | None = None
    quality_source: QualitySource | None = None
    review_status: ReviewStatus = "pending"
    # 0 = never reviewed (no record.json exists). Echoed back as base_revision.
    review_revision: int = 0
    # Set only when a human let a NEEDS_REVIEW verdict through (the reason
    # they gave). The verdict itself is derived from the reports on disk —
    # see api_orchestrator.verdict — and is served on the detail, not here.
    validation_override: str | None = None
    batch_id: str | None = None
    index_in_batch: int | None = None
    collection_context: CollectionContextSnapshot | None = None
    # ---- tombstone (§7); the row survives the deletion ----
    deleted_at: str | None = None
    delete_kind: DeleteKind | None = None
    delete_reason: str | None = None
    # ---- archive (§6): the bytes left deliberately, to a place we recorded ----
    archived_at: str | None = None
    archive_destination: str | None = None
    # ---- lease (§7.1): a job is touching objects/<id> right now ----
    lease_owner: str | None = None
    lease_expires_at: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    # ---- derived at read time, never stored on the row ----
    # This installation's copy. ``null`` only for a capture we have never held.
    replica: Replica | None = None
    # ``complete`` once the digest job has sealed per-file hashes into the
    # manifest. Derived from the replica state so "verified" is one fact, not
    # two columns that can disagree (§9-4).
    digest_state: DigestState = DigestState.pending
    # How many topics the recording captured. The list carries the NUMBER; the
    # topics themselves are on the detail (see this class's docstring). Always
    # equals ``len(topics)`` there — :class:`Capture` derives it rather than
    # letting a caller supply one that could disagree.
    topics_count: int = 0
    memberships: list[DatasetMembership] = Field(default_factory=list)


class Capture(CaptureListItem):
    """A recording with its topics — every single-capture response (§8).

    ``topics`` lives here rather than on the list item; see
    :class:`CaptureListItem` for why. Everything that serves ONE capture —
    the detail, a review save, a record start/stop — returns this, so the one
    screen that reads topics (Review's inspection panel, which fetches the
    detail) is unaffected by the list not carrying them.
    """

    topics: list[CaptureTopic] = Field(default_factory=list)

    @model_validator(mode="after")
    def _count_topics(self) -> Capture:
        """Derive ``topics_count`` from the topics actually carried.

        Computed here rather than stored as a column or passed in by each
        caller, because those are the two ways the number could come to
        disagree with the array beside it — and a count that disagrees is
        worse than no count, since nothing downstream can tell which is
        right. Every capture is built through this model, so the list's
        number is always the length of the detail's array by construction.
        """
        self.topics_count = len(self.topics)
        return self


class CaptureDetail(Capture):
    """A capture plus the on-disk sidecars and reports (``GET /captures/{id}``).

    The database row stays the queryable cache; these are read best-effort from
    disk and are ``null`` when absent, so a capture whose files were deleted
    still returns cleanly.

    There is deliberately no ``dataset_stats``: it pointed at the
    ``dataset_export`` pipeline, which §6 retired along with the physical
    dataset tree, so the field could only ever be ``null``. A field that is
    structurally incapable of holding a value is worse than a missing one — it
    invites a client to keep checking it.
    """

    manifest: dict[str, Any] | None = None
    record: dict[str, Any] | None = None
    validation: dict[str, Any] | None = None
    # Derived verdict (`unknown` | `pass` | `needs_review`) folded from the
    # gating pipelines' reports — recomputed on every read so a re-run cannot
    # leave a stale copy behind.
    verdict: str | None = None
    loss: dict[str, Any] | None = None


class CaptureListResponse(BaseModel):
    """Cursor-paginated capture list (``GET /api/v1/captures``)."""

    items: list[CaptureListItem]
    next_cursor: str | None = None


class ReviewSaveRequest(BaseModel):
    """Body for ``PATCH /api/v1/captures/{id}/review`` (§4.1).

    ``base_revision`` is REQUIRED and is the whole point: the save is a
    compare-and-swap against the capture's current ``review_revision``, so two
    terminals editing the same capture cannot silently overwrite each other. A
    mismatch is a ``409`` telling the client to reload, never a merge.

    Every other field is optional and omitted-means-unchanged, except that a
    field explicitly set to ``null`` clears it — which is why the model tracks
    ``model_fields_set`` rather than treating ``None`` as "not supplied".
    """

    base_revision: int = Field(ge=0)
    task_result: TaskResult | None = None
    # Bounded like a validation override's reason, and for the same reason: it
    # is free text that ends up in record.json, on the Review row and in every
    # delete dialog that names the episode. The values Collect sends come from
    # the plan catalog's short vocabulary, so this bounds a paste rather than
    # any real reason. Only the REQUEST is capped — ``RecordV2`` is not, so a
    # longer value written before this rule still loads and rebuilds.
    failure_reason: str | None = Field(default=None, max_length=500)
    quality: Quality | None = None
    quality_source: QualitySource | None = None
    review_status: ReviewStatus | None = None
    batch_id: str | None = None
    index_in_batch: int | None = Field(default=None, ge=0)
    # §4.3 label overrides. These three differ from every other field here: they
    # have a value even on a capture nobody has reviewed, because the manifest
    # supplied one. So ``null`` does not mean "empty" — it means "stop
    # overriding", and the capture goes back to what the recorder recorded. On
    # an imported bag, where the manifest recorded nothing, that is null again.
    operator: str | None = None
    task: str | None = None
    robot: str | None = None


class ValidationOverrideRequest(BaseModel):
    """Body for ``POST /api/v1/captures/{id}/validation-override``.

    ``reason`` is REQUIRED: overriding a failed validation is exactly the act
    that needs an explanation on the record — without one this is just a way to
    turn the gate off quietly. ``null`` clears a previous override.
    """

    reason: str | None = Field(default=None, max_length=500)


class CaptureDeleteRequest(BaseModel):
    """Body for ``POST /api/v1/captures/{id}/delete`` (§7).

    ``reason`` is required for a discard and free text otherwise: a discard is
    irreversible and the ledger line is the only surviving explanation of why
    the data is gone.
    """

    kind: DeleteKind
    reason: str | None = Field(default=None, max_length=500)


class CaptureArchiveRequest(BaseModel):
    """Body for ``POST /api/v1/captures/{id}/archive`` (§6).

    ``destination`` is an absolute path inside one of ``KAIROS_ARCHIVE_ROOTS``
    and is validated server-side — archiving copies, verifies, then DELETES the
    source, so an unconstrained destination would turn this into "copy anywhere,
    then remove the original".
    """

    destination: str
    operator: str | None = None
    reason: str | None = Field(default=None, max_length=500)


class ArchivedFile(BaseModel):
    """One file as written to the archive destination.

    Same ``{path, size, sha256}`` shape as ``object_manifest.json``'s file list
    (§3.2), so an archived capture and a local one describe their bytes in one
    vocabulary.
    """

    path: str
    size: int
    sha256: str


class CaptureArchiveResponse(BaseModel):
    """Result of a completed capture archive.

    ``files`` carries the per-file hashes rather than a count because the
    source is deleted moments after this is computed: these digests and the
    matching ``capture_archived`` ledger event are the only things left that
    can answer "is the archived copy still intact?".
    """

    capture_id: str
    destination: str
    bytes: int
    file_count: int
    files: list[ArchivedFile] = Field(default_factory=list)
    # There is deliberately no `verified` flag: verification is not optional on
    # this path (every file's hash is compared as it lands, and a mismatch
    # fails the archive before anything is deleted), so a completed response
    # IS the verification claim. The old always-True field only fed a UI
    # warning branch that could never fire (timing sweep S4).


class CaptureArchiveAccepted(BaseModel):
    """``POST /captures/{id}/archive`` answer: the run was ACCEPTED (202).

    The copy of a multi-GB capture takes longer than any proxy timeout, and
    running it in-request produced the worst possible split: the server
    completed the archive (and deleted the source) while the client saw a 504
    "failure" (timing sweep S2-1). The run now executes server-side and the
    client polls ``GET /captures/{id}/archive``.
    """

    capture_id: str
    destination: str
    state: str = "running"


class CaptureArchiveProgress(BaseModel):
    """``GET /captures/{id}/archive`` — polled while a run executes.

    ``state`` walks ``running → complete | failed``. The terminal entry stays
    readable until a new run replaces it, so a client that reconnects after
    the copy finished still learns the outcome instead of a 404.
    """

    capture_id: str
    destination: str
    state: str
    bytes_done: int = 0
    bytes_total: int | None = None
    error: CaptureError | None = None
    result: CaptureArchiveResponse | None = None


# ---- datasets (§6: rows + ledger events; no directory tree) ----------------


class DatasetSelectionCondition(BaseModel):
    field: Literal[
        "any", "operator", "task", "condition", "run_id", "capture_id", "task_result"
    ]
    operator: Literal["contains", "equals"]
    value: str = Field(min_length=1, max_length=500)

    @field_validator("value")
    @classmethod
    def _nonblank_value(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("value must not be blank")
        return value


class DatasetSelectionRecipeCreateRequest(BaseModel):
    """One completed filtered Bulk Add run, recorded after member writes."""

    kind: Literal["filtered_bulk"] = "filtered_bulk"
    join: Literal["and", "or"]
    conditions: list[DatasetSelectionCondition] = Field(default_factory=list)
    matched: int = Field(ge=0)
    attempted: int = Field(ge=0)
    succeeded: int = Field(ge=0)
    failed: int = Field(ge=0)
    catalog_truncated: bool = False

    @model_validator(mode="after")
    def _counts_match_run(self) -> DatasetSelectionRecipeCreateRequest:
        if self.attempted != self.succeeded + self.failed:
            raise ValueError("attempted must equal succeeded plus failed")
        if self.succeeded > self.matched or self.attempted > self.matched:
            raise ValueError("run counts cannot exceed matched")
        return self


class DatasetSelectionRecipe(DatasetSelectionRecipeCreateRequest):
    recipe_id: str
    recorded_at: str


class Dataset(BaseModel):
    """A logical dataset: a named set of captures, with no physical tree.

    ``status`` normally walks ``active → archiving → archived`` (§6.x). A
    durably canceled, zero-progress attempt is the sole ``archiving → active``
    edge; ``archived`` never returns.
    The three ``archive*`` fields are the durable face of the archive run —
    they come from database columns replayed out of the ledger, so they
    survive a rebuild, unlike the in-flight progress served by
    ``GET /datasets/{id}/archive``.
    """

    dataset_id: str
    name: str
    operator: str | None = None
    task: str | None = None
    status: str = "active"
    created_at: str | None = None
    member_count: int = 0
    archive_destination: str | None = None
    # 'copy' sealed the set and kept the recordings here; 'move' removed them.
    archive_mode: str | None = None
    archive_started_at: str | None = None
    archived_at: str | None = None
    selection_recipes: list[DatasetSelectionRecipe] = Field(default_factory=list)


class DatasetMember(BaseModel):
    """One capture's membership in a dataset.

    ``display_index`` is the number shown beside the capture inside this
    dataset. Numbers are never reused after a removal (§6) — the high-water mark
    is recoverable from the ledger, so a retired number cannot be handed to a
    second recording and make two different takes share an identity.
    """

    membership_id: str
    dataset_id: str
    capture_id: str
    display_index: int
    created_at: str | None = None


class DatasetDetail(Dataset):
    """A dataset plus its members (``GET /api/v1/datasets/{id}``)."""

    members: list[DatasetMember] = Field(default_factory=list)


class DatasetArchiveRequest(BaseModel):
    """``POST /api/v1/datasets/{id}/archive`` — start or resume the run (§6.x).

    ``destination`` is ``<root>/<subpath>`` from the archive allow-list; the
    server appends ``<operator>/<task>/<name>`` itself, because the views
    shape has one owner. Omitted on resume — the run continues to the
    destination its ``started`` event froze, and sending a different one is a
    409, not a second archive.
    """

    destination: str | None = None
    # Where under *destination* the dataset lands, as a RELATIVE path whose
    # last component is the dataset's folder. Omitted = the server's default
    # views shape, <operator>/<task>/<name>. Operator-chosen names are free
    # text; escape and overlap are caught by the same realpath checks as the
    # destination itself, and a collision with an existing export is the
    # ordinary 409 destination_not_empty.
    path: str | None = Field(default=None, max_length=500)
    # 'move' (default): copy → verify → remove the sources — needs exclusive
    # members. 'copy': copy → verify → seal, sources untouched — legal for a
    # dataset that shares recordings with others (a combined set). Omitted on
    # resume; naming a different mode than the run's is a 409.
    mode: Literal["copy", "move"] | None = None
    reason: str | None = Field(default=None, max_length=500)


class DatasetArchiveProgress(BaseModel):
    """``GET /api/v1/datasets/{id}/archive`` — one run's progress.

    Split personality on purpose: ``status`` / ``destination`` / the two
    timestamps are durable (rows, replayed from the ledger), while ``running``
    / ``current_*`` / ``error`` are this process's memory and honestly reset
    on restart. ``running: false`` with status ``archiving`` is the resumable
    state the UI renders as a Resume button.
    """

    dataset_id: str
    status: str
    destination: str | None = None
    mode: str | None = None
    member_total: int = 0
    members_done: int = 0
    running: bool = False
    current_capture_id: str | None = None
    current_bytes: int | None = None
    error: dict[str, Any] | None = None
    # Server-authoritative: true only when a halted attempt has no durable
    # completed member and can therefore be abandoned without claiming that
    # copied/removed bytes were rolled back.
    cancelable: bool = False
    cancel_blocker: str | None = None
    archive_started_at: str | None = None
    archived_at: str | None = None


class ExportsConfig(BaseModel):
    """``GET /api/v1/exports/config`` — the §6.2 capability gate.

    ``enabled: false`` (exporter overlay absent, or no profile library) means
    the Convert control is not rendered at all: never offer what can only fail.
    ``profiles`` is exporter-shaped and passed through untouched — the exporter
    owns that schema, and re-modelling it here would just be a copy that drifts.
    """

    enabled: bool
    profiles: list[dict[str, Any]] = Field(default_factory=list)
    # True when the exporter is up but the bundled converter is not importable
    # there, so every profile's ``valid`` is null (present but unverified) —
    # the UI can then say WHY instead of showing an unexplained tri-state.
    validator_unavailable: bool | None = None


class ExportRequest(BaseModel):
    """Body for ``POST /api/v1/datasets/{id}/export`` (§6.2).

    Only what the dialog actually decides: the profile pick, the free memo
    segment of the output name, and the task fallback for unlabeled captures.
    fps / split / resampling live in the profile — a different recipe is a
    different profile, not a request field.
    """

    profile: str = Field(min_length=1, max_length=200)
    # Capped so the composed <operator>_<profile>_<memo> stays within the
    # export-name length bound; compose_export_name also truncates the join, but
    # rejecting an absurd memo here gives a cleaner error than a silent trim.
    memo: str | None = Field(default=None, max_length=64)
    task_fallback: str | None = None


class ExportDropped(BaseModel):
    """Members an export leaves out, each list saying why (§6.2)."""

    not_local: list[str] = Field(default_factory=list)
    excluded: list[str] = Field(default_factory=list)
    recording: list[str] = Field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.not_local) + len(self.excluded) + len(self.recording)


class ExportTaskSummary(BaseModel):
    """How the included captures' task labels resolve (§4.3 rule)."""

    labeled: int
    unlabeled: int
    values: dict[str, int] = Field(default_factory=dict)


class ExportCoverageGap(BaseModel):
    """One capture missing topics the selected profile requires."""

    capture_id: str
    topics: list[str]


class ExportPreflight(BaseModel):
    """``GET /api/v1/datasets/{id}/export/preflight`` — checks without starting.

    The dialog shows this the moment it opens, so a conversion that can only
    fail is visible BEFORE the operator commits — same honesty contract as the
    archive config gate, applied per selection.
    """

    dataset_id: str
    profile: dict[str, Any]
    output_name: str
    output: str
    output_exists: bool
    member_total: int
    included: int
    dropped: ExportDropped
    tasks: ExportTaskSummary
    missing_topics: list[ExportCoverageGap] = Field(default_factory=list)
    coverage_unknown: list[str] = Field(default_factory=list)


class ExportSubmitResponse(BaseModel):
    """``POST /api/v1/datasets/{id}/export`` answer: accepted (202)."""

    export_id: str
    dataset_id: str
    output: str
    included: int
    dropped: ExportDropped


class ExportStatus(BaseModel):
    """``GET /api/v1/datasets/{id}/export`` — proxied exporter state + identity.

    Volatile on both sides: the exporter forgets in-flight exports on restart
    (they become ``failed`` here) and this row lives in orchestrator memory.
    The durable record is the ``dataset_exported`` ledger line written when a
    success is first observed.
    """

    dataset_id: str
    export_id: str
    output: str
    state: str
    queue_position: int | None = None
    done: int = 0
    failed: int = 0
    total: int = 0
    current_episode_pct: float | None = None
    stalled: bool | None = None
    message: str | None = None


class DatasetCreateRequest(BaseModel):
    """Body for ``POST /api/v1/datasets``."""

    name: str = Field(min_length=1, max_length=200)
    operator: str | None = None
    task: str | None = None


class DatasetUpdateRequest(BaseModel):
    """Body for ``PATCH /api/v1/datasets/{id}`` — edit the three labels.

    Same patch semantics as a review save: an omitted field keeps its value, a
    field explicitly set to ``null`` clears it. ``name`` cannot be cleared —
    a dataset without a name has no views path and no way to be spoken about.
    """

    name: str | None = Field(default=None, min_length=1, max_length=200)
    operator: str | None = None
    task: str | None = None


class DatasetMemberCreateRequest(BaseModel):
    """Body for ``POST /api/v1/datasets/{id}/members``."""

    capture_id: str


class DatasetListResponse(BaseModel):
    """``GET /api/v1/datasets``."""

    items: list[Dataset] = Field(default_factory=list)


# ---- record lifecycle ------------------------------------------------------


class RecordStartRequest(BaseModel):
    """Body for ``POST /api/v1/record/start``."""

    topics: list[str] | Literal["all"] | None = None
    compression: Compression = Compression.none
    split: Split | None = None
    qos_default: TopicQos | None = None
    qos_overrides: dict[str, TopicQos] | None = None
    operator: str | None = None
    task: str | None = None
    collection_context: CollectionContextSnapshot | None = None


class RecordPrepareResponse(BaseModel):
    """Response for ``POST /api/v1/record/prepare`` (two-phase start).

    No capture row exists yet — prepare state lives only in memory on the
    orchestrator until a matching ``start`` persists it. ``capture_id`` is the
    recorder's, minted at prepare time (§1), and is carried through so a client
    can correlate the eventual capture without waiting for the start response.
    """

    run_id: str
    capture_id: str | None = None
    state: Literal["armed"] = "armed"
    arming: dict[str, Any] = Field(default_factory=dict)
    disarm_at: str | None = None


# ---- retention (§10, redefined) --------------------------------------------


class RetentionCandidate(BaseModel):
    """One capture surfaced by ``GET /api/v1/retention`` as reclaimable.

    A candidate, never an action. Under v2 the old definition ("a row exists, so
    it was never exported") is meaningless — §6 keeps the row forever — so a
    candidate is now a capture that belongs to **no dataset**, is still
    ``pending`` or ``excluded`` in review, and is older than ``RETENTION_DAYS``.
    """

    capture_id: str
    run_id: str | None = None
    started_at: str | None = None
    bytes: int | None = None
    state: CaptureState
    review_status: ReviewStatus = "pending"


class RetentionResponse(BaseModel):
    """``GET /api/v1/retention`` — reclaim candidates by retention period."""

    days: int
    candidates: list[RetentionCandidate] = Field(default_factory=list)
    total_bytes: int = 0


# ---- store health (§8/§9-3) -------------------------------------------------


class CorruptEntry(BaseModel):
    """A sidecar that exists but cannot be read (§8 rule 4)."""

    capture_id: str | None = None
    path: str
    reason: str


class StoreHealth(BaseModel):
    """``GET /api/v1/store/health`` — what the catalog knows about itself.

    Exists because the two failure modes that matter most are both invisible in
    a normal capture list: a rebuild that could not classify some captures, and
    a reconciler pass that saw so many files vanish at once that it refused to
    believe them (§9-3). Both have to be answerable without reading logs.
    """

    instance_id: str
    state: Literal["ok", "suspect"] = "ok"
    # Set when the §9-3 threshold guard latched: the store stopped applying
    # missing-transitions, the reaper and digests until an operator looks.
    suspect_reason: str | None = None
    suspect_at: str | None = None
    # Whether deletion APIs are available. False when objects/ .trash/ and
    # .incoming/ are not on one filesystem (§2), which would make the trash
    # rename an EXDEV copy — silently not the atomic move the design needs.
    delete_available: bool = True
    delete_unavailable_reason: str | None = None
    rebuilt_at: str | None = None
    rebuild_summary: dict[str, Any] | None = None
    # Corrupt sidecars as of the most recent COMPLETE scan (§8 rule 4). One
    # list, not one per pass: both the startup rebuild and the periodic
    # reconciler scan the same directory, so the newer observation replaces the
    # older rather than being merged with it.
    corrupt: list[CorruptEntry] = Field(default_factory=list)
    # Which pass produced ``corrupt``, and when. Without these "no corruption"
    # from a scan seconds ago is indistinguishable from the same answer taken
    # at boot three days ago.
    corrupt_source: Literal["rebuild", "reconcile"] | None = None
    corrupt_observed_at: str | None = None
    warnings: list[str] = Field(default_factory=list)
    last_reconcile_at: str | None = None
    last_reconcile: dict[str, Any] | None = None


# ---- batches (Collect) ------------------------------------------------------


class Batch(BaseModel):
    """A Collect batch: the captures recorded in one run of a task/condition."""

    batch_id: str
    robot: str | None = None
    project_id: str | None = None
    task_id: str | None = None
    condition_id: str | None = None
    # Optional because an empty plan catalog has no project to name. A console
    # that had to send SOMETHING filled the gap with the dash it displays for
    # "unset", writing a fabricated label into the catalog for good; null is
    # the true statement and this is what lets it be made (E-5).
    project: str | None = None
    task: str | None = None
    condition: str | None = None
    operator: str | None = None
    target_episodes: int = 30
    status: BatchStatus = "active"
    ended_reason: str | None = None
    created_at: str | None = None
    ended_at: str | None = None
    # Monotone count of captures ever reviewed into this batch. Incremented on
    # the FIRST review save for a capture (§4.1's移設 of the old POST /episodes
    # side effect) and never decremented, so "N / 30" stays truthful about what
    # was captured even after a later exclude or delete.
    episodes_recorded: int = 0
    # Whether ``episodes_recorded`` is a LOWER BOUND rather than the count.
    # A rebuild has no record of review saves — the ledger stores facts, not
    # events — so it reconstructs the counter by counting the recordings whose
    # ``record.json`` names this batch. That is a floor: a capture reviewed in
    # and later deleted took its sidecar with it and cannot be counted. The
    # display has to be able to tell the two apart, so it is a field rather
    # than a footnote (§8.2 rule 6).
    episodes_recorded_is_floor: bool = False
    batch_seq: int | None = None


class BatchCreateRequest(BaseModel):
    """Body for ``POST /api/v1/batches``."""

    robot: str | None = None
    project_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    )
    task_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    )
    condition_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    )
    project: str | None = None
    task: str | None = None
    condition: str | None = None
    operator: str | None = None
    target_episodes: int = Field(default=30, ge=1)

    @field_validator("project_id", "task_id", "condition_id", mode="before")
    @classmethod
    def _normalize_plan_ids(cls, value: object) -> object:
        """Match the Plan catalog's canonical ID syntax at the HTTP boundary."""
        return value.strip() if isinstance(value, str) else value


class BatchPatchRequest(BaseModel):
    """Body for ``PATCH /api/v1/batches/{id}``."""

    status: BatchStatus | None = None
    ended_reason: str | None = None
    robot: str | None = None
    project_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    )
    task_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    )
    condition_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    )
    project: str | None = None
    task: str | None = None
    condition: str | None = None
    operator: str | None = None
    target_episodes: int | None = Field(default=None, ge=1, le=500)

    @field_validator("project_id", "task_id", "condition_id", mode="before")
    @classmethod
    def _normalize_plan_ids(cls, value: object) -> object:
        """Match the Plan catalog's canonical ID syntax at the HTTP boundary."""
        return value.strip() if isinstance(value, str) else value


class BatchSummary(Batch):
    """A batch plus how many live captures it holds (``GET /api/v1/batches``).

    A count, deliberately, not a row per capture. The list carried a compact
    summary of every capture of every batch — 817 KiB and one query per batch
    at 50 x 100 (E-27) — which ``GET /api/v1/batches/{id}`` already serves in
    full and better. Anything needing one batch's episodes asks for that batch.

    Not paginated instead: this list is aggregated unfiltered to compute
    coverage, and a default limit would silently shorten a total presented as
    complete.
    """

    episode_count: int = 0


class BatchDetail(Batch):
    """A batch plus its full captures (``GET /api/v1/batches/{id}``)."""

    episode_count: int = 0
    captures: list[Capture] = Field(default_factory=list)


class BatchListResponse(BaseModel):
    """Batch list newest-first (``GET /api/v1/batches``).

    ``total`` counts every batch matching the filters, not the page — it is how
    a caller that asked for a window knows whether there is more. Optional
    because it was added after the fact: a client written against the
    unpaginated list is not required to know the field exists.
    """

    items: list[BatchSummary] = Field(default_factory=list)
    total: int | None = None


class CoverageRow(BaseModel):
    """One condition's recorded total for a task (``GET /batches/coverage``)."""

    condition: str
    condition_id: str | None = None
    # Sum of the batches' monotone ``episodes_recorded`` for this condition.
    recorded: int = 0
    # True when ANY batch in the sum carries ``episodes_recorded_is_floor``.
    # A sum is a lower bound as soon as one of its terms is, and there is no
    # way to say which part is uncertain — so the flag propagates through the
    # addition rather than being reported per batch.
    is_floor: bool = False


class BatchCoverageScope(BaseModel):
    """The exact AND-scoped population used for a coverage aggregate."""

    project_id: str | None = None
    project: str | None = None
    task_id: str | None = None
    task: str | None = None
    robot: str | None = None
    operator: str | None = None
    created_from: str | None = None
    created_to: str | None = None


class BatchCoverageResponse(BaseModel):
    """Per-condition coverage for one task (``GET /api/v1/batches/coverage``).

    Only conditions actually OBSERVED in batches appear, ordered by name. A
    task's planned-but-never-recorded conditions are the caller's to add as
    zero rows: the plan catalog is a client-side vocabulary, and a server that
    invented rows for it would be reporting a plan, not a measurement.
    """

    task: str | None = None
    scope: BatchCoverageScope
    rows: list[CoverageRow] = Field(default_factory=list)


# ---- jobs / validation ------------------------------------------------------


class JobCreateResponse(BaseModel):
    """Response returned after creating a pipeline job."""

    job_id: str
    capture_id: str
    pipeline: str
    state: JobState
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    logs_tail: list[str] = Field(default_factory=list)


class ValidationPresetInfo(BaseModel):
    """A one-click validation preset plus its live not-yet-validated targets."""

    id: str
    name: str
    description: str = ""
    pipeline: str
    params: dict[str, Any] = Field(default_factory=dict)
    total: int
    pending: int
    pending_capture_ids: list[str] = Field(default_factory=list)


class ValidationPresetListResponse(BaseModel):
    """List of one-click validation presets."""

    items: list[ValidationPresetInfo] = Field(default_factory=list)
