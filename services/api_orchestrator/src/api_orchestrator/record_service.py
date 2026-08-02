"""Recording lifecycle: prepare, start, stop, status — and what stop settles.

The orchestrator drives the recorder and files the result as a capture. Under v2
the recorder mints ``capture_id`` (§1) and owns ``object_manifest.json`` until
the recording is finalised (§3.3), which changes one thing fundamentally
compared to v1: **the row is created after the recorder answers, not before.**

There is no ``created`` state any more. A start that the recorder rejects
produces ``objects/<capture_id>.failed.json`` on the recorder's side (§3.4) and
a ``failed`` row here if the error response named a capture; if it did not, the
next rebuild reads that sidecar and creates the row. Either way the failure is
recorded — but a row can no longer exist for a capture the recorder never
acknowledged, which is what used to leave phantom recordings in the catalog.

Stop does four things in order: finalise the row from the recorder's own
manifest (never assuming success), promote the local replica to
``present_unverified``, settle the quick check off the request path, and queue
the digest. The digest is queued rather than run because §9-4 requires the
recorder to have let go first, and the reconciler re-queues anything that gets
dropped — so losing this call costs latency, never verification.

§9-5 is the constraint behind the whole module: start and stop must not depend
on the ledger, the digest or a rebuild. Nothing here writes to
``lifecycle.jsonl``, and every post-stop step is best-effort.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from kairos_common import ApiError, Compression, RecordingConfig, utc_now_iso8601
from kairos_common.capture_sidecars import TERMINAL_STATES, CaptureState
from kairos_common.ids import is_uuid7
from kairos_common.rebuild import ReplicaState

from api_orchestrator.captures import CaptureService
from api_orchestrator.digest import DigestJob
from api_orchestrator.events import EVENT_RECORD_STATUS, EventHub
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import (
    Capture,
    CaptureError,
    CaptureTopic,
    Quality,
    RecordPrepareResponse,
    RecordStartRequest,
    ReviewSaveRequest,
    Split,
    TopicQos,
    coerce_error,
)
from api_orchestrator.monitor_client import MonitorClient
from api_orchestrator.quick_check import (
    assemble_quick_check,
    build_layer0,
    build_layer1,
    incidents_in_window,
    read_mcap_summary,
)
from api_orchestrator.recorder_client import RecorderClient
from api_orchestrator.store import CaptureExistsError, CaptureStore

logger = logging.getLogger("kairos")

# ---- stop-time quick-check settlement budget ------------------------------
QUICK_CHECK_BUDGET_S = 4.0
_SETTLE_MONITOR_TIMEOUT_S = 1.2
_SETTLE_MCAP_TIMEOUT_S = 1.5
_BASELINE_TIMEOUT_S = 1.0

# Bound on suffix-retries when an allocated run_id collides with an existing
# row (same-second starts). One retry practically always suffices.
_MAX_RUN_ID_ATTEMPTS = 50

# Placeholders for empty session metadata. Unlike v1 these no longer key a
# directory path — objects/<capture_id> carries no operator or task (§2) — but
# they still keep every capture filterable and labelable in the UI.
_UNKNOWN_OPERATOR = "unknown_operator"
_UNKNOWN_TASK = "unknown_task"

# The recorder's code for "the manifest is there and cannot be parsed" (§10).
# It arrives as a 500 rather than a 404 precisely so it is not read as "no
# manifest", and it is preserved onto the capture so an operator can see which
# recording needs repairing.
_MANIFEST_CORRUPT = "manifest_corrupt"

# Recorder states that mean a session is genuinely in progress.
_ACTIVE_RECORDER_STATES = {
    CaptureState.recording.value,
    CaptureState.stopping.value,
}


def allocate_run_id(now: datetime | None = None) -> str:
    """``run_YYYYMMDD_HHMMSS`` — a display name, never an API key (§1)."""
    moment = now or datetime.now(UTC)
    return moment.strftime("run_%Y%m%d_%H%M%S")


@dataclass
class _PreparedEntry:
    """An armed ``prepare()`` held in memory (no capture row yet)."""

    run_id: str
    capture_id: str | None
    match_key: tuple[Any, ...]


@dataclass
class MonitorBaseline:
    """Per-topic monitor counters snapshotted at record START.

    The monitor's ``dds_samples_lost``/``messages_total`` are cumulative since
    the monitor started, so the honest per-recording figure is stop minus this.
    Best-effort: absent when the monitor was unreachable, and the quick check
    then reports the raw cumulative value rather than a wrong difference.
    """

    captured_ns: int
    dds_samples_lost: dict[str, int] = field(default_factory=dict)
    messages_total: dict[str, int] = field(default_factory=dict)


class RecordService:
    """Coordinates capture state across the store and the recorder."""

    def __init__(
        self,
        store: CaptureStore,
        layout: DataLayout,
        captures: CaptureService,
        recorder: RecorderClient,
        recording_config: RecordingConfig | None,
        event_hub: EventHub | None = None,
        *,
        instance_id: str,
        monitor: MonitorClient | None = None,
        digest: DigestJob | None = None,
        active_robot: Callable[[], str | None] | None = None,
    ) -> None:
        self._store = store
        self._layout = layout
        self._captures = captures
        self._recorder = recorder
        self._config = recording_config
        self._event_hub = event_hub
        self._monitor = monitor
        self._digest = digest
        # Read at start time, not captured once: a Config-tab robot switch
        # (POST /api/v1/config/select) must reach the NEXT recording without a
        # restart, and the manifest's robot is what every later reader trusts.
        self._active_robot = active_robot
        self._instance_id = instance_id
        self._record_baselines: dict[str, MonitorBaseline] = {}
        self._settlement_tasks: set[asyncio.Task[None]] = set()
        # Serializes the whole start/stop lifecycle so concurrent requests
        # cannot interleave and diverge from the recorder's single session.
        self._lifecycle_lock = asyncio.Lock()
        self._prepared: _PreparedEntry | None = None

    @property
    def layout(self) -> DataLayout:
        return self._layout

    @property
    def data_dir(self):  # noqa: ANN201 - Path, kept for router convenience
        return self._layout.data_dir

    def set_recording_config(self, config: RecordingConfig | None) -> None:
        """Swap the in-memory RECORDING_CONFIG used for next-start resolution."""
        self._config = config

    # ---- events ------------------------------------------------------------

    async def _emit_record_status(
        self, capture: Capture, arming: dict[str, Any] | None = None
    ) -> None:
        """Publish a ``record_status`` SSE event (no-op without a hub).

        ``capture_id`` is additive on the existing event name (§10): a client
        that only knows ``run_id`` keeps working, and one that keys on captures
        no longer has to map a display name back to an identity.
        """
        if self._event_hub is None:
            return
        payload: dict[str, Any] = {
            "capture_id": capture.capture_id,
            "run_id": capture.run_id,
            "state": str(capture.state),
            "message_count": capture.message_count,
            "bytes": capture.bytes,
            "started_at": capture.started_at,
        }
        if arming is not None:
            payload["arming"] = arming
        await self._event_hub.publish(EVENT_RECORD_STATUS, payload)

    # ---- prepare -----------------------------------------------------------

    async def prepare(self, req: RecordStartRequest) -> RecordPrepareResponse:
        """Arm a recording ahead of time so a later matching ``start`` is fast.

        No capture row is created: the recorder holds the armed session, and an
        abandoned prepare auto-disarms on its own timeout. A recorder rejection
        propagates as-is — there is no row to record the failure on.
        """
        req.operator = _default_meta(req.operator, _UNKNOWN_OPERATOR)
        req.task = _default_meta(req.task, _UNKNOWN_TASK)
        topics = self._resolve_topics(req.topics)
        async with self._lifecycle_lock:
            run_id = self._allocate_run_id()
            payload = self._build_recorder_payload(run_id, topics, req)
            body = await self._recorder.prepare(payload)
            # A matching re-prepare extends the already-armed session and
            # returns THAT session's ids — adopt them, or a later start would
            # claim ids the recorder never armed.
            recorder_run_id = body.get("run_id")
            if isinstance(recorder_run_id, str) and recorder_run_id:
                run_id = recorder_run_id
            capture_id = _capture_id_of(body)
            self._prepared = _PreparedEntry(
                run_id=run_id,
                capture_id=capture_id,
                match_key=self._prepare_match_key(topics, req),
            )
            arming = body.get("arming")
            return RecordPrepareResponse(
                run_id=run_id,
                capture_id=capture_id,
                state="armed",
                arming=arming if isinstance(arming, dict) else {},
                disarm_at=body.get("disarm_at"),
            )

    @staticmethod
    def _prepare_match_key(
        topics: list[str] | str, req: RecordStartRequest
    ) -> tuple[Any, ...]:
        """What decides whether a ``start`` matches an outstanding ``prepare``.

        Mirrors the recorder's own comparison. Session metadata is deliberately
        excluded: operator and task do not change what gets recorded, only how
        it is labelled afterwards.
        """
        return (
            topics if isinstance(topics, str) else tuple(topics),
            req.compression.value,
            req.split.model_dump_json() if req.split is not None else None,
            req.qos_default.model_dump_json() if req.qos_default is not None else None,
            tuple(
                sorted(
                    (name, qos.model_dump_json())
                    for name, qos in (req.qos_overrides or {}).items()
                )
            ),
        )

    def _consume_matching_prepared(
        self, topics: list[str] | str, req: RecordStartRequest
    ) -> _PreparedEntry | None:
        """Pop the prepared entry if it matches; clear it either way.

        Clearing on a mismatch too: a stale entry must not be reused by a later
        start, and the recorder disarms its own armed session when this start
        lands, so nothing leaks.
        """
        prepared, self._prepared = self._prepared, None
        if prepared is None or prepared.match_key != self._prepare_match_key(
            topics, req
        ):
            return None
        return prepared

    # ---- start -------------------------------------------------------------

    async def start(self, req: RecordStartRequest) -> Capture:
        """Start a recording and file the capture the recorder minted.

        The row is created from the recorder's response, so ``capture_id`` is
        always the recorder's. A rejection produces a ``failed`` row only if the
        recorder named a capture; otherwise the failed-start sidecar it wrote is
        what the next rebuild turns into a row (§3.4).
        """
        req.operator = _default_meta(req.operator, _UNKNOWN_OPERATOR)
        req.task = _default_meta(req.task, _UNKNOWN_TASK)
        topics = self._resolve_topics(req.topics)
        async with self._lifecycle_lock:
            await self._verify_no_active_recording()
            prepared = self._consume_matching_prepared(topics, req)
            run_id = (
                prepared.run_id if prepared is not None else self._allocate_run_id()
            )

            payload = self._build_recorder_payload(run_id, topics, req)
            try:
                body = await self._recorder.start(payload)
            except ApiError as exc:
                return self._record_failed_start(run_id, req, exc, prepared)

            capture_id = _capture_id_of(body) or (
                prepared.capture_id if prepared is not None else None
            )
            if capture_id is None:
                # Without an id there is nothing to file the capture under, and
                # inventing one here would disagree with the manifest the
                # recorder is already writing.
                raise ApiError(
                    status_code=502,
                    code="recorder_missing_capture_id",
                    message=(
                        "The recorder started a recording but did not return a "
                        "capture_id, so it cannot be filed. This is a recorder "
                        "contract violation (§1)."
                    ),
                    details={"run_id": run_id},
                )

            capture = self._create_capture_row(capture_id, run_id, req, body)
            self._store.upsert_replica(
                capture_id,
                self._instance_id,
                ReplicaState.present_unverified,
                path=str(self._layout.capture_dir(capture_id)),
            )
            capture = await self._sync_metadata(capture_id, allow_partial=True)

            baseline = await self._capture_monitor_baseline()
            if baseline is not None:
                self._record_baselines[capture_id] = baseline
            await self._emit_record_status(
                capture, arming=self._arming_from_start_body(body)
            )
            return capture

    def _create_capture_row(
        self,
        capture_id: str,
        run_id: str,
        req: RecordStartRequest,
        body: dict[str, Any],
    ) -> Capture:
        """Insert the ``recording`` row for a capture the recorder acknowledged."""
        started_at = body.get("started_at")
        capture = Capture(
            capture_id=capture_id,
            run_id=_unique_run_id(self._store, run_id),
            source_instance_id=self._instance_id,
            state=CaptureState.recording,
            started_at=(
                started_at
                if isinstance(started_at, str) and started_at
                else utc_now_iso8601()
            ),
            compression=req.compression,
            split=req.split,
            operator=req.operator,
            task=req.task,
            robot=self._robot_name(),
        )
        try:
            return self._store.create_capture(capture)
        except CaptureExistsError:
            # The recorder re-reported a capture we already know (a retried
            # start against an armed session). Adopt the existing row.
            logger.info(
                "recorder returned a capture_id we already have; adopting the row",
                extra={"capture_id": capture_id},
            )
            return self._store.update_capture(capture_id, state=CaptureState.recording)

    def _record_failed_start(
        self,
        run_id: str,
        req: RecordStartRequest,
        exc: ApiError,
        prepared: _PreparedEntry | None,
    ) -> Capture:
        """Turn a rejected start into a ``failed`` row, if we know the capture."""
        capture_id = _capture_id_of(exc.details or {}) or (
            prepared.capture_id if prepared is not None else None
        )
        logger.warning(
            "recorder start failed",
            extra={"run_id": run_id, "code": exc.code, "capture_id": capture_id},
        )
        if capture_id is None:
            # Nothing to file it under. The recorder's failed-start sidecar is
            # the durable record, and the next rebuild will turn it into a row.
            raise exc
        capture = Capture(
            capture_id=capture_id,
            run_id=_unique_run_id(self._store, run_id),
            source_instance_id=self._instance_id,
            state=CaptureState.failed,
            started_at=utc_now_iso8601(),
            ended_at=utc_now_iso8601(),
            operator=req.operator,
            task=req.task,
            error=CaptureError(code=exc.code, message=exc.message),
        )
        try:
            return self._store.create_capture(capture)
        except CaptureExistsError:
            return self._store.update_capture(
                capture_id,
                state=CaptureState.failed,
                ended_at=utc_now_iso8601(),
                error=CaptureError(code=exc.code, message=exc.message),
            )

    def _allocate_run_id(self) -> str:
        """A display name free of collisions with existing rows."""
        base = allocate_run_id()
        reserved = self._prepared.run_id if self._prepared is not None else None
        for attempt in range(_MAX_RUN_ID_ATTEMPTS):
            run_id = base if attempt == 0 else f"{base}_{attempt}"
            if run_id != reserved and self._store.get_capture_by_run_id(run_id) is None:
                return run_id
        raise ApiError(
            status_code=409,
            code="run_id_unavailable",
            message="Could not allocate a unique run_id; retry shortly.",
        )

    def _resolve_topics(self, topics: list[str] | str | None) -> list[str] | str:
        """Resolve the requested topic selection, or explain why it is empty."""
        if topics == "all":
            return "all"
        if isinstance(topics, list):
            if not topics:
                raise ApiError(
                    status_code=400,
                    code="no_topics",
                    message='topics must be a non-empty list or "all".',
                )
            return topics
        default = list(self._config.default_topics) if self._config else []
        if not default:
            raise ApiError(
                status_code=400,
                code="no_default_topics",
                message="topics omitted and RECORDING_CONFIG has no default_topics.",
            )
        return default

    def _build_recorder_payload(
        self, run_id: str, topics: list[str] | str, req: RecordStartRequest
    ) -> dict[str, Any]:
        """Build the recorder ``POST /record/start`` body.

        ``robot`` is sent so the recorder can stamp it into the manifest, which
        is what makes the manifest — not this row — authoritative about which
        robot produced a capture (§3). Without it a rebuild would have nothing
        to restore the field from.
        """
        payload: dict[str, Any] = {
            "run_id": run_id,
            "topics": topics,
            "compression": req.compression.value,
        }
        robot = self._robot_name()
        if robot is not None:
            payload["robot"] = robot
        if req.operator is not None:
            payload["operator"] = req.operator
        if req.task is not None:
            payload["task"] = req.task
        if req.split is not None:
            payload["split"] = req.split.model_dump()
        if req.qos_default is not None:
            payload["qos_default"] = req.qos_default.model_dump()
        if req.qos_overrides is not None:
            payload["qos_overrides"] = {
                name: qos.model_dump() for name, qos in req.qos_overrides.items()
            }
        return payload

    def _robot_name(self) -> str | None:
        """The robot this deployment is currently recording, if it knows one.

        Prefers the live Config-tab selection over ``RECORDING_CONFIG``'s own
        ``robot_name``: the two can disagree after a robot switch, and the
        selection is the one the operator just made.
        """
        if self._active_robot is not None:
            try:
                selected = self._active_robot()
            except Exception:  # noqa: BLE001 - never fail a start on a lookup
                logger.warning("could not resolve the active robot", exc_info=True)
                selected = None
            if selected:
                return selected
        return self._config.robot_name if self._config else None

    def _arming_from_start_body(
        self, start_body: dict[str, Any]
    ) -> dict[str, Any] | None:
        """The recorder's ``--start-paused`` readiness snapshot, if configured."""
        if not (self._config and self._config.recording.start_paused):
            return None
        arming = start_body.get("arming")
        return arming if isinstance(arming, dict) else None

    # ---- stop --------------------------------------------------------------

    async def stop(self) -> Capture:
        """Stop the active recording and finalise it from the recorder's state.

        Idempotent. The terminal state comes from the recorder's manifest — this
        never assumes completion, because a recording that failed and one that
        finished look identical from the orchestrator's side.
        """
        async with self._lifecycle_lock:
            active = self._active_capture()
            if active is None:
                if self._prepared is not None:
                    # An armed-but-never-started prepare has no row to finalize,
                    # but the recorder holds a live armed session (subscriptions
                    # established, same DDS load as recording) that must not leak
                    # until its own auto-disarm.
                    await self._recorder.stop()
                    self._prepared = None
                    return self._last_capture_or_idle()
                # "No row claims to be active" is NOT "nothing is recording": a
                # crash, or a start whose row never committed, leaves the
                # recorder writing with nothing here to show for it. Reporting
                # success would send the operator on while the bag grows.
                active = await self._adopt_recorder_session()
            if active is None:
                return self._last_capture_or_idle()

            capture_id = active.capture_id
            stopping = self._store.update_capture(
                capture_id, state=CaptureState.stopping
            )
            await self._emit_record_status(stopping)
            await self._recorder.stop()

            capture = await self._sync_metadata(capture_id, allow_partial=True)
            final_state, error = await self._final_state(capture)
            fields: dict[str, Any] = {
                "state": final_state,
                "ended_at": capture.ended_at or utc_now_iso8601(),
            }
            if error is not None:
                fields["error"] = error
            final = self._store.update_capture(capture_id, **fields)
            self._store.upsert_replica(
                capture_id,
                self._instance_id,
                ReplicaState.present_unverified,
                path=str(self._layout.capture_dir(capture_id)),
            )
            await self._emit_record_status(final)

            integrity, backstop = await self._integrity_and_backstop()
            self._schedule_settlement(
                final, integrity=integrity, backstop=backstop, stop_ns=time.time_ns()
            )
            if self._digest is not None:
                # Queued, not awaited: §9-4 needs the recorder to have let go
                # first, and the reconciler re-queues anything dropped here.
                self._digest.schedule(capture_id)
            return final

    async def _final_state(
        self, capture: Capture
    ) -> tuple[CaptureState, CaptureError | None]:
        """Derive a stopped capture's real terminal state from the recorder."""
        recorder_state: str | None = None
        recorder_error: CaptureError | None = None
        try:
            meta = await self._recorder.metadata()
            manifest = meta.get("manifest") or {}
            recorder_state = manifest.get("state")
            recorder_error = coerce_error(manifest.get("error"))
        except ApiError:
            recorder_state = None

        if recorder_state is None:
            try:
                status = await self._recorder.status()
                recorder_state = status.get("state")
            except ApiError:
                recorder_state = None

        if recorder_state in TERMINAL_STATES:
            return CaptureState(recorder_state), recorder_error
        # Completed, idle, or unknown: treat the stop as a completion but keep
        # any sync error already on the row as a reconciliation target.
        return CaptureState.completed, recorder_error

    def _active_capture(self) -> Capture | None:
        """The single capture currently recording/stopping, if any.

        If more than one row is non-terminal (a crash left a ``stopping`` row
        and a forced start created another), the older ones are interrupted
        rather than silently ignored, and the newest is returned.
        """
        active = self._store.list_by_states(
            [CaptureState.recording.value, CaptureState.stopping.value]
        )
        if not active:
            return None
        if len(active) > 1:
            logger.warning(
                "multiple active captures; reconciling stale ones to interrupted",
                extra={"active_capture_ids": [c.capture_id for c in active]},
            )
            for stale in active[:-1]:
                self._store.update_capture(
                    stale.capture_id,
                    state=CaptureState.interrupted,
                    ended_at=utc_now_iso8601(),
                )
        return active[-1]

    async def _adopt_recorder_session(self) -> Capture | None:
        """Adopt a recording the catalog does not know is active, so Stop stops it."""
        status = await self._recorder.status()
        if not self._recorder_is_active(status):
            return None
        capture_id = _capture_id_of(status)
        capture = (
            self._store.get_capture(capture_id) if capture_id is not None else None
        )
        if capture is None:
            await self._recorder.stop()
            logger.warning(
                "stopped a recorder session that has no capture row",
                extra={"capture_id": capture_id, "run_id": status.get("run_id")},
            )
            return None
        logger.warning(
            "adopting a recording the catalog did not have as active",
            extra={"capture_id": capture.capture_id, "row_state": str(capture.state)},
        )
        return capture

    def _last_capture_or_idle(self) -> Capture:
        """The newest capture, for an idempotent stop with nothing active."""
        captures, _ = self._store.list_captures(limit=1, instance_id=self._instance_id)
        if captures:
            return captures[0]
        raise ApiError(
            status_code=404,
            code="no_captures",
            message="No recording is active and nothing has been recorded.",
        )

    # ---- status / reconciliation -------------------------------------------

    async def status(self) -> dict[str, Any]:
        """Proxy the recorder's status, reconciling stale rows as it goes.

        The status poll is the one call every UI makes continuously, so it
        doubles as lazy reconciliation: a capture the catalog still thinks is
        live but the recorder has finished (an auto-stop that bypassed
        ``/record/stop``) is finalised within one poll instead of surfacing as
        ``interrupted`` at the next restart.
        """
        status = await self._recorder.status()
        try:
            await self._reconcile_from_status(status)
        except Exception:  # noqa: BLE001 - status must stay readable
            logger.warning("lazy reconciliation failed", exc_info=True)
        return status

    async def _reconcile_from_status(self, status: dict[str, Any]) -> None:
        live = self._store.list_by_states(
            [CaptureState.recording.value, CaptureState.stopping.value]
        )
        if not live or self._recorder_is_active(status):
            return
        recorder_capture = _capture_id_of(status)
        if any(c.capture_id == recorder_capture for c in live):
            # The recorder finished THIS capture on its own. Finalise it exactly
            # like an API stop: stop() is idempotent and derives the real state.
            await self.stop()
        else:
            self._interrupt_all(live, status)

    async def reconcile_on_startup(self) -> int:
        """Interrupt captures left mid-recording by a previous process."""
        live = self._store.list_by_states(
            [CaptureState.recording.value, CaptureState.stopping.value]
        )
        if not live:
            return 0
        try:
            status = await self._recorder.status()
        except ApiError:
            # Leaving them alone is the honest choice: without the recorder we
            # cannot tell an abandoned recording from a live one, and marking a
            # live one interrupted would orphan a bag still being written.
            logger.warning("reconciliation skipped: recorder unreachable")
            return 0
        interrupted = self._interrupt_all(live, status)
        if interrupted:
            logger.info("reconciled interrupted captures", extra={"count": interrupted})
        return interrupted

    def _interrupt_all(self, live: list[Capture], status: dict[str, Any]) -> int:
        """Interrupt every live row the recorder does not confirm."""
        active_id = _capture_id_of(status) if self._recorder_is_active(status) else None
        interrupted = 0
        for capture in live:
            if capture.capture_id == active_id:
                continue
            # Prefer the recorder's OWN account of how the capture ended. A
            # recorder that was killed and restarted has already written a
            # recovery manifest with re-measured counters and a specific
            # reason; this path only knows "the session is not running", so
            # overwriting that with a generic error and leaving bytes at the
            # live session's value is how 10 MB of data came to be shown as
            # "0 B / empty" (§3: the manifest is authoritative).
            if self._captures.adopt_manifest_facts(capture.capture_id):
                interrupted += 1
                continue
            self._store.update_capture(
                capture.capture_id,
                state=CaptureState.interrupted,
                ended_at=utc_now_iso8601(),
                error=CaptureError(
                    code="interrupted", message="No active recorder session found."
                ),
            )
            interrupted += 1
        return interrupted

    async def _verify_no_active_recording(self) -> None:
        """Ensure nothing is genuinely recording before starting a new session."""
        live = self._store.list_by_states(
            [CaptureState.recording.value, CaptureState.stopping.value]
        )
        if not live:
            return
        status = await self._recorder.status()  # ApiError -> 503, surfaced
        interrupted = self._interrupt_all(live, status)
        if interrupted:
            logger.info(
                "reconciled stale captures at start", extra={"count": interrupted}
            )
        active_id = _capture_id_of(status) if self._recorder_is_active(status) else None
        if active_id is not None:
            raise ApiError(
                status_code=409,
                code="already_recording",
                message="A recording is already in progress.",
                details={"capture_id": active_id, "run_id": status.get("run_id")},
            )

    @staticmethod
    def _recorder_is_active(status: dict[str, Any]) -> bool:
        return status.get("state") in _ACTIVE_RECORDER_STATES

    # ---- metadata sync -----------------------------------------------------

    async def _sync_metadata(self, capture_id: str, *, allow_partial: bool) -> Capture:
        """Sync resolved topics + counters from the recorder into the row."""
        try:
            meta = await self._recorder.metadata()
        except ApiError as exc:
            logger.warning(
                "metadata sync failed",
                extra={"capture_id": capture_id, "code": exc.code},
            )
            if not allow_partial:
                raise
            # Keep the recorder's own code when it named a specific condition.
            # ``manifest_corrupt`` (§10) is the one that matters: the manifest
            # exists and cannot be parsed, which is a repairable fault an
            # operator must see, not the transient unreachability that
            # "metadata_sync_failed" would suggest.
            code = exc.code if exc.code == _MANIFEST_CORRUPT else "metadata_sync_failed"
            return self._store.update_capture(
                capture_id,
                error=CaptureError(code=code, message=exc.message),
            )
        fields = self._metadata_to_fields(meta)
        fields["error"] = None  # a successful sync clears any prior sync error
        return self._store.update_capture(capture_id, **fields)

    @staticmethod
    def _metadata_to_fields(meta: dict[str, Any]) -> dict[str, Any]:
        """Map a recorder ``/record/metadata`` body to row update fields.

        Tolerant of partial metadata by design: at start only the manifest is
        populated and per-topic types are null; after stop the finalized
        ``rosbag2_metadata`` carries the real counts and the types that fill
        those gaps in.
        """
        manifest = meta.get("manifest") or {}
        rosbag = meta.get("rosbag2_metadata") or {}
        fields: dict[str, Any] = {}

        topics = RecordService._merge_topics(manifest, rosbag)
        if topics is not None:
            fields["topics"] = topics
        if rosbag.get("message_count") is not None:
            fields["message_count"] = int(rosbag["message_count"])
        if meta.get("bytes") is not None:
            # The recorder's own total: rosbag2's files[].size is unreliable.
            fields["bytes"] = int(meta["bytes"])
        if manifest.get("robot"):
            # The manifest is authoritative for robot (§3): the recorder stamped
            # what it actually recorded with, which can differ from what we
            # asked for if the selection changed between start and stop.
            fields["robot"] = manifest["robot"]
        if manifest.get("ended_at"):
            fields["ended_at"] = manifest["ended_at"]
        if manifest.get("compression"):
            fields["compression"] = Compression(manifest["compression"])
        if manifest.get("split"):
            fields["split"] = Split.model_validate(manifest["split"])
        return fields

    @staticmethod
    def _merge_topics(
        manifest: dict[str, Any], rosbag: dict[str, Any]
    ) -> list[CaptureTopic] | None:
        """Topics from the manifest, with types backfilled from rosbag2."""
        manifest_topics = manifest.get("topics")
        types_by_name: dict[str, str] = {}
        for entry in rosbag.get("topics_with_message_count") or []:
            tm = entry.get("topic_metadata") or {}
            name = tm.get("name")
            if name and tm.get("type"):
                types_by_name[name] = tm["type"]

        if manifest_topics:
            return [
                CaptureTopic(
                    name=t["name"],
                    type=t.get("type") or types_by_name.get(t["name"], ""),
                    qos=TopicQos.model_validate(t["qos"]) if t.get("qos") else None,
                )
                for t in manifest_topics
            ]
        if types_by_name:
            return [
                CaptureTopic(name=name, type=type_)
                for name, type_ in types_by_name.items()
            ]
        return None

    # ---- quick-check settlement --------------------------------------------

    async def _capture_monitor_baseline(self) -> MonitorBaseline | None:
        """Snapshot cumulative monitor counters at record start (best-effort)."""
        if self._monitor is None:
            return None
        try:
            body = await self._monitor.metrics(timeout=_BASELINE_TIMEOUT_S, retries=0)
        except ApiError:
            return None
        dds: dict[str, int] = {}
        msgs: dict[str, int] = {}
        for topic in body.get("topics") or []:
            if not isinstance(topic, dict):
                continue
            name = topic.get("name")
            if not isinstance(name, str):
                continue
            if (value := _coerce_int(topic.get("dds_samples_lost"))) is not None:
                dds[name] = value
            if (value := _coerce_int(topic.get("messages_total"))) is not None:
                msgs[name] = value
        return MonitorBaseline(
            captured_ns=time.time_ns(), dds_samples_lost=dds, messages_total=msgs
        )

    async def _integrity_and_backstop(self) -> tuple[str | None, str | None]:
        """The recorder's integrity classification and any auto-stop note."""
        try:
            meta = await self._recorder.metadata()
        except ApiError:
            return None, None
        manifest = meta.get("manifest") or {}
        integrity = manifest.get("integrity")
        err = manifest.get("error")
        backstop = (
            err if isinstance(err, str) and err.startswith("auto-stopped:") else None
        )
        return (integrity if isinstance(integrity, str) else None), backstop

    def _schedule_settlement(
        self,
        capture: Capture,
        *,
        integrity: str | None,
        backstop: str | None,
        stop_ns: int,
    ) -> None:
        """Fire the quick-check settlement as a background task (never blocks)."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        task = loop.create_task(
            self._settle_and_persist(
                capture, integrity=integrity, backstop=backstop, stop_ns=stop_ns
            )
        )
        self._settlement_tasks.add(task)
        task.add_done_callback(self._settlement_tasks.discard)

    async def _settle_and_persist(
        self,
        capture: Capture,
        *,
        integrity: str | None,
        backstop: str | None,
        stop_ns: int,
    ) -> None:
        """Compute the two-layer quick check and persist it on the capture."""
        started = time.monotonic()
        capture_id = capture.capture_id
        try:
            baseline = self._record_baselines.pop(capture_id, None)
            topic_names = [t.name for t in capture.topics]
            start_ns = _iso_to_ns(capture.started_at)

            monitor_topics = await self._monitor_metric_topics()
            incidents = await self._monitor_incidents()
            incidents_window = (
                incidents_in_window(incidents, start_ns, stop_ns)
                if incidents is not None
                else None
            )
            layer0 = build_layer0(
                integrity=integrity,
                backstop=backstop,
                monitor_topics=monitor_topics,
                baseline_dds=baseline.dds_samples_lost if baseline else None,
                incidents=incidents_window,
                topic_names=topic_names,
                config=self._config,
            )

            capture_dir = self._layout.capture_dir(capture_id)
            try:
                summary = await asyncio.wait_for(
                    asyncio.to_thread(read_mcap_summary, capture_dir),
                    timeout=_SETTLE_MCAP_TIMEOUT_S,
                )
            except (TimeoutError, OSError):
                summary = None
            required = topic_names or (
                list(self._config.default_topics) if self._config else []
            )
            layer1 = build_layer1(
                summary=summary, config=self._config, required_topics=required
            )

            elapsed_ms = int((time.monotonic() - started) * 1000)
            quick = assemble_quick_check(
                layer0=layer0,
                layer1=layer1,
                elapsed_ms=elapsed_ms,
                config=self._config,
            )
            self._store.update_capture(capture_id, quick_check=quick)
            logger.info(
                "quick_check settled",
                extra={
                    "capture_id": capture_id,
                    "quality": quick.verdict.quality,
                    "elapsed_ms": elapsed_ms,
                },
            )
            await self.reconcile_quality(capture_id, quick.verdict.quality)
        except Exception:  # noqa: BLE001 - settlement must never crash the app
            logger.exception(
                "quick_check settlement failed", extra={"capture_id": capture_id}
            )

    async def reconcile_quality(self, capture_id: str, quality: Quality) -> None:
        """Correct a review that was saved before this verdict landed.

        A review saved during settlement derives its quality from a verdict that
        does not exist yet and falls back to a conservative ``needs_review``.
        Once the real verdict is in, that value is corrected — but only when the
        quality is still ``quick_check``-sourced: an operator's own call is a
        human decision and is never overwritten.

        The correction goes through the ordinary §4.1 path, revision bump and
        all. A client that then sees a 409 is seeing the truth: the review it
        was holding is no longer current.
        """
        try:
            capture = self._store.get_capture(capture_id)
            if capture is None or capture.review_revision == 0:
                return
            if capture.quality_source != "quick_check" or capture.quality == quality:
                return
            await self._captures.save_review(
                capture_id,
                ReviewSaveRequest(
                    base_revision=capture.review_revision,
                    quality=quality,
                    quality_source="quick_check",
                ),
                system=True,
            )
            logger.info(
                "review quality re-derived from the settled quick_check",
                extra={"capture_id": capture_id, "quality": quality},
            )
        except ApiError as exc:
            # A 409 here means an operator edited the review while we settled.
            # Their call wins; nothing to repair.
            logger.info(
                "quality reconcile skipped",
                extra={"capture_id": capture_id, "code": exc.code},
            )
        except Exception:  # noqa: BLE001 - never crash the settlement
            logger.exception(
                "quality reconcile failed", extra={"capture_id": capture_id}
            )

    async def _monitor_metric_topics(self) -> list[dict[str, Any]] | None:
        if self._monitor is None:
            return None
        try:
            body = await self._monitor.metrics(
                timeout=_SETTLE_MONITOR_TIMEOUT_S, retries=0
            )
        except ApiError:
            return None
        topics = body.get("topics")
        return topics if isinstance(topics, list) else None

    async def _monitor_incidents(self) -> list[dict[str, Any]] | None:
        """The whole incident ring, filtered to the window on this side.

        ``since_ns=0`` deliberately: the monitor's own filter is one-sided, so
        scoping the fetch to the recording start would MISS an incident that
        fired before the recording began and stayed open across the whole
        window — exactly the incident that matters most.
        """
        if self._monitor is None:
            return None
        try:
            body = await self._monitor.incidents(
                0, timeout=_SETTLE_MONITOR_TIMEOUT_S, retries=0
            )
        except ApiError:
            return None
        items = body.get("incidents")
        return items if isinstance(items, list) else None

    async def drain_settlements(self) -> None:
        """Await in-flight settlements (shutdown / test determinism)."""
        tasks = list(self._settlement_tasks)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


# ---- helpers ---------------------------------------------------------------


def _capture_id_of(body: dict[str, Any]) -> str | None:
    """Pull a validated singular ``capture_id`` out of a recorder response.

    Validated because it becomes a directory name: an id that is not a UUIDv7 is
    treated as absent rather than joined onto ``objects/``.

    **This is not a liveness signal.** Per §10 the singular field keeps naming
    the last capture after that capture reaches a terminal state, which is
    exactly what makes it useful here — it is how ``stop`` names what it just
    finalised and how the status poll identifies a capture the recorder
    auto-stopped. Every call site in this module either reads it from a
    ``start``/``stop`` response or guards it with
    :meth:`RecordService._recorder_is_active` first. Anything deciding whether a
    capture is still being written must use
    :func:`~api_orchestrator.recorder_client.live_capture_ids` instead.
    """
    value = body.get("capture_id")
    return value if is_uuid7(value) else None


def _unique_run_id(store: CaptureStore, run_id: str) -> str:
    """A run_id free of collisions, or ``None`` if none can be found.

    ``run_id`` is UNIQUE and display-only (§1), so a collision must not fail a
    recording that is already underway — the suffix keeps the name usable and
    the capture_id is what everything else keys on.
    """
    if store.get_capture_by_run_id(run_id) is None:
        return run_id
    for attempt in range(1, _MAX_RUN_ID_ATTEMPTS):
        candidate = f"{run_id}_{attempt}"
        if store.get_capture_by_run_id(candidate) is None:
            return candidate
    return f"{run_id}_{int(time.time())}"


def _default_meta(value: str | None, default: str) -> str:
    """Coerce empty/whitespace metadata to a stable placeholder."""
    return value.strip() if value and value.strip() else default


def _coerce_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return None


def _parse_iso8601(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed


def _iso_to_ns(value: str | None) -> int | None:
    parsed = _parse_iso8601(value)
    if parsed is None:
        return None
    return int(parsed.timestamp() * 1_000_000_000)
