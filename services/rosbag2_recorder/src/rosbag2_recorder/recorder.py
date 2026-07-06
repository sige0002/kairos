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
import re
import shutil
import signal
import subprocess
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import IO, Any

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
    RecordArming,
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

# `ros2 bag record` registers its node under this name; its pause/resume/
# is_paused services live at /<node>/... (rosbag2_interfaces). Used by the
# --start-paused readiness gate.
RECORDER_NODE_NAME = "rosbag2_recorder"
# How often the readiness gate polls the ROS graph for the recorder's
# subscriptions while it is paused.
SUBSCRIPTION_POLL_S = 0.2
# How long to wait for the recorder's resume/is_paused services to appear.
RESUME_SERVICE_TIMEOUT_S = 5.0

# States in which a session is actively holding (or finalising) the subprocess.
_ACTIVE_STATES = frozenset({RunState.recording, RunState.stopping})

# Session-metadata placeholders for a standalone recorder call. The orchestrator
# normalizes these (the dataset path is data/<operator>/<task>, so a null
# component is unkeyable), but the recorder must also default them so a direct
# /record/start writes a keyable session.json. Values match the orchestrator's
# (api_orchestrator/runs.py) so both paths yield the same placeholders.
_UNKNOWN_OPERATOR = "unknown_operator"
_UNKNOWN_TASK = "unknown_task"


def _default_meta(value: str | None, default: str) -> str:
    """Coerce an empty/whitespace metadata field to a stable placeholder."""
    return value.strip() if value and value.strip() else default


def _qos_overrides_path(recorded_root: Path, run_id: str) -> Path:
    """Path of the QoS overrides file (a sibling of the run dir)."""
    return recorded_root / f"{run_id}.qos.yaml"


def _mcap_storage_config_path(recorded_root: Path, run_id: str) -> Path:
    """Path of the MCAP storage-config file (a sibling of the run dir)."""
    return recorded_root / f"{run_id}.mcap-storage.yaml"


def _recorder_log_path(recorded_root: Path, run_id: str) -> Path:
    """Path of the recorder's captured stdout+stderr log (sibling of the run dir).

    Captured to a FILE (not a PIPE) so it can never stall the stop-time MCAP
    flush, and so finalise can scan it for rosbag2's cache-overflow drop report.
    A sibling because the run dir must not exist before ``ros2 bag record``
    creates it; finalise archives the log into the run dir afterwards.
    """
    return recorded_root / f"{run_id}.recorder.log"


# rosbag2's in-recorder MessageCache logs the messages it dropped on cache
# overflow at shutdown (MessageCache::log_dropped, WARN to stderr):
#   "Cache buffers lost messages per topic:\n\t<topic>: <n>\nTotal lost: <N>"
# Scanning the captured log for the total turns a silent in-recorder drop into a
# visible integrity signal (OpenLUTRA does not surface this at all).
_TOTAL_LOST_RE = re.compile(r"Total lost:\s*(\d+)")


# MCAP storage-plugin options for zstd compression. We use MCAP-native *chunk*
# compression (via --storage-config-file) rather than rosbag2 file-level
# compression (--compression-mode file): file-level produces a `<run>_0.mcap.zstd`
# that breaks every `*.mcap` glob + the MCAP reader (recorder bytes check, dora
# fast_validation/video_check/dataset_export/loss_report). Chunk compression keeps
# the output a normal `<run>_0.mcap` that the MCAP library transparently inflates,
# so all readers work unchanged. `Fastest` + noChunkCRC keeps live-record CPU low.
_MCAP_ZSTD_STORAGE_CONFIG = (
    "compression: Zstd\ncompressionLevel: Fastest\nnoChunkCRC: true\n"
)


def _iso8601_after(seconds: float) -> str:
    """ISO8601 (Z-suffixed, ms precision) *seconds* from now.

    Used for the arming auto-resume deadline (``resume_at``); the format matches
    ``kairos_common.utc_now_iso8601`` so timestamps are consistent across fields.
    """
    moment = datetime.now(UTC) + timedelta(seconds=seconds)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


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

        # Observational arming snapshot (OL-①.4): the --start-paused readiness
        # gate's matched vs missing target topics + auto-resume deadline. ``None``
        # when start_paused is off or no arming has run for this session. Mutated
        # only under ``self._lock`` (the readiness loop runs inside ``start``).
        self._arming: RecordArming | None = None

        # Recording-integrity fields. The recorder's stdout+stderr go to a per-run
        # log FILE (``_log_file``); at finalise we scan it for rosbag2's
        # cache-overflow drop count and classify the run's integrity.
        self._log_file: IO[bytes] | None = None
        self._pending_log_path: Path | None = None
        # Messages dropped by the in-recorder cache this run (rosbag2 "Total
        # lost"); ``None`` until known / when the log is unavailable.
        self._dropped_messages: int | None = None
        # Coarse classification: "ok" | "dropped" | "failed" | "unknown".
        self._integrity: str = "unknown"

    # -- preconditions ------------------------------------------------------

    def _recorded_root(self) -> Path:
        return self._data_dir / "recorded"

    @staticmethod
    def _make_host_writable(path: Path) -> None:
        """Relax *path* (a directory) to 0o777 so it is host-deletable.

        The recorder runs as root, so its ``recorded/`` root and per-run dirs are
        root-owned. Setting the directory mode to world-writable lets the host
        user — and the orchestrator's delete endpoint (uid 1000) — remove
        recordings without sudo. Deleting a file only needs write on its
        directory, so the bag files themselves need no mode change. Best-effort.
        """
        try:
            path.chmod(0o777)
        except OSError:
            logger.warning("could not relax permissions on %s", path)

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
            # Keep the recorded root host-deletable (so run dirs can be removed).
            self._make_host_writable(root)
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
        self._check_cache_ram()

    def _check_cache_ram(self) -> None:
        """Raise 507 if the configured record cache needs more RAM than is free.

        rosbag2 double-buffers the message cache, so worst-case memory is ~2x
        ``--max-cache-size``. We require that plus the disk safety margin to be
        available so a large cache can't OOM-kill the recorder mid-run. Skipped
        when the cache is unset (rosbag2 default) or free RAM can't be read.
        """
        cache_mb = self._max_cache_size_mb()
        if cache_mb <= 0:
            return
        need = 2 * cache_mb * 1024 * 1024 + MIN_FREE_BYTES
        avail = self._available_ram_bytes()
        if avail is not None and avail < need:
            raise ApiError(
                status_code=507,
                code="insufficient_memory",
                message="Not enough free RAM for the configured record cache.",
                details={
                    "required_bytes": need,
                    "available_bytes": avail,
                    "max_cache_size_mb": cache_mb,
                },
            )

    @staticmethod
    def _available_ram_bytes() -> int | None:
        """Free RAM in bytes from ``/proc/meminfo`` MemAvailable (None if absent)."""
        try:
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024
        except (OSError, ValueError, IndexError):
            return None
        return None

    # -- command construction ----------------------------------------------

    def _build_command(
        self,
        run_id: str,
        topics: list[str] | str,
        request: RecordStartRequest,
        qos_path: Path | None,
        storage_config_path: Path | None,
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
        if storage_config_path is not None:
            # MCAP-native chunk compression (zstd) — keeps the output a normal
            # `<run>_0.mcap` (see _MCAP_ZSTD_STORAGE_CONFIG). NOT rosbag2
            # --compression-mode file, which would emit an unreadable .mcap.zstd.
            cmd += ["--storage-config-file", str(storage_config_path)]
        if request.split is not None:
            if request.split.max_size_mb is not None:
                cmd += ["--max-bag-size", str(request.split.max_size_mb * 1024 * 1024)]
            if request.split.max_duration_s is not None:
                cmd += ["--max-bag-duration", str(request.split.max_duration_s)]
        if qos_path is not None:
            cmd += ["--qos-profile-overrides-path", str(qos_path)]
        cache_mb = self._max_cache_size_mb()
        if cache_mb > 0:
            # Larger in-recorder cache absorbs more burst before rosbag2 drops on
            # overflow (RecordingTuning.max_cache_size_mb). 0 keeps the rosbag2
            # default (100 MiB). Worst-case RAM ~2x (double buffering); preflighted.
            cmd += ["--max-cache-size", str(cache_mb * 1024 * 1024)]
        # We resume via the rosbag2 ~/resume SERVICE (see _arm_and_resume), never
        # the interactive SPACE key, so the keyboard handler is pure overhead and
        # an unwanted TTY dependency. Disable it unconditionally.
        cmd.append("--disable-keyboard-controls")
        if self._start_paused_enabled():
            # Start paused; we resume only after subscriptions are matched (see
            # _arm_and_resume), so the bag begins with no dropped first frames.
            cmd.append("--start-paused")
        if topics == "all":
            cmd += ["--all"]
        else:
            cmd += list(topics)
        return cmd

    def _start_paused_enabled(self) -> bool:
        """Whether to spawn paused + run the subscription-readiness gate."""
        return bool(self._config and self._config.recording.start_paused)

    def _max_cache_size_mb(self) -> int:
        """Configured rosbag2 ``--max-cache-size`` in MiB (0 = rosbag2 default)."""
        if self._config is None:
            return 0
        return self._config.recording.max_cache_size_mb

    def _spawn_process(self, cmd: list[str]) -> subprocess.Popen[bytes]:
        """Spawn *cmd* in a new process group (test seam).

        A new session/process group lets :meth:`stop` deliver SIGINT to the
        whole ``ros2 bag record`` tree (it spawns children), which is how
        rosbag2 flushes and writes ``metadata.yaml`` cleanly.

        stdout/stderr are redirected to a per-run log FILE (``_pending_log_path``,
        a sibling of the run dir), NOT a PIPE. A regular file has no fixed-size
        buffer, so — like inheriting to the container log — the recorder's
        stop-time cleanup-log burst can never fill a buffer and block the final
        MCAP flush (the pipe-stall failure mode, OL-①.3). Unlike inheriting, the
        file is then scannable at finalise for rosbag2's cache-overflow drop
        report ("Total lost: N"), turning a silent in-recorder drop into a visible
        integrity signal. The file is opened here and closed only after the
        process exits (in finalise/cleanup).
        """
        if self._pending_log_path is not None:
            self._pending_log_path.parent.mkdir(parents=True, exist_ok=True)
            self._log_file = self._pending_log_path.open("wb")
            return subprocess.Popen(
                cmd,
                start_new_session=True,
                stdout=self._log_file,
                stderr=subprocess.STDOUT,
            )
        # No log path set (e.g. a caller that opted out): fall back to inheriting.
        return subprocess.Popen(cmd, start_new_session=True)

    # -- lifecycle ----------------------------------------------------------

    def _raise_if_active(self) -> None:
        """Raise 409 if a session is already recording/stopping (lock held)."""
        if self._state in _ACTIVE_STATES:
            raise ApiError(
                status_code=409,
                code="already_recording",
                message="A recording session is already active.",
                details={"run_id": self._run_id, "state": self._state.value},
            )

    def start(self, request: RecordStartRequest) -> RecordStatusResponse:
        """Start a recording session; raise 409 if one is already active."""
        run_id = validate_run_id(request.run_id)
        with self._lock:
            self._raise_if_active()
            self._check_writable_and_space()

        # Let drivers/cameras ramp up so they are publishing before recording
        # begins (RECORDING_CONFIG recording.start_delay_s). Done OUTSIDE the
        # lock so GET /record/status is not blocked for the whole delay; the
        # active state is re-checked after re-acquiring (the orchestrator also
        # serializes starts, so a concurrent start is already unlikely).
        self._apply_start_delay()

        with self._lock:
            self._raise_if_active()

            topics = request.topics
            # Freeze the topic selection. For an explicit list we record each
            # name now; "all" is expanded by rosbag2 at the DDS layer and
            # reconciled from metadata.yaml at finalise time. Staged in a local
            # and committed to self._topics only on success, so a failed start
            # cannot leave the previous run's status carrying these topics.
            selected = list(topics) if topics != "all" else []
            staged_topics = [
                TopicEntry(name=name, qos=self._resolve_qos(name, request))
                for name in selected
            ]

            # The QoS file is a sibling of the run dir; the run dir itself must
            # NOT exist before spawn (ros2 bag record refuses a pre-existing
            # --output). So nothing here may create run_dir(run_id).
            qos_path = self._materialise_qos(run_id, selected, request)
            storage_config_path = self._materialise_storage_config(run_id, request)
            cmd = self._build_command(
                run_id, topics, request, qos_path, storage_config_path
            )

            # Fresh integrity state for this attempt; _spawn_process captures the
            # recorder's stdout+stderr here so finalise can scan it for drops.
            self._dropped_messages = None
            self._integrity = "unknown"
            self._pending_log_path = _recorder_log_path(self._recorded_root(), run_id)

            started_at = utc_now_iso8601()
            try:
                process = self._spawn_process(cmd)
            except (OSError, ValueError) as exc:
                self._fail(run_id, started_at, request, staged_topics, str(exc))
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
                    staged_topics,
                    f"ros2 bag record did not create the output dir (rc={returncode})",
                )
                raise ApiError(
                    status_code=507,
                    code="record_start_failed",
                    message="The recording process failed to start.",
                    details={"run_id": run_id, "returncode": returncode},
                )

            # The bag process is up. When spawned --start-paused it is now
            # waiting paused: bring subscriptions live, then resume — so the bag
            # begins with all topics subscribed (no dropped first frames during
            # DDS discovery). FAIL-SAFE: any failure here must NOT leave a paused
            # recorder silently capturing nothing — kill it and fail the start.
            # Reset the arming snapshot for this attempt; populated below only
            # when the --start-paused readiness gate actually runs.
            self._arming = None
            if self._start_paused_enabled():
                try:
                    self._arm_and_resume(run_id, selected, topics == "all")
                except Exception as exc:  # noqa: BLE001 - convert to a clean fail
                    self._terminate_failed_start(process)
                    shutil.rmtree(run_dir(self._data_dir, run_id), ignore_errors=True)
                    # Drop the partial arming snapshot; this session never started.
                    self._arming = None
                    self._fail(
                        run_id, started_at, request, staged_topics, f"arming: {exc}"
                    )
                    raise ApiError(
                        status_code=507,
                        code="record_arm_failed",
                        message="Recording failed to arm (subscribe + resume).",
                        details={"run_id": run_id, "error": str(exc)},
                    ) from exc

            self._process = process
            self._state = RunState.recording
            self._run_id = run_id
            # Stamp the session at the moment capture actually begins (the bag
            # process is up and, when armed, resumed) — NOT the pre-spawn
            # `started_at` above, which is seconds earlier (start_delay + spawn
            # + arming). The UI elapsed timer and the manifest measure the bag,
            # not the start overhead; the pre-spawn stamp stays for _fail().
            self._started_at = utc_now_iso8601()
            self._compression = request.compression
            self._split = request.split
            # Default operator/task so a standalone recorder call (no orchestrator
            # to normalize them) still writes a keyable session.json.
            self._operator = _default_meta(request.operator, _UNKNOWN_OPERATOR)
            self._task = _default_meta(request.task, _UNKNOWN_TASK)
            self._topics = staged_topics
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

    def _apply_post_discovery_delay(self) -> None:
        """Sleep ``recording.post_discovery_delay_s`` after subscriptions are
        established and before resuming (OL-①.2). No-op without a config or when 0."""
        if self._config is None:
            return
        delay = self._config.recording.post_discovery_delay_s
        if delay > 0:
            time.sleep(delay)

    # -- start-paused readiness gate (A+B) ---------------------------------

    def _arm_and_resume(self, run_id: str, topics: list[str], all_mode: bool) -> None:
        """Wait until ``ros2 bag record`` has subscribed to the target topics,
        then resume it (it was spawned ``--start-paused``).

        Raises on any hard failure so the caller fails the start rather than
        leaving a paused recorder capturing nothing. rclpy + rosbag2_interfaces
        are imported lazily so the module imports without ROS; the live path runs
        in the ROS image (verified in Docker, like the monitor's rclpy paths).
        """
        import rclpy
        from rclpy.node import Node
        from rosbag2_interfaces.srv import IsPaused, Resume

        timeout = (
            self._config.recording.subscription_ready_timeout_s
            if self._config is not None
            else 5.0
        )
        # Seed the observational arming snapshot: active while we wait, with the
        # auto-resume deadline (now + timeout) and every target still "missing"
        # until the readiness poll confirms a subscription (OL-①.4).
        self._arming = RecordArming(
            active=True,
            matched_topics=[],
            missing_topics=list(topics),
            resume_at=_iso8601_after(timeout),
        )
        owns_rclpy = not rclpy.ok()
        if owns_rclpy:
            rclpy.init()
        node = Node("kairos_recorder_arming")
        try:
            self._await_recorder_subscribed(rclpy, node, topics, all_mode, timeout)
            # Settle time after subscriptions matched, before resume, so the bag
            # opens past sensor/camera ramp-up rather than on warm-up frames (OL-①.2).
            self._apply_post_discovery_delay()
            self._resume_recorder(rclpy, node, Resume, IsPaused)
            # Resumed: no longer waiting. Keep the final matched/missing snapshot
            # (a non-empty ``missing`` means the gate timed out and resumed anyway).
            if self._arming is not None:
                self._arming.active = False
            logger.info("recording armed + resumed", extra={"run_id": run_id})
        finally:
            node.destroy_node()
            if owns_rclpy:
                rclpy.shutdown()

    def _readiness_targets(
        self, node: Any, topics: list[str], all_mode: bool
    ) -> list[str]:
        """Topics the readiness gate waits on: the explicit list, or (for
        ``--all``) every currently-published topic at this instant."""
        if not all_mode:
            return list(topics)
        return [
            name
            for name, _types in node.get_topic_names_and_types()
            if node.count_publishers(name) > 0
        ]

    def _recorder_subscribed(self, node: Any, topic: str) -> bool:
        """True once a publisher exists AND the recorder node has subscribed."""
        if node.count_publishers(topic) == 0:
            return False
        return any(
            info.node_name == RECORDER_NODE_NAME
            for info in node.get_subscriptions_info_by_topic(topic)
        )

    def _await_recorder_subscribed(
        self,
        rclpy_mod: Any,
        node: Any,
        topics: list[str],
        all_mode: bool,
        timeout: float,
    ) -> None:
        """Poll the ROS graph until the recorder has subscribed to every target
        topic that has a publisher, or until *timeout* (then resume anyway).

        Each poll refreshes the observational arming snapshot (matched vs missing)
        so the state reflects the latest readiness view (OL-①.4)."""
        deadline = time.monotonic() + timeout
        while True:
            rclpy_mod.spin_once(node, timeout_sec=SUBSCRIPTION_POLL_S)
            targets = self._readiness_targets(node, topics, all_mode)
            subscribed = {t: self._recorder_subscribed(node, t) for t in targets}
            matched = [t for t, ok in subscribed.items() if ok]
            pending = [t for t, ok in subscribed.items() if not ok]
            self._update_arming(matched, pending)
            if targets and not pending:
                return
            if time.monotonic() >= deadline:
                if pending:
                    logger.warning(
                        "arming timed out; resuming with topics not yet matched",
                        extra={"pending_topics": pending},
                    )
                return

    def _update_arming(self, matched: list[str], missing: list[str]) -> None:
        """Refresh the observational arming snapshot's matched/missing lists.

        Called from each readiness poll (under ``self._lock``). Purely
        observational: it never affects subscription timing or the resume path.
        """
        if self._arming is not None:
            self._arming.matched_topics = matched
            self._arming.missing_topics = missing

    def _resume_recorder(
        self, rclpy_mod: Any, node: Any, resume_srv: Any, is_paused_srv: Any
    ) -> None:
        """Call the recorder's ``~/resume`` service and confirm it is no longer
        paused. Raises if the service is missing or it stays paused."""
        resume = node.create_client(resume_srv, f"/{RECORDER_NODE_NAME}/resume")
        if not resume.wait_for_service(timeout_sec=RESUME_SERVICE_TIMEOUT_S):
            raise RuntimeError("recorder resume service did not appear")
        fut = resume.call_async(resume_srv.Request())
        rclpy_mod.spin_until_future_complete(
            node, fut, timeout_sec=RESUME_SERVICE_TIMEOUT_S
        )
        if fut.result() is None:
            raise RuntimeError("recorder resume call did not return")
        # Confirm it actually resumed (fail-safe against a silent paused bag).
        is_paused = node.create_client(
            is_paused_srv, f"/{RECORDER_NODE_NAME}/is_paused"
        )
        if is_paused.wait_for_service(timeout_sec=2.0):
            f2 = is_paused.call_async(is_paused_srv.Request())
            rclpy_mod.spin_until_future_complete(node, f2, timeout_sec=3.0)
            res = f2.result()
            if res is not None and getattr(res, "paused", False):
                raise RuntimeError("recorder still paused after resume")

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

    def _materialise_storage_config(
        self, run_id: str, request: RecordStartRequest
    ) -> Path | None:
        """Write the MCAP storage-config file for zstd compression, if requested.

        Like the QoS file, it is a *sibling* of the run dir (the run dir itself
        must not exist before ``ros2 bag record`` creates it). Returns ``None``
        when compression is off (no file written, normal uncompressed record).
        """
        if request.compression is not Compression.zstd:
            return None
        path = _mcap_storage_config_path(self._recorded_root(), run_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_MCAP_ZSTD_STORAGE_CONFIG, encoding="utf-8")
        return path

    def _cleanup_storage_config(self, run_id: str) -> None:
        """Remove the run's MCAP storage-config sibling file if it was written."""
        _mcap_storage_config_path(self._recorded_root(), run_id).unlink(missing_ok=True)

    # -- recording integrity (cache-overflow drop detection) ----------------

    def _close_log_file(self) -> None:
        """Close the captured stdout+stderr log handle (call after exit only).

        Like OpenLUTRA's pty master, the recorder's log fd must stay open for the
        whole run and be closed only after the process exits; closing it early
        could disrupt the still-writing recorder.
        """
        if self._log_file is not None:
            try:
                self._log_file.close()
            except OSError:
                pass
            self._log_file = None

    def _scan_dropped_messages(self, run_id: str | None) -> int | None:
        """Messages the in-recorder cache dropped this run, from the captured log.

        rosbag2 logs ``Total lost: N`` once at shutdown when its MessageCache
        overflowed. Returns that N, ``0`` when the log exists with no such line
        (no overflow), or ``None`` when the log is unavailable/unreadable (drop
        count unknown — e.g. a stubbed spawn in unit tests).
        """
        if not run_id:
            return None
        path = _recorder_log_path(self._recorded_root(), run_id)
        try:
            text = path.read_text(errors="replace")
        except OSError:
            return None
        # One report per run (at shutdown); take the last match to be safe.
        matches = _TOTAL_LOST_RE.findall(text)
        return int(matches[-1]) if matches else 0

    def _classify_integrity(self) -> str:
        """Classify recording integrity from state + cache-drop count.

        ``failed`` if the run failed; otherwise ``unknown`` when the drop count
        could not be determined, ``dropped`` when the cache lost >0 messages, and
        ``ok`` when a readable log reported no overflow.
        """
        if self._state is RunState.failed:
            return "failed"
        if self._dropped_messages is None:
            return "unknown"
        return "dropped" if self._dropped_messages > 0 else "ok"

    def _archive_log(self, run_id: str | None) -> None:
        """Move the sibling recorder log into the run dir (best-effort).

        Done at finalise (the run dir now exists) so the recorder's own log ships
        beside the bag for audit. A missing sibling (stubbed spawn) is a no-op.
        """
        if not run_id:
            return
        src = _recorder_log_path(self._recorded_root(), run_id)
        dst = run_dir(self._data_dir, run_id) / "recorder.log"
        try:
            if src.exists():
                src.replace(dst)
        except OSError:
            logger.warning("could not archive recorder log for %s", run_id)

    def _cleanup_log_file(self, run_id: str | None) -> None:
        """Close the log handle and drop the sibling log (failed-start paths)."""
        self._close_log_file()
        if run_id:
            _recorder_log_path(self._recorded_root(), run_id).unlink(missing_ok=True)

    def stop(self) -> RecordStatusResponse:
        """Stop the active session (idempotent).

        Recording -> SIGINT the process group, wait, finalise, return the
        terminal status. Any other state — idle, or a stop already in progress
        (``stopping``) — returns the current status unchanged.
        """
        # Signal the size watcher to stop polling up front so it does not race
        # us into a second stop. (Safe if we ARE the watcher thread.)
        self._watcher_stop.set()
        with self._lock:
            # Only a live ``recording`` session transitions to ``stopping``.
            # Gating on ``recording`` (not ``_ACTIVE_STATES``, which includes
            # ``stopping``) makes the transition atomic, so a concurrent second
            # stop — size-watcher vs user, or two HTTP calls now that the routes
            # run in Starlette's thread pool — cannot re-SIGINT and re-finalise
            # the same process. That second finalise would see ``returncode=None``
            # and turn a clean ``completed`` run into ``failed``. finalise runs
            # exactly once, for the caller that won this transition.
            if self._state is not RunState.recording or self._process is None:
                return self._status_locked()

            self._state = RunState.stopping
            # Capture-end stamp: the session ends at the operator's stop
            # decision, HERE — not after the SIGINT flush below, which keeps
            # running (and briefly writing already-queued messages) for however
            # long rosbag2 takes to drain (seconds under load / SIGTERM
            # escalation). Stamping after the wait made ended_at - started_at
            # read longer than the session the UI timer showed; the bag's own
            # metadata.yaml keeps the exact data span.
            ended_at = utc_now_iso8601()
            self._write_manifest()
            process = self._process

        # Signal + wait outside the lock so /status stays responsive; the single
        # active session means no other start can race in (start re-checks state).
        self._signal_and_wait(process)

        with self._lock:
            self._finalise(ended_at)
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

    def _finalise(self, ended_at: str | None = None) -> None:
        """Move from ``stopping`` to a terminal state, syncing from metadata.

        ``completed`` requires BOTH a clean shutdown return code AND a written
        ``metadata.yaml``. Metadata presence alone is not enough: an abnormal
        exit (disk full, partial write, rosbag2 crash, SIGTERM escalation) can
        leave a stale/partial metadata.yaml, which must be reported ``failed``.

        *ended_at* is the capture-end stamp taken when the stop was DECIDED
        (see :meth:`stop`); falling back to now() here would silently re-add
        the SIGINT flush time to the session length.
        """
        run_id = self._run_id
        process = self._process
        returncode = process.returncode if process is not None else None
        ended_at = ended_at or utc_now_iso8601()

        meta = self._read_rosbag2_metadata(run_id) if run_id else None
        clean_exit = returncode in _CLEAN_STOP_RETURNCODES
        # Stop-time verification (OL-①.3): a flushed bag has its MCAP data on disk.
        mcap_present = bool(run_id) and self._recorded_bytes(run_id) > 0
        if meta is not None and clean_exit and mcap_present:
            self._sync_topics_from_metadata(meta)
            self._state = RunState.completed
            # A MAX_RECORD_BYTES auto-stop is a *successful* completion at the
            # cap; record why it ended in the note field (no error occurred).
            error = self._auto_stop_reason
        else:
            self._state = RunState.failed
            if meta is None:
                error = f"recording produced no metadata.yaml (rc={returncode})"
            elif not mcap_present:
                # Clean metadata but no MCAP data flushed: the bag is empty/lost.
                self._sync_topics_from_metadata(meta)
                error = "recording produced metadata but no MCAP data file"
            else:
                # Have metadata but the process did not shut down cleanly: still
                # sync what we can for the audit record, but mark the run failed.
                self._sync_topics_from_metadata(meta)
                error = f"recording ended abnormally (rc={returncode})"

        self._process = None
        self._auto_stop_reason = None
        # Recording integrity: the process has exited, so close the captured log,
        # scan it for rosbag2's in-recorder cache-overflow drop count, and classify
        # the run (a clean run that still dropped messages is completed but
        # integrity="dropped" — the bag is missing data the cache could not hold).
        self._close_log_file()
        self._dropped_messages = self._scan_dropped_messages(run_id)
        self._integrity = self._classify_integrity()
        self._write_manifest(ended_at=ended_at, error=error)
        if run_id:
            self._cleanup_qos_file(run_id)
            self._cleanup_storage_config(run_id)
            self._archive_log(run_id)
        logger.info(
            "recording finalised",
            extra={
                "run_id": run_id,
                "component": "recorder",
                "integrity": self._integrity,
                "dropped_messages": self._dropped_messages,
            },
        )

    def _fail(
        self,
        run_id: str,
        started_at: str,
        request: RecordStartRequest,
        topics: list[TopicEntry],
        error: str,
    ) -> None:
        """Record a START failure WITHOUT creating a recording run dir.

        The session never produced a bag, so we must not leave a
        ``recorded/<run_id>/`` directory that downstream consumers would mistake
        for a recording. The failure is written to the sibling
        ``recorded/<run_id>.failed.json`` instead. ``topics`` is the staged
        selection for this failed attempt (NOT ``self._topics``, which still
        reflects the previous session).
        """
        manifest = Manifest(
            run_id=run_id,
            state=RunState.failed,
            topics=topics,
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
        self._cleanup_storage_config(run_id)
        self._cleanup_log_file(run_id)

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
            # Final/last arming snapshot for this session (``None`` when the
            # --start-paused gate did not run). Copied so a later session's
            # in-place updates cannot mutate an already-returned status.
            arming=self._arming.model_copy(deep=True) if self._arming else None,
            dropped_messages=self._dropped_messages,
            integrity=self._integrity,
        )

    def _write_manifest(
        self, ended_at: str | None = None, error: str | None = None
    ) -> None:
        if self._run_id is None:
            return
        meta = self._read_rosbag2_metadata(self._run_id)
        manifest = Manifest(
            run_id=self._run_id,
            state=self._state,
            topics=list(self._topics),
            started_at=self._started_at,
            ended_at=ended_at,
            compression=self._compression,
            split=self._split,
            # Finalised counters (OL-①.5): None until the bag's metadata exists.
            message_count=self._message_count(meta) if meta is not None else None,
            bytes=self._recorded_bytes(self._run_id),
            error=error,
            dropped_messages=self._dropped_messages,
            integrity=self._integrity,
        )
        try:
            write_manifest(self._data_dir, manifest)
        except OSError:
            logger.exception("failed to write manifest")
        self._write_session(ended_at=ended_at)
        # Keep the run dir host-deletable (root container -> host user / UI).
        self._make_host_writable(run_dir(self._data_dir, self._run_id))

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
