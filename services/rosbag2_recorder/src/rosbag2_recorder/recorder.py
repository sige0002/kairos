"""The recording session manager: one ``ros2 bag record`` subprocess at a time.

This is the recorder's core. It owns a single recording session (1 container =
1 session, per the spec), spawns ``ros2 bag record`` in its own process group,
tracks the run state, and finalises by parsing the rosbag2 ``metadata.yaml``.

The subprocess spawn is isolated behind :meth:`RecorderSession._spawn_process`
so unit tests can patch it and exercise the full state machine without ROS 2
installed. The integration path (real ``ros2 bag record``) runs in Docker.
"""

from __future__ import annotations

import logging
import os
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

import yaml
from kairos_common import (
    ApiError,
    Compression,
    RecordingConfig,
    Settings,
    utc_now_iso8601,
)

from rosbag2_recorder.manifest import (
    ROSBAG2_METADATA_FILENAME,
    Manifest,
    manifest_path,
    read_manifest,
    run_dir,
    validate_run_id,
    write_failed_start_record,
    write_manifest,
    write_session,
)
from rosbag2_recorder.models import (
    QosProfile,
    RecordStartRequest,
    RecordStatusResponse,
    RunState,
    SplitConfig,
    TopicEntry,
)
from rosbag2_recorder.qos import build_qos_overrides, write_qos_overrides_file

logger = logging.getLogger("kairos.rosbag2_recorder")

# Refuse to start a recording if less free space than this is available; a few
# hundred MB is a conservative floor so we fail fast (507) rather than mid-run.
MIN_FREE_BYTES = 256 * 1024 * 1024

# How long to wait for the bag process to exit after SIGINT before escalating.
STOP_TIMEOUT_S = 30.0

# After spawning ``ros2 bag record`` we wait up to this long for it to create
# its --output directory (proof it passed its own "folder exists" check and
# started). If the process exits before the dir appears, treat it as a start
# failure rather than reporting "recording".
START_DIR_TIMEOUT_S = 3.0
START_DIR_POLL_S = 0.05

# How often the MAX_RECORD_BYTES watcher checks the on-disk size while recording.
SIZE_POLL_S = 2.0

# Return codes that count as a clean shutdown of ``ros2 bag record`` on the stop
# path. We stop it with SIGINT: a process that catches SIGINT and exits cleanly
# returns 0; one terminated by the signal reports ``-SIGINT`` (-2 via Popen) or
# the shell-convention 130 (128 + SIGINT). Anything else (SIGTERM escalation,
# disk-full crash, non-zero error exit) is abnormal -> the run is ``failed``.
_CLEAN_STOP_RETURNCODES = frozenset({0, 130, -int(signal.SIGINT)})

# States in which a session is actively holding (or finalising) the subprocess.
_ACTIVE_STATES = frozenset({RunState.recording, RunState.stopping})


def _qos_overrides_path(recorded_root: Path, run_id: str) -> Path:
    """Path of the QoS overrides file (a sibling of the run dir)."""
    return recorded_root / f"{run_id}.qos.yaml"


class RecorderSession:
    """Owns at most one ``ros2 bag record`` subprocess and its run state.

    A single instance is created per process and shared by the FastAPI routes.
    All public methods are guarded by a lock so concurrent requests
    (start/stop/status) see a consistent view.
    """

    def __init__(
        self, settings: Settings, config: RecordingConfig | None = None
    ) -> None:
        self._settings = settings
        self._config = config
        self._lock = threading.Lock()
        # Resolve to an absolute path so --output and manifest paths do not
        # depend on the process cwd (settings.data_dir defaults to "./data").
        self._data_dir = Path(settings.data_dir).resolve()

        # Current-session fields. ``state`` is the single source of truth for
        # whether a session is active; the rest are only meaningful while one is.
        self._state: RunState = RunState.created
        self._run_id: str | None = None
        self._started_at: str | None = None
        self._compression: Compression = Compression.none
        self._split: SplitConfig | None = None
        self._topics: list[TopicEntry] = []
        self._process: subprocess.Popen[bytes] | None = None
        # Optional session metadata (written to session.json beside the MCAP).
        self._operator: str | None = None
        self._task: str | None = None

        # MAX_RECORD_BYTES auto-stop watcher. 0 disables (default).
        self._max_record_bytes: int = settings.max_record_bytes
        self._size_watcher: threading.Thread | None = None
        self._watcher_stop = threading.Event()
        # Reason for a pending auto-stop, surfaced in the manifest error.
        self._auto_stop_reason: str | None = None

    # -- preconditions ------------------------------------------------------

    def _recorded_root(self) -> Path:
        return self._data_dir / "recorded"

    def ensure_ready(self) -> None:
        """Raise if the recorder cannot serve recordings (readiness probe).

        Readiness == the recorded root is writable with enough free space.
        Reuses the same check ``start`` runs so /readyz predicts start success.
        """
        self._check_writable_and_space()

    def _check_writable_and_space(self) -> None:
        """Raise 507 if ``/data/recorded`` is not writable or space is low."""
        root = self._recorded_root()
        try:
            root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ApiError(
                status_code=507,
                code="data_not_writable",
                message="Recording directory is not writable.",
                details={"path": str(root), "error": str(exc)},
            ) from exc
        if not os.access(root, os.W_OK):
            raise ApiError(
                status_code=507,
                code="data_not_writable",
                message="Recording directory is not writable.",
                details={"path": str(root)},
            )
        free = shutil.disk_usage(root).free
        if free < MIN_FREE_BYTES:
            raise ApiError(
                status_code=507,
                code="insufficient_space",
                message="Insufficient free space to start recording.",
                details={"free_bytes": free, "required_bytes": MIN_FREE_BYTES},
            )

    # -- command construction ----------------------------------------------

    def _build_command(
        self,
        run_id: str,
        topics: list[str] | str,
        request: RecordStartRequest,
        qos_path: Path | None,
    ) -> list[str]:
        """Assemble the ``ros2 bag record`` argv for this run.

        ``--output`` is the run directory; rosbag2 writes
        ``<run_id>_*.mcap`` + ``metadata.yaml`` inside it.
        """
        out = run_dir(self._data_dir, run_id)
        cmd: list[str] = [
            "ros2",
            "bag",
            "record",
            "--storage",
            "mcap",
            "--output",
            str(out),
        ]
        if request.compression is Compression.zstd:
            # File-level zstd compression (rosbag2 standard flags).
            cmd += ["--compression-mode", "file", "--compression-format", "zstd"]
        if request.split is not None:
            if request.split.max_size_mb is not None:
                cmd += ["--max-bag-size", str(request.split.max_size_mb * 1024 * 1024)]
            if request.split.max_duration_s is not None:
                cmd += ["--max-bag-duration", str(request.split.max_duration_s)]
        if qos_path is not None:
            cmd += ["--qos-profile-overrides-path", str(qos_path)]
        if topics == "all":
            cmd += ["--all"]
        else:
            cmd += list(topics)
        return cmd

    def _spawn_process(self, cmd: list[str]) -> subprocess.Popen[bytes]:
        """Spawn *cmd* in a new process group (test seam).

        A new session/process group lets :meth:`stop` deliver SIGINT to the
        whole ``ros2 bag record`` tree (it spawns children), which is how
        rosbag2 flushes and writes ``metadata.yaml`` cleanly.
        """
        return subprocess.Popen(cmd, start_new_session=True)

    # -- lifecycle ----------------------------------------------------------

    def start(self, request: RecordStartRequest) -> RecordStatusResponse:
        """Start a recording session; raise 409 if one is already active."""
        run_id = validate_run_id(request.run_id)
        with self._lock:
            if self._state in _ACTIVE_STATES:
                raise ApiError(
                    status_code=409,
                    code="already_recording",
                    message="A recording session is already active.",
                    details={"run_id": self._run_id, "state": self._state.value},
                )

            self._check_writable_and_space()

            topics = request.topics
            # Freeze the topic selection into the manifest. For an explicit list
            # we record each name now; "all" is expanded by rosbag2 at the DDS
            # layer and reconciled from metadata.yaml at finalise time.
            selected = list(topics) if topics != "all" else []
            self._topics = [
                TopicEntry(name=name, qos=self._resolve_qos(name, request))
                for name in selected
            ]

            # The QoS file is a sibling of the run dir; the run dir itself must
            # NOT exist before spawn (ros2 bag record refuses a pre-existing
            # --output). So nothing here may create run_dir(run_id).
            qos_path = self._materialise_qos(run_id, selected, request)
            cmd = self._build_command(run_id, topics, request, qos_path)

            # Let drivers/cameras ramp up so they are publishing before recording
            # begins (RECORDING_CONFIG recording.start_delay_s). Matters for the
            # --all / camera case where a late publisher would otherwise be
            # subscribed mid-stream.
            self._apply_start_delay()

            started_at = utc_now_iso8601()
            try:
                process = self._spawn_process(cmd)
            except (OSError, ValueError) as exc:
                self._fail(run_id, started_at, request, str(exc))
                raise ApiError(
                    status_code=507,
                    code="record_spawn_failed",
                    message="Failed to start the recording process.",
                    details={"error": str(exc)},
                ) from exc

            # Confirm ros2 bag record actually started: wait for it to create its
            # --output directory (it does so only after passing its own checks).
            # If it exits — or hangs without creating the dir — it failed to start.
            if not self._await_started(run_id, process):
                # Kill a still-alive but stuck process so it cannot later create
                # the output dir behind our back.
                self._terminate_failed_start(process)
                returncode = process.returncode
                self._fail(
                    run_id,
                    started_at,
                    request,
                    f"ros2 bag record did not create the output dir (rc={returncode})",
                )
                raise ApiError(
                    status_code=507,
                    code="record_start_failed",
                    message="The recording process failed to start.",
                    details={"run_id": run_id, "returncode": returncode},
                )

            self._process = process
            self._state = RunState.recording
            self._run_id = run_id
            self._started_at = started_at
            self._compression = request.compression
            self._split = request.split
            self._operator = request.operator
            self._task = request.task
            # The run dir now exists (ros2 created it), so writing the manifest
            # into it no longer races the "folder exists" check.
            self._write_manifest()
            self._start_size_watcher(run_id)
            logger.info(
                "recording started",
                extra={"run_id": run_id, "component": "recorder"},
            )
            return self._status_locked()

    def _start_size_watcher(self, run_id: str) -> None:
        """Start the MAX_RECORD_BYTES auto-stop watcher (no-op if disabled).

        Runs a daemon thread that polls the run's on-disk size and triggers
        ``stop()`` once ``MAX_RECORD_BYTES`` is exceeded. Disabled when
        ``MAX_RECORD_BYTES == 0`` (the default).
        """
        if self._max_record_bytes <= 0:
            return
        self._watcher_stop.clear()
        watcher = threading.Thread(
            target=self._watch_size,
            args=(run_id,),
            name=f"size-watcher-{run_id}",
            daemon=True,
        )
        self._size_watcher = watcher
        watcher.start()

    def _watch_size(self, run_id: str) -> None:
        """Poll the recorded size and auto-stop when MAX_RECORD_BYTES is exceeded.

        Triggered via the public ``stop()`` (which takes the lock and is
        idempotent), so this never touches session state directly and cannot
        deadlock against a concurrent user stop.
        """
        limit = self._max_record_bytes
        while not self._watcher_stop.wait(SIZE_POLL_S):
            size = self._recorded_bytes(run_id)
            if size >= limit:
                self._auto_stop_reason = (
                    f"auto-stopped: recorded {size} bytes reached "
                    f"MAX_RECORD_BYTES={limit}"
                )
                logger.warning(
                    "MAX_RECORD_BYTES exceeded; auto-stopping",
                    extra={"run_id": run_id, "component": "recorder"},
                )
                self.stop()
                return

    def _stop_size_watcher(self) -> None:
        """Signal the size watcher to exit and join it (best-effort).

        Not joined when called from within the watcher thread itself (a
        watcher-triggered stop), to avoid a self-join deadlock.
        """
        self._watcher_stop.set()
        watcher = self._size_watcher
        if (
            watcher is not None
            and watcher is not threading.current_thread()
            and watcher.is_alive()
        ):
            watcher.join(timeout=SIZE_POLL_S + 1.0)
        self._size_watcher = None

    def _await_started(self, run_id: str, process: subprocess.Popen[bytes]) -> bool:
        """Wait for ``ros2 bag record`` to create its output dir.

        Success REQUIRES the run directory to actually exist — that is the only
        proof ros2 passed its own checks and is recording into a real bag.
        Returns ``True`` only once the dir exists; returns ``False`` if the
        process exits first OR the dir has still not appeared by
        ``START_DIR_TIMEOUT_S`` (even if the process is still alive). We never
        assume success without the dir, because the caller would then create it
        itself (writing the manifest), re-introducing the pre-existing-output-dir
        failure for any retry/observer.
        """
        target = run_dir(self._data_dir, run_id)
        deadline = time.monotonic() + START_DIR_TIMEOUT_S
        while True:
            if target.exists():
                return True
            if process.poll() is not None:
                # Exited; give the dir one last check in case of a race.
                return target.exists()
            if time.monotonic() >= deadline:
                # Timed out with no dir: do NOT treat a hung/slow process as a
                # successful start — that would let us create the dir ourselves.
                return target.exists()
            time.sleep(START_DIR_POLL_S)

    def _terminate_failed_start(self, process: subprocess.Popen[bytes]) -> None:
        """Kill a process that failed to start (still alive but no output dir).

        Sends SIGTERM to the process group and waits briefly; best-effort, since
        the process may already have exited.
        """
        if process.poll() is not None:
            return
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            process.wait(timeout=STOP_TIMEOUT_S)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            logger.warning("failed-start process did not exit cleanly")

    def _apply_start_delay(self) -> None:
        """Sleep ``recording.start_delay_s`` before recording (config-driven).

        Only applies when a RECORDING_CONFIG is loaded; with no config there is
        nothing to tune, so we do not delay (also keeps unit tests fast).
        """
        if self._config is None:
            return
        delay = self._config.recording.start_delay_s
        if delay > 0:
            time.sleep(delay)

    def _resolve_qos(
        self, topic: str, request: RecordStartRequest
    ) -> QosProfile | None:
        from rosbag2_recorder.qos import resolve_topic_qos

        return resolve_topic_qos(
            topic, self._config, request.qos_overrides, request.qos_default
        )

    def _materialise_qos(
        self, run_id: str, selected: list[str], request: RecordStartRequest
    ) -> Path | None:
        """Write the QoS overrides file for this run, if any overrides apply.

        The file is written to a *sibling* of the run directory
        (``<recorded>/<run_id>.qos.yaml``), never inside it: ``ros2 bag record``
        refuses to start if its ``--output`` directory already exists, so the
        run dir must not exist until ros2 itself creates it.

        For ``--all`` the live topic list is not known here, so config-pattern
        and ``qos_default`` overrides cannot be pre-materialised (no concrete
        topic names to key the YAML by); only explicit per-request overrides
        (concrete topic names) are emitted.
        """
        topics_for_qos = selected or list((request.qos_overrides or {}).keys())
        overrides = build_qos_overrides(
            topics_for_qos,
            self._config,
            request.qos_overrides,
            request.qos_default,
        )
        return write_qos_overrides_file(
            overrides, _qos_overrides_path(self._recorded_root(), run_id)
        )

    def _cleanup_qos_file(self, run_id: str) -> None:
        """Remove the run's QoS overrides sibling file if it was written."""
        _qos_overrides_path(self._recorded_root(), run_id).unlink(missing_ok=True)

    def stop(self) -> RecordStatusResponse:
        """Stop the active session (idempotent).

        Recording -> SIGINT the process group, wait, finalise, return the
        terminal status. Idle -> return the current status unchanged.
        """
        # Signal the size watcher to stop polling up front so it does not race
        # us into a second stop. (Safe if we ARE the watcher thread.)
        self._watcher_stop.set()
        with self._lock:
            if self._state not in _ACTIVE_STATES or self._process is None:
                return self._status_locked()

            self._state = RunState.stopping
            self._write_manifest()
            process = self._process

        # Signal + wait outside the lock so /status stays responsive; the single
        # active session means no other start can race in (start re-checks state).
        self._signal_and_wait(process)

        with self._lock:
            self._finalise()
            status = self._status_locked()
        # Join the watcher outside the lock (it self-skips if we are it).
        self._stop_size_watcher()
        return status

    def _signal_and_wait(self, process: subprocess.Popen[bytes]) -> None:
        """SIGINT the process group, then wait; escalate to SIGTERM on timeout."""
        try:
            pgid = os.getpgid(process.pid)
            os.killpg(pgid, signal.SIGINT)
        except ProcessLookupError:
            return  # Already gone.
        try:
            process.wait(timeout=STOP_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            logger.warning("bag process did not exit on SIGINT; sending SIGTERM")
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
                process.wait(timeout=STOP_TIMEOUT_S)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                logger.error("bag process did not exit on SIGTERM")

    def _finalise(self) -> None:
        """Move from ``stopping`` to a terminal state, syncing from metadata.

        ``completed`` requires BOTH a clean shutdown return code AND a written
        ``metadata.yaml``. Metadata presence alone is not enough: an abnormal
        exit (disk full, partial write, rosbag2 crash, SIGTERM escalation) can
        leave a stale/partial metadata.yaml, which must be reported ``failed``.
        """
        run_id = self._run_id
        process = self._process
        returncode = process.returncode if process is not None else None
        ended_at = utc_now_iso8601()

        meta = self._read_rosbag2_metadata(run_id) if run_id else None
        clean_exit = returncode in _CLEAN_STOP_RETURNCODES
        if meta is not None and clean_exit:
            self._sync_topics_from_metadata(meta)
            self._state = RunState.completed
            # A MAX_RECORD_BYTES auto-stop is a *successful* completion at the
            # cap; record why it ended in the note field (no error occurred).
            error = self._auto_stop_reason
        else:
            self._state = RunState.failed
            if meta is None:
                error = f"recording produced no metadata.yaml (rc={returncode})"
            else:
                # Have metadata but the process did not shut down cleanly: still
                # sync what we can for the audit record, but mark the run failed.
                self._sync_topics_from_metadata(meta)
                error = f"recording ended abnormally (rc={returncode})"

        self._process = None
        self._auto_stop_reason = None
        self._write_manifest(ended_at=ended_at, error=error)
        if run_id:
            self._cleanup_qos_file(run_id)
        logger.info(
            "recording finalised",
            extra={"run_id": run_id, "component": "recorder"},
        )

    def _fail(
        self,
        run_id: str,
        started_at: str,
        request: RecordStartRequest,
        error: str,
    ) -> None:
        """Record a START failure WITHOUT creating a recording run dir.

        The session never produced a bag, so we must not leave a
        ``recorded/<run_id>/`` directory that downstream consumers would mistake
        for a recording. The failure is written to the sibling
        ``recorded/<run_id>.failed.json`` instead.
        """
        manifest = Manifest(
            run_id=run_id,
            state=RunState.failed,
            topics=self._topics,
            started_at=started_at,
            ended_at=utc_now_iso8601(),
            compression=request.compression,
            split=request.split,
            error=error,
        )
        try:
            write_failed_start_record(self._data_dir, manifest)
        except OSError:
            logger.exception("failed to write failed-start record")
        self._cleanup_qos_file(run_id)

    # -- metadata sync ------------------------------------------------------

    def _read_rosbag2_metadata(self, run_id: str) -> dict[str, Any] | None:
        """Parse the run's rosbag2 ``metadata.yaml`` if present."""
        path = run_dir(self._data_dir, run_id) / ROSBAG2_METADATA_FILENAME
        if not path.exists():
            return None
        try:
            raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError:
            logger.exception("failed to parse rosbag2 metadata")
            return None
        if isinstance(raw, dict):
            return raw.get("rosbag2_bagfile_information", raw)
        return None

    def _sync_topics_from_metadata(self, meta: dict[str, Any]) -> None:
        """Reconcile recorded topic names/types from rosbag2 metadata.

        For ``--all`` this is where the frozen topic list is populated; for an
        explicit list it backfills the message ``type`` per topic.
        """
        existing = {t.name: t for t in self._topics}
        topics_with_count = meta.get("topics_with_message_count") or []
        for item in topics_with_count:
            tmeta = (item or {}).get("topic_metadata") or {}
            name = tmeta.get("name")
            if not name:
                continue
            type_ = tmeta.get("type")
            if name in existing:
                existing[name].type = existing[name].type or type_
            else:
                existing[name] = TopicEntry(name=name, type=type_)
        self._topics = list(existing.values())

    @staticmethod
    def _message_count(meta: dict[str, Any]) -> int:
        """Extract the total message count from rosbag2 metadata, best-effort."""
        return int(meta.get("message_count") or 0)

    def _recorded_bytes(self, run_id: str) -> int:
        """Total size on disk of the run's recorded MCAP files.

        rosbag2's ``metadata.yaml`` ``files:`` entries do not carry a ``size``
        field in this storage format, so the on-disk size must be measured by
        stat'ing the actual bag files (covers split parts ``<run_id>_*.mcap``).
        """
        rd = run_dir(self._data_dir, run_id)
        if not rd.is_dir():
            return 0
        total = 0
        for mcap in rd.glob("*.mcap"):
            try:
                total += mcap.stat().st_size
            except OSError:
                continue
        return total

    # -- status / manifest --------------------------------------------------

    def status(self) -> RecordStatusResponse:
        with self._lock:
            return self._status_locked()

    def _status_locked(self) -> RecordStatusResponse:
        message_count, size = 0, 0
        if self._run_id is not None:
            meta = self._read_rosbag2_metadata(self._run_id)
            if meta is not None:
                message_count = self._message_count(meta)
            # bytes is the real on-disk size (metadata files[].size is absent).
            size = self._recorded_bytes(self._run_id)
        return RecordStatusResponse(
            state=self._state,
            run_id=self._run_id,
            started_at=self._started_at,
            message_count=message_count,
            bytes=size,
            topics=list(self._topics),
        )

    def _write_manifest(
        self, ended_at: str | None = None, error: str | None = None
    ) -> None:
        if self._run_id is None:
            return
        manifest = Manifest(
            run_id=self._run_id,
            state=self._state,
            topics=list(self._topics),
            started_at=self._started_at,
            ended_at=ended_at,
            compression=self._compression,
            split=self._split,
            error=error,
        )
        try:
            write_manifest(self._data_dir, manifest)
        except OSError:
            logger.exception("failed to write manifest")
        self._write_session(ended_at=ended_at)

    def _write_session(self, ended_at: str | None = None) -> None:
        """Write the run's ``session.json`` beside the MCAP (best-effort).

        Mirrors the manifest write points (start / stop / finalise) but is a
        small, self-contained record of who recorded what, plus the current
        topic list and counters. A failure here must not affect the recording.
        """
        if self._run_id is None:
            return
        meta = self._read_rosbag2_metadata(self._run_id)
        payload = {
            "run_id": self._run_id,
            "operator": self._operator,
            "task": self._task,
            "state": self._state.value,
            "started_at": self._started_at,
            "ended_at": ended_at,
            "topics": [t.name for t in self._topics],
            "message_count": self._message_count(meta) if meta is not None else 0,
            "bytes": self._recorded_bytes(self._run_id),
        }
        try:
            write_session(self._data_dir, self._run_id, payload)
        except OSError:
            logger.exception("failed to write session.json")

    def get_metadata(self) -> dict[str, Any]:
        """Return the last run's rosbag2 metadata + kairos manifest (404 if none)."""
        with self._lock:
            run_id = self._run_id
        if run_id is None:
            raise ApiError(
                status_code=404,
                code="no_recording",
                message="No recording has been made yet.",
            )
        manifest = read_manifest(self._data_dir, run_id)
        meta = self._read_rosbag2_metadata(run_id)
        return {
            "run_id": run_id,
            "manifest": manifest.model_dump(mode="json"),
            "rosbag2_metadata": meta,
            # Real on-disk total of the recorded MCAP files; the orchestrator
            # reads this (rosbag2 metadata files[].size is absent in this format).
            "bytes": self._recorded_bytes(run_id),
        }

    def reconcile_on_startup(self) -> None:
        """Mark any run left active by a previous process as ``interrupted``.

        Scans ``/data/recorded`` for manifests still in ``recording``/``stopping``
        (this process owns no subprocess for them) and rewrites them to
        ``interrupted`` so the audit trail reflects the crash/restart.
        """
        root = self._recorded_root()
        if not root.is_dir():
            return
        for child in sorted(root.iterdir()):
            if not child.is_dir():
                continue
            mpath = manifest_path(self._data_dir, child.name)
            if not mpath.exists():
                continue
            try:
                manifest = read_manifest(self._data_dir, child.name)
            except (ApiError, ValueError):
                continue
            if manifest.state in _ACTIVE_STATES:
                manifest.state = RunState.interrupted
                manifest.ended_at = manifest.ended_at or utc_now_iso8601()
                write_manifest(self._data_dir, manifest)
                logger.info(
                    "marked interrupted run",
                    extra={"run_id": child.name, "component": "recorder"},
                )
