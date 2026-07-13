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
import json
import logging
import os
import shutil
import tempfile
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
    Episode,
    RecordStartRequest,
    Run,
    RunDetail,
    RunEpisode,
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

# Placeholders for empty session metadata. Dataset export keys directory paths
# on operator/task (data/<operator>/<task>), so a null component must not slip
# through — every recording stays addressable.
_UNKNOWN_OPERATOR = "unknown_operator"
_UNKNOWN_TASK = "unknown_task"


def _default_meta(value: str | None, default: str) -> str:
    """Coerce an empty/whitespace metadata field to a stable placeholder."""
    return value.strip() if value and value.strip() else default


def _run_episode(
    episode: Episode | None, batch_seq: int | None = None
) -> RunEpisode | None:
    """Project a full :class:`Episode` down to the compact run-join summary.

    ``batch_seq`` is the number of the episode's batch (looked up separately, as
    it lives on the batch, not the episode row); ``None`` leaves it unlabeled.
    """
    if episode is None:
        return None
    return RunEpisode(
        episode_id=episode.episode_id,
        batch_id=episode.batch_id,
        batch_seq=batch_seq,
        index_in_batch=episode.index_in_batch,
        task_result=episode.task_result,
        failure_reason=episode.failure_reason,
        quality=episode.quality,
        review_status=episode.review_status,
    )


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    """Write *data* to *path* as JSON atomically (temp file + ``os.replace``).

    Mirrors the config router's YAML writer: the temp file is created in the
    same directory so ``os.replace`` is an atomic same-filesystem rename; on any
    failure the temp file is removed and the original is left untouched.
    ``ensure_ascii=False`` keeps non-ASCII operator/task names intact.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise


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
        data_dir: str | Path | None = None,
    ) -> None:
        self._store = store
        self._recorder = recorder
        self._config = recording_config
        self._event_hub = event_hub
        # Recording output root; used to remove a run's directory on delete and
        # to read a run's manifest sidecar for the detail view.
        self._recorded_dir = Path(recorded_dir)
        # Data root (holds report/ alongside recorded/). Derived from the
        # recorded dir's parent when not given (prod: /data/recorded -> /data).
        self._data_dir = (
            Path(data_dir) if data_dir is not None else self._recorded_dir.parent
        )
        # Serializes the whole start/stop lifecycle (check-active -> call
        # recorder -> update state) so concurrent requests cannot interleave
        # and orphan a row or diverge from the recorder's single session.
        self._lifecycle_lock = asyncio.Lock()

    @property
    def recorded_dir(self) -> Path:
        """Recording output root (``data/recorded``); a run dir lives under it."""
        return self._recorded_dir

    @property
    def data_dir(self) -> Path:
        """Shared data root (holds ``recorded/`` + ``report/`` + the dataset tree)."""
        return self._data_dir

    def list_completed_with_files(self) -> list[Run]:
        """Return completed runs whose recording dir still exists on disk.

        These are the runs eligible for dataset export (bulk "export all"): a
        completed run whose ``recorded/<run_id>`` directory is present. A run
        already exported (dir moved away) or never written is skipped.
        """
        runs = self._store.list_by_states([RunState.completed])
        return [r for r in runs if (self._recorded_dir / r.run_id).is_dir()]

    def set_recording_config(self, config: RecordingConfig | None) -> None:
        """Swap the in-memory RECORDING_CONFIG used for next-start resolution.

        Called when the Config tab persists an edited config (PUT
        ``/api/v1/config/recording``). Only affects topic resolution for the
        *next* ``start`` (``default_topics`` when a request omits ``topics``);
        in-flight runs are untouched, and recorder/monitor QoS still needs a
        service restart since those caches load at startup.
        """
        self._config = config

    async def _emit_record_status(
        self, run: Run, arming: dict[str, Any] | None = None
    ) -> None:
        """Publish a ``record_status`` SSE event for *run* (no-op without a hub).

        When *arming* is supplied (the recorder's ``--start-paused`` readiness
        snapshot, OL-①.4) it is passed through additively so the Live UI can show
        what matched vs is still missing. Omitted on transitions where there is no
        arming (the field is optional in the frozen frontend contract).
        """
        if self._event_hub is None:
            return
        payload: dict[str, Any] = {
            "run_id": run.run_id,
            "state": run.state.value,
            "message_count": run.message_count,
            "bytes": run.bytes,
            # Additive (persona review R2 / I-1): lets a page that missed the
            # start transition still render the elapsed time of an in-progress
            # recording it did not initiate.
            "started_at": run.started_at,
        }
        if arming is not None:
            payload["arming"] = arming
        await self._event_hub.publish(EVENT_RECORD_STATUS, payload)

    def _arming_from_start_body(
        self, start_body: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Pull the recorder's arming snapshot out of the start response body.

        The recorder's ``POST /record/start`` blocks through the ``--start-paused``
        readiness gate and returns the settled snapshot in its 201 body (OL-①.4),
        so the value is available with no extra ``/record/status`` round-trip.
        Only meaningful when ``start_paused`` is configured (otherwise no gate
        runs); guarded on the config so the common path stays untouched. Tolerant:
        a missing/malformed value degrades to ``None`` and the event omits it.
        """
        if not (self._config and self._config.recording.start_paused):
            return None
        arming = start_body.get("arming")
        return arming if isinstance(arming, dict) else None

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
        # Normalize session metadata so every recording is keyable for dataset
        # export: empty/whitespace operator/task become stable placeholders (the
        # dataset path is data/<operator>/<task>; a null component is unkeyable).
        req.operator = _default_meta(req.operator, _UNKNOWN_OPERATOR)
        req.task = _default_meta(req.task, _UNKNOWN_TASK)
        # Resolve topics before taking the lock (pure validation, may 400/422).
        topics = self._resolve_topics(req.topics)
        async with self._lifecycle_lock:
            await self._verify_no_active_recording()
            run = self._create_unique_run(req)
            run_id = run.run_id

            payload = self._build_recorder_payload(run_id, topics, req)
            try:
                start_body = await self._recorder.start(payload)
            except ApiError as exc:
                # Keep the row; record why it failed (spec: do not delete).
                logger.warning(
                    "recorder start failed", extra={"run_id": run_id, "code": exc.code}
                )
                failed = self._update(
                    run_id,
                    state=RunState.failed,
                    ended_at=utc_now_iso8601(),
                    error=RunError(code=exc.code, message=exc.message),
                )
                await self._emit_record_status(failed)
                return failed

            # The recorder stamps started_at at the actual capture start (post
            # spawn/arming), while the row still carries the earlier allocation
            # stamp. Adopt the recorder's value so the elapsed timer measures
            # the bag, not the start overhead (seconds ahead otherwise).
            recorder_started_at = start_body.get("started_at")
            self._update(
                run_id,
                state=RunState.recording,
                **(
                    {"started_at": recorder_started_at}
                    if isinstance(recorder_started_at, str) and recorder_started_at
                    else {}
                ),
            )
            # Sync resolved topics/types/QoS ("all" expansion) from the recorder.
            run = await self._sync_metadata(run_id, allow_partial=True)
            # The recorder's start blocks through the --start-paused arming gate
            # and returns the settled arming snapshot in its body, so pass it
            # straight through on the record_status event (no extra round-trip).
            arming = self._arming_from_start_body(start_body)
            await self._emit_record_status(run, arming=arming)
            return run

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

            stopping = self._update(active.run_id, state=RunState.stopping)
            await self._emit_record_status(stopping)
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
            final = self._update(run.run_id, **fields)
            await self._emit_record_status(final)
            return final

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
            elif isinstance(err, str) and err:
                # The recorder writes manifest.error as a plain string; without
                # this a failed recording would surface state=failed with no
                # reason. Map it to a structured error.
                recorder_error = RunError(code="recorder_failed", message=err)
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
        """Return the single run currently recording/stopping, if any.

        ``start()`` enforces the single-session invariant, but if more than one
        row is ever non-terminal (e.g. a crash left a ``stopping`` row and a
        forced start created another), reconcile the older ones to
        ``interrupted`` rather than silently ignore them (BUG-E), and return the
        newest (``list_by_states`` is seq-ascending).
        """
        active = self._store.list_by_states([RunState.recording, RunState.stopping])
        if not active:
            return None
        if len(active) > 1:
            logger.warning(
                "multiple active runs; reconciling stale ones to interrupted",
                extra={"run_ids": [r.run_id for r in active]},
            )
            for stale in active[:-1]:
                self._update(
                    stale.run_id,
                    state=RunState.interrupted,
                    ended_at=utc_now_iso8601(),
                )
        return active[-1]

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
        """Proxy the recorder's ``GET /record/status``, reconciling stale runs.

        The status poll is the one call every UI makes continuously, so it
        doubles as LAZY reconciliation: if the DB still holds a live
        (``recording``/``stopping``) run but the recorder reports that session
        as over — e.g. the MAX_RECORD_BYTES watcher auto-stopped inside the
        recorder, bypassing ``POST /record/stop`` — the run is finalized
        through the normal stop path (metadata re-sync, real terminal state,
        ``record_status`` SSE) within one poll interval instead of surfacing
        as ``interrupted`` at the next restart. A live run the recorder does
        not know at all is reconciled to ``interrupted`` (same rule as the
        startup pass). Reconciliation errors never fail the status read.
        """
        status = await self._recorder.status()
        try:
            await self._reconcile_from_status(status)
        except Exception:  # noqa: BLE001 - status must stay readable.
            logger.warning("lazy reconciliation failed", exc_info=True)
        return status

    async def _reconcile_from_status(self, status: dict[str, Any]) -> None:
        """Finalize/interrupt DB-live runs the recorder says are over."""
        live = self._store.list_by_states([RunState.recording, RunState.stopping])
        if not live:
            return
        if self._recorder_is_active(status):
            return  # a genuine recording is in progress; nothing stale.
        recorder_run = status.get("run_id")
        if any(run.run_id == recorder_run for run in live):
            # The recorder finished THIS run on its own (auto-stop): finalize
            # it exactly like an API stop — stop() is idempotent and derives
            # the real terminal state from the recorder's manifest.
            await self.stop()
        else:
            self._reconcile_against_status(live, status)

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

    def get_detail(self, run_id: str) -> RunDetail:
        """Return a run enriched with its on-disk manifest + report sidecars.

        The SQLite row stays the source of truth; the manifest / validation /
        dataset_stats are read best-effort and are ``null`` when absent (a run
        whose files were deleted still returns cleanly).
        """
        run = self.get(run_id)  # 404 if absent
        detail = RunDetail(
            **run.model_dump(),
            manifest=self._read_json(self._recorded_dir / run_id / "manifest.json"),
            validation=self._read_json(self._report_path("fast_validation", run_id)),
            dataset_stats=self._read_json(self._report_path("dataset_export", run_id)),
            loss=self._read_json(self._report_path("loss_report", run_id)),
        )
        # Console v2 Phase 2: attach the episode summary (null when none),
        # labeled with its batch's per-day number.
        episode = self._store.get_episode_by_run_id(run_id)
        batch_seq = None
        if episode is not None:
            batch_seq = self._store.batch_seqs_for_ids([episode.batch_id]).get(
                episode.batch_id
            )
        detail.episode = _run_episode(episode, batch_seq)
        return detail

    def _report_path(self, pipeline: str, run_id: str) -> Path:
        return self._data_dir / "report" / pipeline / run_id / "summary.json"

    def has_report(self, pipeline: str, run_id: str) -> bool:
        """Whether *pipeline* has already produced a report for *run_id*.

        This is the "already validated by X" signal for one-click presets: a
        pipeline writes ``report/<pipeline>/<run_id>/summary.json`` on success,
        so its presence means the run was validated by that pipeline. Presets
        that share a pipeline therefore share this state (keyed by pipeline, not
        by preset).
        """
        return self._report_path(pipeline, run_id).is_file()

    def pending_run_ids(self, pipeline: str) -> list[str]:
        """Completed-with-files runs that *pipeline* has not validated yet.

        The target set is un-exported completed recordings (their
        ``recorded/<run_id>`` still on disk); a run already validated by
        *pipeline* (its report exists) is excluded.
        """
        return [
            run.run_id
            for run in self.list_completed_with_files()
            if not self.has_report(pipeline, run.run_id)
        ]

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any] | None:
        """Best-effort read of a JSON sidecar (``None`` on any failure)."""
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    def write_episode_sidecar(
        self, run_id: str, dataset_dir: str | Path
    ) -> dict[str, Any] | None:
        """Persist a run's episode labels into ``<dataset_dir>/episode.json``.

        Called during a successful dataset export, BEFORE the run row is deleted
        (delete cascades the episode). Without this, the operator's
        task_result / failure_reason / quality / review_status and the batch link
        would be lost on export — labeled data would export as unlabeled.

        Reads the episode + its batch and writes ``episode.json`` next to
        ``dataset.json``. A run with no episode writes nothing and returns
        ``None``. The write is best-effort: a filesystem error is logged and
        swallowed (the export already MOVED the recording — it must not fail
        after the fact), returning ``None``.
        """
        episode = self._store.get_episode_by_run_id(run_id)
        if episode is None:
            return None
        batch = self._store.get_batch(episode.batch_id)
        payload: dict[str, Any] = {
            "episode_id": episode.episode_id,
            "batch_id": episode.batch_id,
            "batch_seq": batch.batch_seq if batch else None,
            "index_in_batch": episode.index_in_batch,
            "task_result": episode.task_result,
            "failure_reason": episode.failure_reason,
            "quality": episode.quality,
            "quality_source": episode.quality_source,
            "review_status": episode.review_status,
            # Batch context so the exported dataset is self-describing without
            # the (now-deleted) batch row.
            "batch": {
                "batch_id": batch.batch_id,
                "batch_seq": batch.batch_seq,
                "project": batch.project,
                "task": batch.task,
                "condition": batch.condition,
                "operator": batch.operator,
                "robot": batch.robot,
            }
            if batch
            else None,
            "exported_at": utc_now_iso8601(),
        }
        try:
            _atomic_write_json(Path(dataset_dir) / "episode.json", payload)
        except OSError as exc:
            logger.warning(
                "episode sidecar write failed",
                extra={"run_id": run_id, "error": str(exc)},
            )
            return None
        return payload

    def delete(self, run_id: str, *, keep_reports: bool = False) -> None:
        """Delete a run: its recording directory + session.json and the row.

        Raises 404 if the run is unknown, 409 if it is still recording/stopping
        (the active session must be stopped first). The recording dir is removed
        best-effort (the recorder relaxed its mode so uid 1000 can remove it);
        the DB row is then deleted.

        *keep_reports* preserves the run-keyed ``data/report/*/<run_id>``
        sidecars (validation / loss / video_check mp4 cache). Used after a
        successful dataset export: the row goes away but the reports keep
        backing the exported dataset's detail view.
        """
        run = self.get(run_id)  # 404 if absent
        if run.state in (RunState.recording, RunState.stopping):
            raise ApiError(
                status_code=409,
                code="run_active",
                message="Cannot delete a run that is still recording; stop it first.",
                details={"run_id": run_id, "state": run.state.value},
            )
        # Remove the run dir (best-effort; ignore_errors covers a missing dir,
        # e.g. a failed-start run that never created one).
        shutil.rmtree(self._recorded_dir / run_id, ignore_errors=True)
        # Sibling files the recorder writes next to the run dir (BUG-B): a
        # failed-start run has ONLY these, and a crash can leak the qos file.
        for sibling in (f"{run_id}.qos.yaml", f"{run_id}.failed.json"):
            (self._recorded_dir / sibling).unlink(missing_ok=True)
        # This run's post-hoc report sidecars (validation / loss / dataset /
        # video), unless the caller wants them kept (post-export detail view).
        # The exported dataset tree under data/<operator>/<task> is an
        # intentional artifact and is deliberately NOT removed here.
        if not keep_reports:
            report_root = self._data_dir / "report"
            if report_root.is_dir():
                for pipeline_dir in report_root.iterdir():
                    shutil.rmtree(pipeline_dir / run_id, ignore_errors=True)
        # Cascade the run's episode (Console v2 Phase 2). Done in code rather than
        # via a SQLite FK pragma, so it holds regardless of connection settings.
        self._store.delete_episode_by_run_id(run_id)
        self._store.delete(run_id)

    def list_runs(self, limit: int, cursor: str | None) -> tuple[list[Run], str | None]:
        """Return one page of runs and the next cursor (opaque string).

        Each run is additively joined with its episode summary (Console v2
        Phase 2) via a single batched lookup, so the Review list shows real
        data without an N+1 read per run.
        """
        parsed = self._parse_cursor(cursor)
        runs, next_seq = self._store.list_runs(limit, parsed)
        episodes = self._store.episodes_by_run_ids([r.run_id for r in runs])
        # Batched batch_seq lookup so each joined episode carries its batch
        # number without an N+1 read.
        seqs = self._store.batch_seqs_for_ids(
            list({ep.batch_id for ep in episodes.values()})
        )
        for run in runs:
            ep = episodes.get(run.run_id)
            run.episode = _run_episode(ep, seqs.get(ep.batch_id) if ep else None)
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
