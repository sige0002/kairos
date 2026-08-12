"""LeRobot export endpoints (§6.2): dataset → LeRobot v3 via lerobot_exporter.

The orchestrator's half of the export: it owns the catalog, so it resolves the
dataset's members to a capture snapshot at submission, pins each capture's
effective task label, takes the §7.1 shared leases, and writes the durable
``dataset_exported`` ledger line when it first observes success. The exporter
is deliberately catalog-ignorant — it receives resolved capture ids and paths,
the same division of labor as dora_runner and the lease.

**Snapshot, not freeze.** Unlike archive, an export does not change the
dataset's state. What keeps the input stable is the snapshot taken here (the
member list and each member's task label, fixed at submission) plus the shared
lease on every member (so delete/archive refuse while the export lives). A
membership edit after submission simply does not affect the running export —
by construction, not by lock.

**Lease TTL.** Conversions have no fixed per-job budget (a big dataset can
legitimately run for a long time), so the TTL is a generous constant renewed on
every observation, like jobs': from the last poll of a live export the lease
covers a full hour. The UI polls a running export's status, so an executing
export keeps its leases ahead of it; a queued export that nobody polls can lose
them — the same accepted late-clean-failure as an unobserved queued job.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Query, Request, status
from kairos_common import ApiError
from kairos_common.capture_sidecars import read_object_manifest
from kairos_common.ids import new_export_id
from kairos_common.task_sidecar import effective_task
from kairos_common.time import utc_now_iso8601

from api_orchestrator.dataset_service import DatasetService
from api_orchestrator.deps import get_dataset_service
from api_orchestrator.layout import EXPORTS_DIRNAME
from api_orchestrator.ledger_guard import append_or_503
from api_orchestrator.models import (
    UNFINALIZED_STATES,
    Capture,
    DatasetDetail,
    ExportCoverageGap,
    ExportDropped,
    ExportPreflight,
    ExportRequest,
    ExportsConfig,
    ExportStatus,
    ExportSubmitResponse,
    ExportTaskSummary,
)
from api_orchestrator.store import PRESENT_REPLICA_STATES
from api_orchestrator.views import sanitize_component

logger = logging.getLogger("kairos")

router = APIRouter(prefix="/api/v1", tags=["exports"])

# Renewed in full on every observation of a live export (submit, status poll,
# cancel). Long on purpose: there is no per-export wall-clock budget to derive
# it from, and the failure mode of "too long" (a capture undeletable for a
# while after an export died, with the 409 naming the owner) is the one an
# operator can read and recover from. See the module docstring.
_LEASE_TTL_S = 3600.0 + 300.0

_TERMINAL_STATES = frozenset({"complete", "failed", "canceled"})

# The fixed operator segment when the included captures disagree (§6.2): the
# name always keeps its three-segment shape — dropping a LEADING segment would
# make `arm_only_beta1` unreadable (operator "arm"? profile "only"?).
_MIXED_OPERATOR = "mixed"


class ExportRecord:
    """One dataset's most recent export, as this process remembers it.

    In-memory on purpose, like the archive-run registries: the durable outcome
    is the ledger line plus the output tree itself. What a restart loses is the
    ability to keep polling an export the exporter also forgot — which the
    status endpoint reports as ``failed`` rather than pretending otherwise.
    """

    def __init__(
        self,
        *,
        export_id: str,
        dataset_id: str,
        output_name: str,
        profile: dict[str, Any],
        config_sha256: str | None,
        captures: list[dict[str, Any]],
    ) -> None:
        self.export_id = export_id
        self.dataset_id = dataset_id
        self.output_name = output_name
        self.profile = profile
        self.config_sha256 = config_sha256
        self.captures = captures
        self.created_at = utc_now_iso8601()
        self.ledger_written = False
        self.terminal_state: str | None = None

    @property
    def output(self) -> str:
        return f"{EXPORTS_DIRNAME}/{self.output_name}"


class ExportRegistry:
    """dataset_id → its latest :class:`ExportRecord` (one active per dataset)."""

    def __init__(self) -> None:
        self._records: dict[str, ExportRecord] = {}

    def get(self, dataset_id: str) -> ExportRecord | None:
        return self._records.get(dataset_id)

    def active(self, dataset_id: str) -> ExportRecord | None:
        record = self._records.get(dataset_id)
        if record is not None and record.terminal_state is None:
            return record
        return None

    def put(self, record: ExportRecord) -> None:
        self._records[record.dataset_id] = record


# ---- shared resolution ------------------------------------------------------


def _resolve_members(
    request: Request, detail: DatasetDetail
) -> tuple[list[tuple[str, Capture]], ExportDropped]:
    """The included member captures in ``display_index`` order, plus the drops.

    Drop reasons mirror what the operator can act on: pull the bytes
    (``not_local``), un-exclude the take (``excluded``), or wait for the
    recording to finish (``recording``). A member with no row at all counts as
    ``not_local`` — there is nothing on this installation to read.
    """
    store = request.app.state.capture_store
    instance_id = request.app.state.instance_id
    included: list[tuple[str, Capture]] = []
    dropped = ExportDropped()
    for member in sorted(detail.members, key=lambda m: m.display_index):
        capture = store.get_capture(member.capture_id)
        if capture is None:
            dropped.not_local.append(member.capture_id)
            continue
        if str(capture.state) in UNFINALIZED_STATES:
            dropped.recording.append(member.capture_id)
            continue
        if capture.review_status == "excluded":
            dropped.excluded.append(member.capture_id)
            continue
        replica = store.get_replica(member.capture_id, instance_id)
        # No replica row = present (the same benefit of the doubt jobs give a
        # catalog that predates replicas); a row saying otherwise is a claim.
        if replica is not None and str(replica.state) not in PRESENT_REPLICA_STATES:
            dropped.not_local.append(member.capture_id)
            continue
        included.append((f"{member.display_index:03d}", capture))
    return included, dropped


def _operator_segment(detail: DatasetDetail, captures: list[Capture]) -> str:
    """The name's first segment: dataset label, else the uniform member
    operator, else the fixed word ``mixed`` (§6.2 naming)."""
    if detail.operator:
        return detail.operator
    operators = {c.operator for c in captures if c.operator}
    if len(operators) == 1 and len([c for c in captures if not c.operator]) == 0:
        return next(iter(operators))
    return _MIXED_OPERATOR


def _compose_output_name(operator_seg: str, profile_name: str, memo: str | None) -> str:
    parts = [
        sanitize_component(operator_seg, _MIXED_OPERATOR),
        sanitize_component(profile_name, "profile"),
    ]
    memo = (memo or "").strip()
    if memo:
        # Only the TRAILING segment may be omitted; a memo that sanitises to
        # nothing is treated as omitted rather than appending a junk segment.
        cleaned = sanitize_component(memo, "")
        if cleaned:
            parts.append(cleaned)
    return "_".join(parts)


def _profiles_list(body: dict[str, Any] | list[Any]) -> list[dict[str, Any]]:
    """The exporter's profile list, whether it ships bare or under a key."""
    if isinstance(body, list):
        return [p for p in body if isinstance(p, dict)]
    profiles = body.get("profiles", [])
    return (
        [p for p in profiles if isinstance(p, dict)]
        if isinstance(profiles, list)
        else []
    )


async def _fetch_profile(request: Request, name: str) -> dict[str, Any]:
    client = request.app.state.lerobot_exporter_client
    body = await client.profiles()
    for profile in _profiles_list(body):
        if profile.get("name") == name:
            return profile
    raise ApiError(
        status_code=404,
        code="profile_not_found",
        message=(
            f"No LeRobot profile named {name!r} in this robot's library "
            f"(config/<robot>/lerobot/)."
        ),
        details={"profile": name},
    )


def _resolve_tasks(
    request: Request, included: list[tuple[str, Capture]]
) -> tuple[list[dict[str, Any]], ExportTaskSummary]:
    """Pin each included capture's effective task label (§4.3 rule).

    Read from the sidecars — the store's source of truth — with the row as the
    fallback, exactly like the archive projection (§6). Sidecar writes are
    atomic (temp + rename), so a plain read never sees a torn file.
    """
    layout = request.app.state.data_layout
    episodes: list[dict[str, Any]] = []
    values: dict[str, int] = {}
    unlabeled = 0
    for dir_name, capture in included:
        task = effective_task(layout.capture_dir(capture.capture_id), capture.task)
        if task:
            values[task] = values.get(task, 0) + 1
        else:
            unlabeled += 1
        episodes.append(
            {"capture_id": capture.capture_id, "dir": dir_name, "task": task}
        )
    summary = ExportTaskSummary(
        labeled=len(episodes) - unlabeled, unlabeled=unlabeled, values=values
    )
    return episodes, summary


def _coverage(
    request: Request,
    included: list[tuple[str, Capture]],
    profile: dict[str, Any],
) -> tuple[list[ExportCoverageGap], list[str]]:
    """Which included captures lack topics the profile requires.

    Compared against each capture's sealed manifest — the recording's own
    statement of what it contains — so the answer is per-capture, named, and
    available before anything runs. A capture whose manifest cannot be read is
    reported as unknown rather than silently passed or failed.
    """
    layout = request.app.state.data_layout
    required = [t for t in profile.get("topics", []) if isinstance(t, str)]
    if not required:
        return [], []
    gaps: list[ExportCoverageGap] = []
    unknown: list[str] = []
    for _, capture in included:
        manifest = read_object_manifest(layout.capture_dir(capture.capture_id))
        if not manifest.ok or manifest.manifest is None:
            unknown.append(capture.capture_id)
            continue
        present = {
            str(topic.get("name"))
            for topic in manifest.manifest.topics
            if isinstance(topic, dict) and topic.get("name")
        }
        missing = [t for t in required if t not in present]
        if missing:
            gaps.append(
                ExportCoverageGap(capture_id=capture.capture_id, topics=missing)
            )
    return gaps, unknown


def _config_sha256(profile: dict[str, Any]) -> str | None:
    """sha256 of the profile file, if this process can read it.

    The orchestrator mounts the same /config as the exporter, so this normally
    succeeds; when it cannot (an exporter-local path), the ledger line simply
    omits the hash — the output tree's conversion_log.json still carries the
    authoritative config snapshot.
    """
    path = profile.get("path")
    if not isinstance(path, str) or not path:
        return None
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError:
        return None


def _lease_owner(export_id: str) -> str:
    return f"export:{export_id}"


def _sync_leases(request: Request, record: ExportRecord, state: str) -> None:
    """Extend every member's lease while the export lives; release at terminal.

    Same observation-driven discipline as jobs' ``_sync_lease``: the exporter
    never calls back, so what was just seen drives the holds. Held while
    QUEUED too — the snapshot was already taken, so the bytes must survive the
    wait, and the dialog keeps polling a queued export's status.
    """
    store = request.app.state.capture_store
    owner = _lease_owner(record.export_id)
    if state in _TERMINAL_STATES:
        for entry in record.captures:
            store.release_lease(entry["capture_id"], owner)
        return
    for entry in record.captures:
        store.acquire_lease(entry["capture_id"], owner, ttl_s=_LEASE_TTL_S)


def _release_leases(request: Request, record: ExportRecord) -> None:
    _sync_leases(request, record, "failed")


# ---- endpoints --------------------------------------------------------------


@router.get("/exports/config", response_model=ExportsConfig)
async def exports_config(request: Request) -> ExportsConfig:
    """The capability gate: is there an exporter, and does it have profiles?

    Never errors on an absent exporter — absence is the normal state of an
    installation without the overlay, answered as ``enabled: false``.
    """
    client = request.app.state.lerobot_exporter_client
    try:
        body = await client.profiles()
    except ApiError:
        return ExportsConfig(enabled=False, profiles=[])
    profiles = _profiles_list(body)
    validator_unavailable = (
        body.get("validator_unavailable") if isinstance(body, dict) else None
    )
    return ExportsConfig(
        enabled=bool(profiles),
        profiles=profiles,
        validator_unavailable=validator_unavailable,
    )


@router.get("/datasets/{dataset_id}/export/preflight", response_model=ExportPreflight)
async def export_preflight(
    dataset_id: str,
    request: Request,
    profile: str = Query(min_length=1),
    memo: str | None = Query(default=None),
    service: DatasetService = Depends(get_dataset_service),
) -> ExportPreflight:
    """Everything the dialog shows before the operator commits — no side effects."""
    detail = service.get(dataset_id)
    profile_obj = await _fetch_profile(request, profile)
    included, dropped = _resolve_members(request, detail)
    _, tasks = _resolve_tasks(request, included)
    gaps, unknown = _coverage(request, included, profile_obj)
    operator_seg = _operator_segment(detail, [c for _, c in included])
    output_name = _compose_output_name(
        operator_seg, str(profile_obj.get("name") or profile), memo
    )
    layout = request.app.state.data_layout
    output_dir = layout.data_dir / EXPORTS_DIRNAME / output_name
    output_exists = output_dir.is_dir() and any(output_dir.iterdir())
    return ExportPreflight(
        dataset_id=dataset_id,
        profile=profile_obj,
        output_name=output_name,
        output=f"{EXPORTS_DIRNAME}/{output_name}",
        output_exists=output_exists,
        member_total=len(detail.members),
        included=len(included),
        dropped=dropped,
        tasks=tasks,
        missing_topics=gaps,
        coverage_unknown=unknown,
    )


@router.post(
    "/datasets/{dataset_id}/export",
    response_model=ExportSubmitResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def start_export(
    dataset_id: str,
    body: ExportRequest,
    request: Request,
    service: DatasetService = Depends(get_dataset_service),
) -> ExportSubmitResponse:
    """Snapshot the dataset, take the leases, and hand the exporter the job."""
    registry: ExportRegistry = request.app.state.export_registry
    detail = service.get(dataset_id)
    active = registry.active(dataset_id)
    if active is not None:
        raise ApiError(
            status_code=409,
            code="export_in_progress",
            message=(
                f"Dataset {dataset_id} already has an export "
                f"({active.output}) queued or running."
            ),
            details={"dataset_id": dataset_id, "export_id": active.export_id},
        )
    profile_obj = await _fetch_profile(request, body.profile)
    if profile_obj.get("valid") is False:
        reasons = "; ".join(str(e) for e in profile_obj.get("errors", []))
        raise ApiError(
            status_code=409,
            code="profile_invalid",
            message=(
                f"Profile {body.profile!r} does not validate: "
                f"{reasons or 'unknown error'}"
            ),
            details={"profile": body.profile},
        )
    included, dropped = _resolve_members(request, detail)
    if not included:
        raise ApiError(
            status_code=409,
            code="export_empty",
            message=(
                "No member of this dataset can be exported: every capture is "
                "excluded, still recording, or not on this machine."
            ),
            details={"dataset_id": dataset_id, "dropped": dropped.model_dump()},
        )
    episodes, tasks = _resolve_tasks(request, included)
    task_fallback = (body.task_fallback or "").strip() or (detail.task or None)
    if tasks.unlabeled and not task_fallback:
        raise ApiError(
            status_code=400,
            code="task_required",
            message=(
                f"{tasks.unlabeled} capture(s) have no task label and no "
                "fallback task was given; the converter would have nothing to "
                "write for them."
            ),
            details={"dataset_id": dataset_id, "unlabeled": tasks.unlabeled},
        )
    operator_seg = _operator_segment(detail, [c for _, c in included])
    output_name = _compose_output_name(
        operator_seg, str(profile_obj.get("name") or body.profile), body.memo
    )
    layout = request.app.state.data_layout
    output_dir = layout.data_dir / EXPORTS_DIRNAME / output_name
    if output_dir.is_dir() and any(output_dir.iterdir()):
        # A courtesy copy of the exporter's own refusal, raised while the
        # answer can still be a clean 409 instead of a failed background run.
        raise ApiError(
            status_code=409,
            code="destination_not_empty",
            message=(
                f"exports/{output_name} already exists — change the memo, or "
                "delete the old export if it is no longer needed."
            ),
            details={"dataset_id": dataset_id, "output": f"exports/{output_name}"},
        )
    export_id = new_export_id()
    record = ExportRecord(
        export_id=export_id,
        dataset_id=dataset_id,
        output_name=output_name,
        profile={
            "name": profile_obj.get("name"),
            "path": profile_obj.get("path"),
        },
        config_sha256=_config_sha256(profile_obj),
        captures=episodes,
    )
    # Leases BEFORE the create: the snapshot is already fixed, and a delete
    # racing the submission must lose to it. Shared, so acquiring never
    # arbitrates — and if the exporter refuses the job, the release below
    # undoes every hold.
    _sync_leases(request, record, "queued")
    client = request.app.state.lerobot_exporter_client
    try:
        await client.create_export(
            {
                "export_id": export_id,
                "output_name": output_name,
                "profile_path": profile_obj.get("path"),
                "task_fallback": task_fallback if tasks.unlabeled else None,
                "episodes": episodes,
            }
        )
    except Exception:
        _release_leases(request, record)
        raise
    registry.put(record)
    return ExportSubmitResponse(
        export_id=export_id,
        dataset_id=dataset_id,
        output=record.output,
        included=len(episodes),
        dropped=dropped,
    )


@router.get("/datasets/{dataset_id}/export", response_model=ExportStatus)
async def export_status(dataset_id: str, request: Request) -> ExportStatus:
    """Proxy the exporter's view, keep the leases honest, record success once."""
    registry: ExportRegistry = request.app.state.export_registry
    record = registry.get(dataset_id)
    if record is None:
        raise ApiError(
            status_code=404,
            code="export_not_found",
            message=f"No export known for dataset {dataset_id} in this process.",
            details={"dataset_id": dataset_id},
        )
    client = request.app.state.lerobot_exporter_client
    try:
        body = await client.export_status(record.export_id)
    except ApiError as exc:
        if exc.status_code == 404:
            # The exporter restarted and honestly forgot the run. Nothing is
            # still reading the captures, so the leases go too.
            record.terminal_state = "failed"
            _release_leases(request, record)
            return ExportStatus(
                dataset_id=dataset_id,
                export_id=record.export_id,
                output=record.output,
                state="failed",
                message=(
                    "The exporter no longer knows this export (it restarted). "
                    "Re-run the export."
                ),
            )
        raise
    state = str(body.get("state", "running"))
    _sync_leases(request, record, state)
    if state in _TERMINAL_STATES:
        record.terminal_state = state
    if state == "complete" and not record.ledger_written:
        append_or_503(
            request.app.state.data_layout.data_dir,
            "dataset_exported",
            instance_id=request.app.state.instance_id,
            payload={
                "dataset_id": dataset_id,
                "export_id": record.export_id,
                "output": record.output,
                "profile": record.profile,
                "config_sha256": record.config_sha256,
                "captures": record.captures,
                "done": body.get("done"),
                "failed": body.get("failed"),
                "total": body.get("total"),
            },
            failure=lambda exc: (
                f"The export at {record.output} completed but could not be "
                f"recorded in the ledger: {exc}. Poll again to retry the record."
            ),
            details={"dataset_id": dataset_id, "export_id": record.export_id},
        )
        record.ledger_written = True
    return ExportStatus(
        dataset_id=dataset_id,
        export_id=record.export_id,
        output=record.output,
        state=state,
        queue_position=body.get("queue_position"),
        done=int(body.get("done") or 0),
        failed=int(body.get("failed") or 0),
        total=int(body.get("total") or 0),
        current_episode_pct=body.get("current_episode_pct"),
        stalled=body.get("stalled"),
        message=body.get("message"),
    )


@router.post("/datasets/{dataset_id}/export/cancel", response_model=ExportStatus)
async def cancel_export(dataset_id: str, request: Request) -> ExportStatus:
    """Ask the exporter to stop, then report the state the way status does."""
    registry: ExportRegistry = request.app.state.export_registry
    record = registry.get(dataset_id)
    if record is None:
        raise ApiError(
            status_code=404,
            code="export_not_found",
            message=f"No export known for dataset {dataset_id} in this process.",
            details={"dataset_id": dataset_id},
        )
    client = request.app.state.lerobot_exporter_client
    await client.cancel_export(record.export_id)
    return await export_status(dataset_id, request)
