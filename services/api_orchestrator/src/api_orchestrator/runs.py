"""Run lifecycle service — orchestrates the recorder and the runs store.

This is the heart of Stage 1. It implements the lifecycle from
``api_orchestrator.md``:

1. ``start``: allocate ``run_id`` (UTC), persist ``created``, call the
   recorder, then ``recording`` + sync resolved topics/QoS from the recorder's
   metadata. Recorder failure keeps the row and sets ``failed``.
2. ``stop``: call the recorder, re-sync final metadata
   (``message_count`` / ``bytes`` / ``ended_at``), set ``completed``.
3. ``status``: proxy the recorder's status.
4. reconciliation on startup: any run stuck ``recording`` / ``stopping`` with
   no matching active recorder session becomes ``interrupted``.

The orchestrator's SQLite is the source of truth (``RunStore``); the recorder
owns only the live recording session and its audit manifest.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from kairos_common import (
    ApiError,
    Compression,
    RecordingConfig,
    utc_now_iso8601,
)

from api_orchestrator.events import EVENT_RECORD_STATUS, EventHub
from api_orchestrator.models import (
    RecordStartRequest,
    Run,
    RunError,
    RunState,
    RunTopic,
    Split,
    TopicQos,
)
from api_orchestrator.recorder_client import RecorderClient
from api_orchestrator.store import RunExistsError, RunStore

logger = logging.getLogger("kairos")

# Bound on suffix-retries when an allocated run_id collides with an existing
# row (same-second / rapid starts). Practically one retry suffices.
_MAX_RUN_ID_ATTEMPTS = 50


def allocate_run_id(now: datetime | None = None) -> str:
    """Allocate a ``run_YYYYMMDD_HHMMSS`` id from the current UTC time.

    The fixed ``strftime`` format always satisfies the recorder's run_id
    charset (``[A-Za-z0-9_-]+``, traversal-safe), so no extra validation is
    needed before handing it to the recorder.
    """
    moment = now or datetime.now(UTC)
    return moment.strftime("run_%Y%m%d_%H%M%S")


class RunService:
    """Coordinates run state across the store and the recorder client.

    Args:
        store: The runs store (source of truth).
        recorder: Client for the recorder's internal API.
        recording_config: Loaded ``RECORDING_CONFIG`` (for ``default_topics``).
        event_hub: Optional SSE hub; when set, the service emits
            ``record_status`` events on run state transitions.
    """

    def __init__(
        self,
        store: RunStore,
        recorder: RecorderClient,
        recording_config: RecordingConfig | None,
        event_hub: EventHub | None = None,
        recorded_dir: str | Path = "/data/recorded",
    ) -> None:
        self._store = store
        self._recorder = recorder
        self._config = recording_config
        self._event_hub = event_hub
        # Recording output root; used to remove a run's directory on delete.
        self._recorded_dir = Path(recorded_dir)
        # Serializes the whole start/stop lifecycle (check-active -> call
        # recorder -> update state) so concurrent requests cannot interleave
        # and orphan a row or diverge from the recorder's single session.
        self._lifecycle_lock = asyncio.Lock()

    async def _emit_record_status(self, run: Run) -> None:
        """Publish a ``record_status`` SSE event for *run* (no-op without a hub)."""
        if self._event_hub is None:
            return
        await self._event_hub.publish(
            EVENT_RECORD_STATUS,
            {
                "run_id": run.run_id,
                "state": run.state.value,
                "message_count": run.message_count,
                "bytes": run.bytes,
            },
        )

    # ---- start ------------------------------------------------------------

    async def start(self, req: RecordStartRequest) -> Run:
        """Start a recording: allocate, persist, call recorder, sync metadata.

        Returns the run in ``recording`` on success, or ``failed`` (row kept)
        if the recorder rejected/was unreachable. The whole sequence runs under
        the lifecycle lock so concurrent starts cannot interleave.

        Before starting, any stale ``recording``/``stopping`` row in the DB is
        reconciled against the recorder's real state (see
        :meth:`_verify_no_active_recording`), so a crash-left row can never
        block new recordings forever; a genuinely-active recording yields 409.
        """
        # Resolve topics before taking the lock (pure validation, may 400/422).
        topics = self._resolve_topics(req.topics)
        async with self._lifecycle_lock:
            await self._verify_no_active_recording()
            run = self._create_unique_run(req)
            run_id = run.run_id

            payload = self._build_recorder_payload(run_id, topics, req)
            try:
                await self._recorder.start(payload)
            except ApiError as exc:
                # Keep the row; record why it failed (spec: do not delete).
                logger.warning(
                    "recorder start failed", extra={"run_id": run_id, "code": exc.code}
                )
                return self._update(
                    run_id,
                    state=RunState.failed,
                    ended_at=utc_now_iso8601(),
                    error=RunError(code=exc.code, message=exc.message),
                )

            self._update(run_id, state=RunState.recording)
            # Sync resolved topics/types/QoS ("all" expansion) from the recorder.
            return await self._sync_metadata(run_id, allow_partial=True)

    def _create_unique_run(self, req: RecordStartRequest) -> Run:
        """Allocate a unique ``run_id`` and insert the ``created`` row.

        ``allocate_run_id`` is second-precision, so same-second / rapid starts
        (or a recently recorded run) can collide on the primary key. On
        collision, append a short numeric suffix and retry, so a burst of starts
        never surfaces a raw IntegrityError as a 500.
        """
        base = allocate_run_id()
        started_at = utc_now_iso8601()
        for attempt in range(_MAX_RUN_ID_ATTEMPTS):
            run_id = base if attempt == 0 else f"{base}_{attempt}"
            run = Run(
                run_id=run_id,
                state=RunState.created,
                started_at=started_at,
                compression=req.compression,
                split=req.split,
                operator=req.operator,
                task=req.task,
            )
            try:
                return self._store.create(run)
            except RunExistsError:
                continue
        # Exhausted: extremely unlikely (would need 50 ids taken this second).
        raise ApiError(
            status_code=409,
            code="run_id_unavailable",
            message="Could not allocate a unique run_id; retry shortly.",
        )

    def _resolve_topics(self, topics: list[str] | str | None) -> list[str] | str:
        """Resolve the requested topic selection.

        ``"all"`` passes through to the recorder (it expands it). An explicit
        list passes through. When omitted, fall back to ``recording.yaml``
        ``default_topics``; if that is also empty there is nothing to record.
        """
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
        # Omitted -> default_topics from RECORDING_CONFIG.
        default = list(self._config.default_topics) if self._config else []
        if not default:
            raise ApiError(
                status_code=400,
                code="no_default_topics",
                message=("topics omitted and RECORDING_CONFIG has no default_topics."),
            )
        return default

    @staticmethod
    def _build_recorder_payload(
        run_id: str, topics: list[str] | str, req: RecordStartRequest
    ) -> dict[str, Any]:
        """Build the recorder ``POST /record/start`` body."""
        payload: dict[str, Any] = {
            "run_id": run_id,
            "topics": topics,
            "compression": req.compression.value,
        }
        # Forward session metadata so the recorder can write it into the run's
        # session.json (beside the MCAP).
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

    # ---- stop -------------------------------------------------------------

    async def stop(self) -> Run:
        """Stop the active recording and finalize the run from its real state.

        Idempotent (recorder ``/record/stop`` is idempotent): if no run is
        active, returns the most recent run unchanged instead of erroring. For
        an active run it calls the recorder stop, re-syncs final metadata, and
        sets the run to the recorder's *actual* final state
        (``completed`` / ``failed`` / ``interrupted``) — it does not assume
        completion. Runs under the lifecycle lock.
        """
        async with self._lifecycle_lock:
            active = self._active_run()
            if active is None:
                # Idempotent stop: nothing recording -> report the last run (or
                # raise 404 only if there has never been a run at all).
                return self._last_run_or_idle()

            self._update(active.run_id, state=RunState.stopping)
            await self._recorder.stop()
            # Re-sync final metadata; never fail the stop just because sync did.
            run = await self._sync_metadata(active.run_id, allow_partial=True)
            final_state, error = await self._final_state(run)
            fields: dict[str, Any] = {
                "state": final_state,
                "ended_at": run.ended_at or utc_now_iso8601(),
            }
            if error is not None:
                fields["error"] = error
            return self._update(run.run_id, **fields)

    async def _final_state(self, run: Run) -> tuple[RunState, RunError | None]:
        """Derive a stopped run's real terminal state from the recorder.

        Prefers the recorder's manifest (``GET /record/metadata`` →
        ``manifest.state`` / ``manifest.error``), falling back to
        ``GET /record/status``. Maps to ``completed`` / ``failed`` /
        ``interrupted``; if the recorder is unreachable or reports nothing
        useful we default to ``completed`` but keep any sync error already on
        the run (a reconciliation target). Returns ``(state, error_override)``
        where ``error_override`` is ``None`` to leave the existing error as-is.
        """
        recorder_state: str | None = None
        recorder_error: RunError | None = None

        try:
            meta = await self._recorder.metadata()
            manifest = meta.get("manifest") or {}
            recorder_state = manifest.get("state")
            err = manifest.get("error")
            if isinstance(err, dict) and err.get("code"):
                recorder_error = RunError(
                    code=str(err["code"]),
                    message=str(err.get("message", "")),
                )
        except ApiError:
            recorder_state = None

        if recorder_state is None:
            # Manifest unavailable/silent: try the live status as a fallback.
            try:
                status = await self._recorder.status()
                recorder_state = status.get("state")
            except ApiError:
                recorder_state = None

        terminal = {
            RunState.completed.value: RunState.completed,
            RunState.failed.value: RunState.failed,
            RunState.interrupted.value: RunState.interrupted,
        }
        # If the recorder reports a terminal failure/interruption, reflect it;
        # otherwise (completed, idle, or unknown) treat the stop as completed.
        state = terminal.get(recorder_state or "", RunState.completed)
        # Only override the run's error when the recorder gives us a real one.
        return state, recorder_error

    def _last_run_or_idle(self) -> Run:
        """Return the newest run for an idempotent stop with nothing active.

        If at least one run exists, return the most recent (its persisted
        terminal state). If the store is empty there is genuinely nothing to
        report, so raise a 404 (no run has ever been recorded).
        """
        runs, _ = self._store.list_runs(limit=1)
        if runs:
            return runs[0]
        raise ApiError(
            status_code=404,
            code="no_runs",
            message="No recording is active and no run has been recorded.",
        )

    def _active_run(self) -> Run | None:
        """Return the single run currently recording/stopping, if any."""
        active = self._store.list_by_states([RunState.recording, RunState.stopping])
        return active[-1] if active else None

    def _update(self, run_id: str, **fields: Any) -> Run:
        """Update a run, mapping a missing row to a unified 404.

        :meth:`RunStore.update` raises a bare ``KeyError`` when the row is gone;
        without this it would escape as a generic 500 outside the error
        envelope. Translating it here keeps every response in the unified
        ``{error:{...}}`` shape.
        """
        try:
            return self._store.update(run_id, **fields)
        except KeyError as exc:
            raise ApiError(
                status_code=404,
                code="run_not_found",
                message=f"Run not found: {run_id}",
                details={"run_id": run_id},
            ) from exc

    # ---- status / reads ---------------------------------------------------

    async def status(self) -> dict[str, Any]:
        """Proxy the recorder's ``GET /record/status``."""
        return await self._recorder.status()

    def get(self, run_id: str) -> Run:
        """Return a run or raise a unified 404."""
        run = self._store.get(run_id)
        if run is None:
            raise ApiError(
                status_code=404,
                code="run_not_found",
                message=f"Run not found: {run_id}",
                details={"run_id": run_id},
            )
        return run

    def delete(self, run_id: str) -> None:
        """Delete a run: its recording directory + session.json and the row.

        Raises 404 if the run is unknown, 409 if it is still recording/stopping
        (the active session must be stopped first). The recording dir is removed
        best-effort (the recorder relaxed its mode so uid 1000 can remove it);
        the DB row is then deleted.
        """
        run = self.get(run_id)  # 404 if absent
        if run.state in (RunState.recording, RunState.stopping):
            raise ApiError(
                status_code=409,
                code="run_active",
                message="Cannot delete a run that is still recording; stop it first.",
                details={"run_id": run_id, "state": run.state.value},
            )
        run_path = self._recorded_dir / run_id
        try:
            shutil.rmtree(run_path, ignore_errors=True)
        except OSError:  # pragma: no cover - ignore_errors already swallows most
            logger.warning("could not remove recording dir", extra={"run_id": run_id})
        self._store.delete(run_id)

    def list_runs(self, limit: int, cursor: str | None) -> tuple[list[Run], str | None]:
        """Return one page of runs and the next cursor (opaque string)."""
        parsed = self._parse_cursor(cursor)
        runs, next_seq = self._store.list_runs(limit, parsed)
        return runs, (str(next_seq) if next_seq is not None else None)

    @staticmethod
    def _parse_cursor(cursor: str | None) -> int | None:
        """Decode the opaque cursor; reject anything non-integer with a 400."""
        if cursor is None:
            return None
        try:
            return int(cursor)
        except ValueError as exc:
            raise ApiError(
                status_code=400,
                code="invalid_cursor",
                message="cursor must be an opaque token from a prior page.",
            ) from exc

    # ---- metadata sync ----------------------------------------------------

    async def _sync_metadata(self, run_id: str, *, allow_partial: bool) -> Run:
        """Sync resolved topics + counters from the recorder into the run row.

        On recorder/transport failure: when *allow_partial*, leave the current
        state and record the sync error (reconciliation target), per the spec's
        "leave recording, record the reason, retry later" guidance. Returns the
        (possibly unchanged) run.
        """
        try:
            meta = await self._recorder.metadata()
        except ApiError as exc:
            logger.warning(
                "metadata sync failed", extra={"run_id": run_id, "code": exc.code}
            )
            if not allow_partial:
                raise
            return self._update(
                run_id, error=RunError(code="metadata_sync_failed", message=exc.message)
            )

        fields = self._metadata_to_fields(meta)
        # A successful sync clears any prior sync error.
        fields["error"] = None
        return self._update(run_id, **fields)

    @staticmethod
    def _metadata_to_fields(meta: dict[str, Any]) -> dict[str, Any]:
        """Map a recorder ``/record/metadata`` body to run-row update fields.

        The recorder returns a nested shape::

            { "run_id": ...,
              "manifest": { "topics": [{name,type,qos}], "compression",
                            "split", "ended_at"?, ... },
              "rosbag2_metadata": { "message_count": int,
                                    "topics_with_message_count": [
                                        {"topic_metadata": {name,type,...},
                                         "message_count": int} ], ... } | null,
              "bytes": int }

        ``rosbag2_metadata`` is ``null`` until the bag is finalized (after stop).
        ``bytes`` is the recorder-computed total size (it stats the files; the
        rosbag2 ``files[].size`` is unreliable, so we use this top-level value).
        This method is tolerant of partial metadata: at start time only the
        manifest is populated (types may be null); after stop the finalized
        ``rosbag2_metadata`` carries the real ``message_count`` and the per-topic
        types used to fill in any gaps from the manifest.
        """
        manifest = meta.get("manifest") or {}
        rosbag = meta.get("rosbag2_metadata") or {}
        fields: dict[str, Any] = {}

        topics = RunService._merge_topics(manifest, rosbag)
        if topics is not None:
            fields["topics"] = topics

        if rosbag.get("message_count") is not None:
            fields["message_count"] = int(rosbag["message_count"])

        # Recorder-computed total size (top-level), not sum(files[].size).
        if meta.get("bytes") is not None:
            fields["bytes"] = int(meta["bytes"])

        ended_at = manifest.get("ended_at")
        if ended_at:
            fields["ended_at"] = ended_at
        if manifest.get("compression"):
            fields["compression"] = Compression(manifest["compression"])
        if manifest.get("split"):
            fields["split"] = Split.model_validate(manifest["split"])
        return fields

    @staticmethod
    def _merge_topics(
        manifest: dict[str, Any], rosbag: dict[str, Any]
    ) -> list[RunTopic] | None:
        """Build the run's topic list from manifest topics + rosbag2 types.

        Topics come from ``manifest.topics`` (the recorder's selected set, with
        QoS). Their ``type`` may be null pre-finalize, so it is backfilled from
        ``rosbag2_metadata.topics_with_message_count`` (keyed by topic name)
        once the bag is finalized. Returns ``None`` when neither source has any
        topics (so the existing row is left untouched).
        """
        manifest_topics = manifest.get("topics")
        # Map topic name -> type from the finalized rosbag2 metadata.
        types_by_name: dict[str, str] = {}
        for entry in rosbag.get("topics_with_message_count") or []:
            tm = entry.get("topic_metadata") or {}
            name = tm.get("name")
            if name and tm.get("type"):
                types_by_name[name] = tm["type"]

        if manifest_topics:
            return [
                RunTopic(
                    name=t["name"],
                    type=t.get("type") or types_by_name.get(t["name"], ""),
                    qos=TopicQos.model_validate(t["qos"]) if t.get("qos") else None,
                )
                for t in manifest_topics
            ]
        # No manifest topics: fall back to whatever rosbag2 finalized (no QoS).
        if types_by_name:
            return [
                RunTopic(name=name, type=type_, qos=None)
                for name, type_ in types_by_name.items()
            ]
        return None

    # ---- reconciliation ---------------------------------------------------

    async def reconcile_on_startup(self) -> int:
        """Mark orphaned ``recording``/``stopping`` runs as ``interrupted``.

        On startup, any run the store still thinks is live is checked against
        the recorder's status. If the recorder has no matching active session
        (different/absent ``run_id`` or idle), the run is interrupted. If the
        recorder is unreachable we leave the runs as-is (a later startup, or the
        next ``start`` — see :meth:`_verify_no_active_recording` — reconciles
        them) and return 0.

        Returns the number of runs transitioned to ``interrupted``.
        """
        live = self._store.list_by_states([RunState.recording, RunState.stopping])
        if not live:
            return 0
        try:
            status = await self._recorder.status()
        except ApiError:
            logger.warning("reconciliation skipped: recorder unreachable")
            return 0

        _, interrupted = self._reconcile_against_status(live, status)
        if interrupted:
            logger.info("reconciled interrupted runs", extra={"count": interrupted})
        return interrupted

    def _reconcile_against_status(
        self, live: list[Run], status: dict[str, Any]
    ) -> tuple[str | None, int]:
        """Reconcile *live* DB runs against the recorder's reported *status*.

        Interrupts every live run whose id does not match a genuinely-active
        recorder session. Returns ``(active_id, interrupted_count)`` where
        ``active_id`` is the run id the recorder confirms is still recording (or
        ``None`` if the recorder is idle / its run is unknown to us).
        """
        active_id = status.get("run_id") if self._recorder_is_active(status) else None
        interrupted = 0
        for run in live:
            if run.run_id == active_id:
                continue  # genuinely still recording; leave it.
            self._update(
                run.run_id,
                state=RunState.interrupted,
                ended_at=utc_now_iso8601(),
                error=RunError(
                    code="interrupted",
                    message="No active recorder session found.",
                ),
            )
            interrupted += 1
        return active_id, interrupted

    async def _verify_no_active_recording(self) -> None:
        """Ensure no recording is genuinely active before starting a new one.

        Guards against a stale ``recording``/``stopping`` row left by a crash or
        an unclean shutdown when startup reconciliation was skipped (recorder
        unreachable at boot). Such a row must not block every future start
        forever. We check the recorder's *real* state:

        - recorder idle  -> reconcile the stale DB run(s) to ``interrupted`` and
          allow the new start to proceed (no error);
        - recorder genuinely recording (matching/known session) -> ``409``;
        - recorder unreachable -> ``503`` (can't safely start a second session).

        Called inside ``start`` under the lifecycle lock.
        """
        live = self._store.list_by_states([RunState.recording, RunState.stopping])
        if not live:
            return  # nothing claims to be active; proceed.

        # The DB thinks something is active — verify against the recorder.
        status = await self._recorder.status()  # ApiError -> 503, surfaced
        active_id, interrupted = self._reconcile_against_status(live, status)
        if interrupted:
            logger.info("reconciled stale runs at start", extra={"count": interrupted})
        if active_id is not None:
            # The recorder confirms a real recording is in progress.
            raise ApiError(
                status_code=409,
                code="already_recording",
                message="A recording is already in progress.",
                details={"run_id": active_id},
            )

    @staticmethod
    def _recorder_is_active(status: dict[str, Any]) -> bool:
        """True if the recorder reports an in-progress recording session."""
        active = {RunState.recording.value, RunState.stopping.value}
        return status.get("state") in active
