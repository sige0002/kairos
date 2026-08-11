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
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from kairos_common import ApiError, Compression, RecordingConfig, utc_now_iso8601
from kairos_common.capture_sidecars import (
    TERMINAL_STATES,
    CaptureState,
    ObjectManifestV2,
    SidecarStatus,
    read_object_manifest,
    write_quick_check,
)
from kairos_common.ids import is_uuid7
from kairos_common.rebuild import ReplicaState
from kairos_common.record_meta import UNKNOWN_OPERATOR, UNKNOWN_TASK, default_meta

from api_orchestrator.captures import CaptureService
from api_orchestrator.digest import DigestJob
from api_orchestrator.events import EVENT_RECORD_STATUS, EventHub
from api_orchestrator.layout import DataLayout, reject_unusable_labels
from api_orchestrator.models import (
    AUTO_STOP_PREFIX,
    Capture,
    CaptureError,
    CaptureTopic,
    Quality,
    RecordPrepareResponse,
    RecordStartRequest,
    Split,
    TopicQos,
    coerce_error,
)
from api_orchestrator.monitor_client import MonitorClient
from api_orchestrator.recorder_client import START_TIMEOUT_S, RecorderClient
from api_orchestrator.settlement import (
    MonitorBaseline,
    SettlementRunner,
    iso_to_ns,
)
from api_orchestrator.store import CaptureExistsError, CaptureStore

logger = logging.getLogger("kairos")

# Bound on suffix-retries when an allocated run_id collides with an existing
# row (same-second starts). One retry practically always suffices.
_MAX_RUN_ID_ATTEMPTS = 50

# The recorder's code for "the manifest is there and cannot be parsed" (§10).
# It arrives as a 500 rather than a 404 precisely so it is not read as "no
# manifest", and it is preserved onto the capture so an operator can see which
# recording needs repairing.
_MANIFEST_CORRUPT = "manifest_corrupt"

# The config-independent share of a recorder start's worst case, for
# _start_budget_s: subprocess spawn + output-dir wait (3 s) + the resume
# service round-trips (~15 s bounded) + slack for the UNBOUNDED rclpy/DDS
# participant init the arming gate performs before any of its timed waits.
# Floor + the default config waits (2 + 5 + 0) reproduces the long-standing
# 25 s budget exactly.
_START_BUDGET_FLOOR_S = 18.0

# Recorder states that mean a session is genuinely in progress.
_ACTIVE_RECORDER_STATES = {
    CaptureState.recording.value,
    CaptureState.stopping.value,
}

# How long _final_state keeps re-reading the recorder's status after it
# answered that it is STILL recording/stopping, before falling back to the
# manifest. The recorder's own stop has already run its full escalation by the
# time this is consulted, so a still-active answer here is a finaliser writing
# its last few files — seconds, not the 65 s SIGINT/SIGTERM/SIGKILL chain.
_FINAL_STATE_POLL_INTERVAL_S = 0.5
_FINAL_STATE_POLL_BUDGET_S = 10.0


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
        # The quick check settles off the request path (settlement.py). The
        # three callables are resolved at call time, not bound here: the config
        # can be swapped by set_recording_config, and the other two route back
        # through this object so that replacing them on the instance is honoured.
        self._settlement = SettlementRunner(
            store,
            layout,
            captures,
            monitor=monitor,
            config=lambda: self._config,
            monitor_metric_topics=lambda: self._monitor_metric_topics(),
            reconcile=lambda *args, **kwargs: self.reconcile_quality(*args, **kwargs),
            write_quick_check=_write_quick_check,
        )
        # Serializes the whole start/stop lifecycle so concurrent requests
        # cannot interleave and diverge from the recorder's single session.
        self._lifecycle_lock = asyncio.Lock()
        self._prepared: _PreparedEntry | None = None
        # Instance copies of the _final_state poll knobs so a test can run the
        # confirmation in milliseconds (the poll-count seam, same idea as the
        # frontend's __setStopConfirmMs).
        self._final_state_poll_interval_s = _FINAL_STATE_POLL_INTERVAL_S
        self._final_state_poll_budget_s = _FINAL_STATE_POLL_BUDGET_S

    @property
    def _record_baselines(self) -> dict[str, MonitorBaseline]:
        """The settlement's unspent start baselines (one per live recording)."""
        return self._settlement.baselines

    @property
    def _settlement_tasks(self) -> set[asyncio.Task[None]]:
        """The settlements still in flight. Empty means every verdict landed."""
        return self._settlement.tasks

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

        A successful prepare creates no capture row: the recorder holds the
        armed session, and an abandoned prepare auto-disarms on its own
        timeout. A recorder rejection propagates WITHOUT filing a ``failed``
        row: the recorder does not mint a ``.failed.json`` for a failed
        pre-arm probe either (S2-7) — a background keep-alive that cannot arm
        (topic mismatch, disk full) must not deposit a failed capture every
        30 s while nothing tells the operator. The console surfaces the
        failing pre-arm live instead; an operator ``start`` against the same
        blocker still files normally.
        """
        # Before the recorder is told anything. These labels reach views/ as
        # path components whenever a dataset leaves its own unset
        # (``COALESCE(d.operator, c.operator)``), so the dataset-side cap alone
        # left the tree reachable from here (E-11).
        reject_unusable_labels(operator=req.operator, task=req.task)
        req.operator = default_meta(req.operator, UNKNOWN_OPERATOR)
        req.task = default_meta(req.task, UNKNOWN_TASK)
        topics = self._resolve_topics(req.topics)
        async with self._lifecycle_lock:
            run_id = self._allocate_run_id()
            payload = self._build_recorder_payload(run_id, topics, req)
            body = await self._recorder.prepare(
                payload, timeout_s=self._start_budget_s()
            )
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

    def _prepare_match_key(
        self, topics: list[str] | str, req: RecordStartRequest
    ) -> tuple[Any, ...]:
        """What decides whether a ``start`` matches an outstanding ``prepare``.

        Mirrors the recorder's own comparison. Session metadata is deliberately
        excluded: operator and task do not change what gets recorded, only how
        it is labelled afterwards. The LIVE config's QoS patterns are included
        because they ride in both payloads (S1-3): a config switched between
        prepare and start must fall through to a fresh spawn, not resume an
        armed session materialised under the previous config's QoS.
        """
        config_patterns = (
            tuple(o.model_dump_json() for o in self._config.topic_qos_overrides)
            if self._config is not None
            else None
        )
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
            config_patterns,
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
        # Before the recorder is told anything. These labels reach views/ as
        # path components whenever a dataset leaves its own unset
        # (``COALESCE(d.operator, c.operator)``), so the dataset-side cap alone
        # left the tree reachable from here (E-11).
        reject_unusable_labels(operator=req.operator, task=req.task)
        req.operator = default_meta(req.operator, UNKNOWN_OPERATOR)
        req.task = default_meta(req.task, UNKNOWN_TASK)
        topics = self._resolve_topics(req.topics)
        async with self._lifecycle_lock:
            await self._verify_no_active_recording()
            prepared = self._consume_matching_prepared(topics, req)
            run_id = (
                prepared.run_id if prepared is not None else self._allocate_run_id()
            )

            payload = self._build_recorder_payload(run_id, topics, req)
            try:
                body = await self._recorder.start(
                    payload, timeout_s=self._start_budget_s()
                )
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

            await self._settlement.capture_baseline(capture_id)
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
        row = self._file_failed_start_row(run_id, req, exc, capture_id)
        if row is None:
            # Nothing to file it under, and inventing an id here would disagree
            # with whatever the recorder did or did not write.
            raise exc
        return row

    def _file_failed_start_row(
        self,
        run_id: str,
        req: RecordStartRequest,
        exc: ApiError,
        capture_id: str | None,
    ) -> Capture | None:
        """File the ``failed`` row for a recorder rejection, if we know the capture.

        The recorder writes ``objects/<capture_id>.failed.json`` before it
        rejects an arm (§3.4), so from that moment the store CONTAINS a failed
        capture. A catalog that only admits it after the next rebuild shows the
        operator different lists before and after the index is rebuilt — the
        exact divergence §13-4 forbids — so the row is filed the moment the
        rejection arrives, on the start and prepare paths alike. Returns None
        when the rejection named no capture_id (the recorder never got far
        enough to mint one, so there is no sidecar either).
        """
        logger.warning(
            "recorder rejected the arm",
            extra={"run_id": run_id, "code": exc.code, "capture_id": capture_id},
        )
        if capture_id is None:
            return None
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

    def _start_budget_s(self) -> float:
        """Round-trip budget for recorder ``/record/start`` and ``/record/prepare``.

        The recorder blocks through its config's own bounded waits before it
        answers — ``start_delay_s`` (pre-spawn ramp-up), the subscription
        readiness gate, and ``post_discovery_delay_s`` — so a FIXED budget is a
        booby trap: the flat 25 s left a 0.5 s margin against the default
        waits, and a documented config choice (``start_delay_s: 10`` for camera
        warm-up) pushed every cold start into a 503 whose ``_record_failed_start``
        stamped a ``failed`` row onto a recording that was actually coming up
        (timing sweep S2-3). Derive the budget from the LIVE config instead —
        the same config whose QoS patterns ride the start payload — plus a
        floor for the config-independent parts (spawn + output-dir wait +
        resume round-trips + the unbounded rclpy/DDS init). Never below
        :data:`START_TIMEOUT_S`, which stays correct for the defaults. A
        recorder still running an older config after a select can exceed a
        SMALLER derived budget, but never this max().
        """
        if self._config is None:
            return START_TIMEOUT_S
        tuning = self._config.recording
        derived = (
            _START_BUDGET_FLOOR_S
            + tuning.start_delay_s
            + tuning.subscription_ready_timeout_s
            + tuning.post_discovery_delay_s
        )
        return max(START_TIMEOUT_S, derived)

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
        # The LIVE config's pattern QoS overrides ride along on every start:
        # the recorder's own copy was loaded at ITS startup, so after a robot
        # switch (config hot-swap, §config select) the recorder would otherwise
        # keep recording with the previous robot's QoS while labelling captures
        # with the new robot's name (timing sweep S1-3). Sent even when empty —
        # "the live config has no overrides" must also supersede a stale file.
        if self._config is not None:
            payload["qos_override_patterns"] = [
                o.model_dump(mode="json") for o in self._config.topic_qos_overrides
            ]
        # The console half of the two-host provenance stamp: the recorder
        # writes it, together with its own build/config identity, into the
        # capture manifest — so a bad capture is traceable to the exact pair
        # of builds that produced it. Omitted when the sha wasn't baked in.
        console_sha = os.environ.get("KAIROS_GIT_SHA")
        if console_sha:
            payload["console_stamp"] = {"git_sha": console_sha}
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

        if recorder_state in _ACTIVE_RECORDER_STATES:
            # The recorder ANSWERED, and the answer was "still writing". This
            # used to fall through to the ``completed`` return below — the one
            # reading that answer can never justify: "nobody answered" got the
            # careful manifest branch while "I am not done yet" was sealed as a
            # good take. A finaliser normally clears this in seconds (the
            # recorder's stop has already escalated by now), so give it a short
            # poll; whatever it says last decides which branch below runs.
            recorder_state = await self._await_recorder_settled()

        if recorder_state in TERMINAL_STATES:
            return CaptureState(recorder_state), recorder_error
        if recorder_state in _ACTIVE_RECORDER_STATES:
            # Still writing after the whole poll budget. The row must go
            # terminal here (stop() has to commit), and the one state that
            # cannot be true is ``completed``. The manifest is authoritative:
            # sealed terminal → that state; anything else → ``interrupted``,
            # with an error naming what actually happened so the operator sees
            # "the recorder never confirmed this stop" instead of a good take.
            read = read_object_manifest(self._layout.capture_dir(capture.capture_id))
            if (
                read.status is SidecarStatus.ok
                and read.manifest is not None
                and read.manifest.state in TERMINAL_STATES
            ):
                return CaptureState(read.manifest.state), coerce_error(
                    read.manifest.error
                )
            return CaptureState.interrupted, CaptureError(
                code="stop_not_confirmed",
                message=(
                    f"the recorder still reported '{recorder_state}' after the "
                    "stop; the recording was not confirmed stopped"
                ),
            )
        if recorder_state is None:
            # We could not ask AT ALL — the recorder answered the stop and then
            # went away, or died before it could answer. "Nobody is left to
            # ask" is not evidence that the recording finished, and it used to
            # be read as exactly that: this returned ``completed``, so a bag
            # that was never finalised became a good take, dataset-eligible,
            # on the strength of a guess made in the most optimistic direction.
            #
            # The manifest is authoritative (§3) and it is still on disk, so
            # ask it instead. A terminal manifest means the recorder DID seal
            # before it died — that take is genuinely complete and calling it
            # interrupted would send an operator to re-record good data. No
            # terminal manifest means nothing finalised this bag and no later
            # event ever will, which is what ``interrupted`` means (§8 rule 2).
            # Any sync error already on the row is left alone as the specific
            # account of what went wrong.
            #
            # A CORRUPT manifest is deliberately treated as not-sealed, and
            # that is a genuine trade rather than an oversight. A take that DID
            # finalise, whose sidecar then became unreadable, is called
            # ``interrupted`` here — which overstates what we know, because
            # ``CaptureState`` has no "cannot tell" member and this function
            # must return one. It is the right way to be wrong: the likeliest
            # way to get an unparseable manifest is a process killed while
            # writing it, which is a bag that did not finalise either, and the
            # row keeps its sync error so the fault stays visible.
            #
            # This DIVERGES from ``CaptureService.adopt_manifest_facts``, which
            # reads the same corrupt file and changes nothing ("§8 rule 4: an
            # unreadable manifest is reported, never guessed from"). Neither is
            # a bug. Adoption is optional and can decline — leaving the row as
            # it was costs nothing. This is the stop path, which MUST commit to
            # a terminal state right now, and between two guesses it takes the
            # one that does not mark an unfinalised recording as a good take.
            read = read_object_manifest(self._layout.capture_dir(capture.capture_id))
            if (
                read.status is SidecarStatus.ok
                and read.manifest is not None
                and read.manifest.state in TERMINAL_STATES
            ):
                return CaptureState(read.manifest.state), coerce_error(
                    read.manifest.error
                )
            return CaptureState.interrupted, None
        # The recorder answered and is idle or completed: a normal stop.
        return CaptureState.completed, recorder_error

    async def _await_recorder_settled(self) -> str | None:
        """Re-read the recorder's status until it stops answering "active".

        Returns the last state the recorder reported — terminal, some other
        no-session answer, still-active when the budget ran out — or ``None``
        when it stopped answering entirely. A single failed read is NOT treated
        as "gone": the recorder's status route shares its finalise lock, so a
        timeout mid-flush is the busy recorder this poll exists to wait for
        (the same lesson as the console's stop confirmation).
        """
        deadline = time.monotonic() + self._final_state_poll_budget_s
        state: str | None = CaptureState.stopping.value
        answered_recently = True
        while time.monotonic() < deadline:
            await asyncio.sleep(self._final_state_poll_interval_s)
            try:
                status = await self._recorder.status()
            except ApiError:
                answered_recently = False
                continue
            answered_recently = True
            state = status.get("state")
            if state not in _ACTIVE_RECORDER_STATES:
                return state
        return state if answered_recently else None

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
            if capture_id is None:
                # An active recorder that will not say what it is recording.
                # Nothing can be filed under an id we do not have, so the old
                # behaviour (stop it and report the newest row) is all there is
                # — but the caller no longer reports somebody else's take.
                await self._recorder.stop()
                logger.warning(
                    "stopped a recorder session that named no capture",
                    extra={"run_id": status.get("run_id")},
                )
                return None
            return await self._recover_row(capture_id, status)
        logger.warning(
            "adopting a recording the catalog did not have as active",
            extra={"capture_id": capture.capture_id, "row_state": str(capture.state)},
        )
        return capture

    async def _recover_row(self, capture_id: str, status: dict[str, Any]) -> Capture:
        """Rebuild the row for a live capture the catalog lost, so Stop can finish.

        This is the ``kairos.db`` deleted mid-recording case (E-17). §8's rule 1
        deliberately leaves a live capture out of the rebuild — its directory
        has no terminal manifest, and adopting it would invent a finished
        recording out of one still being written — so after the restart the
        recorder is writing and no row claims to be active.

        Recreating the row here, from the manifest the recorder itself wrote,
        puts the capture back on the ORDINARY stop path: the caller goes on to
        mark it stopping, stop the recorder, sync the metadata, take the
        terminal state from the sealed manifest and settle it. Reproducing that
        sequence in a second place would be the way to have two answers for
        what a finished recording is.

        Nothing is invented. Every field comes from ``object_manifest.json``,
        and a manifest that cannot be read means §8 rule 4 applies — there is
        no capture to file, and saying so is the honest end.
        """
        read = read_object_manifest(self._layout.capture_dir(capture_id))
        manifest = read.manifest if read.status is SidecarStatus.ok else None
        if manifest is None or manifest.capture_id != capture_id:
            # Stop it anyway: a recorder left writing is worse than either
            # answer, and this is the one thing we can still do for the bag.
            await self._recorder.stop()
            logger.error(
                "stopped a live recording that cannot be filed",
                extra={"capture_id": capture_id, "sidecar": str(read.status)},
            )
            raise ApiError(
                status_code=409,
                code="stop_capture_unfiled",
                message=(
                    f"The recording was stopped, but {capture_id} could not be "
                    "added to the catalog: its object_manifest.json is missing "
                    "or unreadable, and a capture cannot be reconstructed "
                    "without it. Anything on disk under "
                    f"objects/{capture_id}/ is still there."
                ),
                details={"capture_id": capture_id, "run_id": status.get("run_id")},
            )
        logger.warning(
            "rebuilding the row for a live capture the catalog had lost",
            extra={"capture_id": capture_id, "manifest_state": manifest.state},
        )
        recovered = self._store.upsert_capture(
            Capture(
                capture_id=capture_id,
                run_id=manifest.run_id,
                source_instance_id=manifest.source_instance_id,
                state=CaptureState.recording,
                started_at=manifest.started_at,
                operator=manifest.operator,
                task=manifest.task,
                robot=manifest.robot,
                topics=[CaptureTopic.model_validate(t) for t in manifest.topics],
            )
        )
        self._store.upsert_replica(
            capture_id,
            self._instance_id,
            ReplicaState.present_unverified,
            path=str(self._layout.capture_dir(capture_id)),
        )
        return recovered

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
        # The console's own build next to the recorder's `git_sha`: the ONE
        # poll every UI already makes now answers "are the two hosts running
        # the same build?" — a stale robot image is the split deploy's normal
        # failure mode. Absent when the sha wasn't baked in (never invented).
        console_sha = os.environ.get("KAIROS_GIT_SHA")
        if console_sha:
            status["console_git_sha"] = console_sha
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
            #
            # Read before adopting so the settlement below is built from the
            # same file the adoption decided on.
            sealed = self._sealed_manifest(capture.capture_id)
            if self._captures.adopt_manifest_facts(capture.capture_id):
                # A capture that reached a terminal state gets a quick check,
                # whichever route found it. Only ``stop()`` used to settle one,
                # so everything reconciled here stayed unsettled FOREVER —
                # nothing re-settles a capture later. The gap fell exactly where
                # it hurts: MAX_RECORD_SECONDS is the unattended backstop, and
                # unattended means no console is polling, so the poll that
                # reaches the settling path is the thing that is missing.
                if sealed is not None:
                    self._settle_reconciled(capture.capture_id, sealed)
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

    def _sealed_manifest(self, capture_id: str) -> ObjectManifestV2 | None:
        """This capture's own terminal manifest, or ``None`` if it has none.

        ``None`` covers all three of "no sidecar", "unreadable" and "not
        finalised" on purpose: each means nothing sealed this recording, and a
        recording nothing sealed has no verdict to reach.
        """
        read = read_object_manifest(self._layout.capture_dir(capture_id))
        if read.status is not SidecarStatus.ok or read.manifest is None:
            return None
        return read.manifest if read.manifest.state in TERMINAL_STATES else None

    def _settle_reconciled(self, capture_id: str, manifest: ObjectManifestV2) -> None:
        """Settle the quick check for a capture reconciled outside ``stop()``.

        Everything comes from THIS capture's sealed sidecar rather than from the
        live recorder, which is the difference that matters on these routes: by
        the time anything reconciles a capped take the recorder has usually
        moved on, and asking it would attribute the NEXT recording's integrity —
        and its absence of an auto-stop note — to this one.

        ``stop_ns`` is the capture's own end stamp for the same reason.
        Reconciliation can run minutes or hours after the recorder capped
        itself, so ``now()`` would pull monitor incidents that fired long after
        the bag closed into this recording's window and report them as its own.
        An unreadable stamp yields ``None``, which the window filter already
        handles by keeping incidents rather than placing them on a guess.
        """
        capture = self._store.get_capture(capture_id)
        if capture is None:
            return
        err = manifest.error
        backstop = (
            err if isinstance(err, str) and err.startswith(AUTO_STOP_PREFIX) else None
        )
        self._schedule_settlement(
            capture,
            integrity=manifest.integrity,
            backstop=backstop,
            stop_ns=iso_to_ns(manifest.ended_at),
        )

    def settle_adopted(self, capture_id: str) -> None:
        """Settle a capture the periodic reconciliation pass adopted (§8).

        The route ``_interrupt_all`` cannot reach. With the orchestrator up and
        nobody touching the console there is no poll, no start and no restart,
        so the 120s pass is the FIRST thing to find a recorder that capped
        itself — which is precisely the unattended case ``MAX_RECORD_SECONDS``
        exists for. Adopting the manifest's facts without settling left that
        capture with no verdict for good.

        A capture with nothing sealed on disk is left alone, exactly as above:
        there is no recording to reach a verdict about.
        """
        sealed = self._sealed_manifest(capture_id)
        if sealed is not None:
            self._settle_reconciled(capture_id, sealed)

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
            err if isinstance(err, str) and err.startswith(AUTO_STOP_PREFIX) else None
        )
        return (integrity if isinstance(integrity, str) else None), backstop

    def _schedule_settlement(
        self,
        capture: Capture,
        *,
        integrity: str | None,
        backstop: str | None,
        stop_ns: int | None,
    ) -> None:
        """Fire the quick-check settlement as a background task (never blocks)."""
        self._settlement.schedule(
            capture, integrity=integrity, backstop=backstop, stop_ns=stop_ns
        )

    async def reconcile_quality(
        self,
        capture_id: str,
        quality: Quality,
        *,
        revision_at_verdict: int | None = None,
    ) -> None:
        """Correct a review that was saved before a verdict landed (settlement.py)."""
        await self._settlement.reconcile_quality(
            capture_id, quality, revision_at_verdict=revision_at_verdict
        )

    async def _monitor_metric_topics(self) -> list[dict[str, Any]] | None:
        return await self._settlement.monitor_metric_topics()

    async def drain_settlements(self) -> None:
        """Await in-flight settlements (shutdown / test determinism)."""
        await self._settlement.drain()


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


def _write_quick_check(capture_dir: Path, payload: dict[str, Any]) -> None:
    """Indirection so the settlement resolves ``write_quick_check`` from HERE.

    The runner is handed this function rather than the imported name, and this
    body looks the name up in this module at call time. That is what keeps the
    sidecar write substitutable at the place it has always been substitutable —
    importing it into ``settlement.py`` would move that seam without saying so.
    """
    write_quick_check(capture_dir, payload)
