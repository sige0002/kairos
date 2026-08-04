"""The recording session manager: one ``ros2 bag record`` subprocess at a time.

This is the recorder's core. It owns a single recording session (1 container =
1 session, per the spec), spawns ``ros2 bag record`` in its own process group,
tracks the run state, and finalises by parsing the rosbag2 ``metadata.yaml``.

The subprocess spawn is isolated behind :meth:`RecorderSession._spawn_process`
so unit tests can patch it and exercise the full state machine without ROS 2
installed. The integration path (real ``ros2 bag record``) runs in Docker.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, replace
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
from kairos_common.capture_sidecars import (
    ROSBAG2_METADATA_FILENAME,
    UNFINALIZED_STATES,
    CaptureState,
    DigestState,
    ObjectManifestV2,
    SidecarStatus,
    capture_dir,
    incoming_dir,
    objects_dir,
    read_object_manifest,
    trash_dir,
    write_failed_start,
    write_object_manifest,
)
from kairos_common.ids import is_uuid7, new_capture_id
from kairos_common.instance import load_or_create_instance

# Imported for exactly one predicate, deliberately: "does this capture hold data"
# decides ``interrupted`` vs ``failed`` in BOTH finalise and the orchestrator's
# rebuild, and the two must never drift apart (§8 rule 2). Nothing here waits on
# a rebuild — §9-5 forbids that, and this is a pure function over a directory.
from kairos_common.rebuild import has_bag

from rosbag2_recorder.models import (
    QosProfile,
    RecordArming,
    RecordPrepareResponse,
    RecordStartRequest,
    RecordStatusResponse,
    RunState,
    SplitConfig,
    TopicEntry,
    validate_run_id,
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

# Terminal states that mean the recording did not end the way it was asked to.
_BROKEN_STATES = frozenset({RunState.failed, RunState.interrupted})

# Session-metadata placeholders for a standalone recorder call. Since v2 the
# operator/task no longer key a path, but they still must not be null on a
# RECORDED capture: §3.3 gives null operator/task a meaning of its own — the
# capture was imported, not recorded here — so a direct /record/start with no
# metadata has to say "recorded by nobody in particular", not "imported".
# Values match the orchestrator's so both paths yield the same placeholders.
_UNKNOWN_OPERATOR = "unknown_operator"
_UNKNOWN_TASK = "unknown_task"


def _default_meta(value: str | None, default: str) -> str:
    """Coerce an empty/whitespace metadata field to a stable placeholder."""
    return value.strip() if value and value.strip() else default


def _qos_overrides_path(objects_root: Path, capture_id: str) -> Path:
    """Path of the QoS overrides file (a sibling of the capture dir)."""
    return objects_root / f"{capture_id}.qos.yaml"


def _mcap_storage_config_path(objects_root: Path, capture_id: str) -> Path:
    """Path of the MCAP storage-config file (a sibling of the capture dir)."""
    return objects_root / f"{capture_id}.mcap-storage.yaml"


def _recorder_log_path(objects_root: Path, capture_id: str) -> Path:
    """The recorder's captured stdout+stderr log (sibling of the capture dir).

    Captured to a FILE (not a PIPE) so it can never stall the stop-time MCAP
    flush, and so finalise can scan it for rosbag2's cache-overflow drop report.
    A sibling because the capture dir must not exist before ``ros2 bag record``
    creates it; finalise archives the log into the capture dir afterwards.
    """
    return objects_root / f"{capture_id}.recorder.log"


# The recorder's own log, once archived into the capture directory it belongs to.
RECORDER_LOG_FILENAME = "recorder.log"

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
# fast_validation/video_check/loss_report). Chunk compression keeps
# the output a normal `<run>_0.mcap` that the MCAP library transparently inflates,
# so all readers work unchanged. `Fastest` + noChunkCRC keeps live-record CPU low.
_MCAP_ZSTD_STORAGE_CONFIG = (
    "compression: Zstd\ncompressionLevel: Fastest\nnoChunkCRC: true\n"
)


def _iso8601_of(moment: datetime) -> str:
    """Format *moment* the way every other kairos timestamp is written.

    Matches ``kairos_common.utc_now_iso8601`` (Z-suffixed, ms precision) so a
    stamp recovered from a file's mtime is indistinguishable in shape from one
    the recorder wrote live — these end up in the same manifest fields.
    """
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def _iso8601_after(seconds: float) -> str:
    """ISO8601 (Z-suffixed, ms precision) *seconds* from now.

    Used for the arming auto-resume deadline (``resume_at``).
    """
    return _iso8601_of(datetime.now(UTC) + timedelta(seconds=seconds))


def _normalise_topics(topics: list[str] | str) -> list[str] | str:
    """Normalise a topic selection for armed-session match comparison.

    ``"all"`` only ever matches ``"all"`` (never an equivalent explicit list —
    the live topic set at prepare time is not necessarily the live set at
    start time). An explicit list matches order-insensitively (sorted).
    """
    if topics == "all":
        return "all"
    return sorted(topics)


@dataclass
class _Armed:
    """Everything held while ``state is RunState.armed`` (two-phase start).

    Populated once by :meth:`RecorderSession.prepare` and consumed exactly
    once — either by :meth:`RecorderSession._start_from_armed` (a matching
    ``start()``, which promotes these fields onto the session and commits) or
    torn down by :meth:`RecorderSession._disarm_locked` (auto-disarm timeout,
    ``stop()`` while armed, a mismatching ``start()``, or a re-``prepare()``).

    ``generation`` is a per-arm identity token: the auto-disarm
    :class:`threading.Timer` captures it when created, and its callback
    re-checks — under the lock — that the session is still armed AND still
    this same generation before disarming. That closes the ABA race where
    disarm -> re-prepare happens between the timer firing and the callback
    acquiring the lock, which would otherwise let a stale timer tear down an
    unrelated, later armed session.
    """

    generation: int
    run_id: str
    # Minted at prepare (§1). The paused subprocess is already writing into
    # objects/<capture_id>/, so this — unlike run_id — is fixed for good: a
    # matching start() commits under it, a disarm throws it (and the dir) away.
    capture_id: str
    # The PREPARE request: used to decide whether a later start() "matches"
    # (spawn-affecting fields only — see RecorderSession._armed_matches).
    request: RecordStartRequest
    staged_topics: list[TopicEntry]
    # Pre-spawn timestamp (for a failed-start record if arming/resume fails).
    started_at: str
    # State to restore on disarm — whatever self._state was before prepare()
    # armed it (created / completed / failed / interrupted), so disarming
    # does not erase visibility of a genuinely-completed previous run.
    previous_state: RunState
    process: subprocess.Popen[bytes]
    qos_path: Path | None
    storage_config_path: Path | None
    pending_log_path: Path | None
    log_file: IO[bytes] | None
    # rclpy Node + matched Resume/IsPaused clients, kept ALIVE across
    # prepare() -> start() so the fast start() path pays no DDS-participant or
    # service-discovery cost (recreating them would defeat the entire point).
    node: Any
    resume_client: Any
    is_paused_client: Any
    owns_rclpy: bool
    disarm_at: str
    timer: threading.Timer | None = None


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
        # This installation's identity (§1), stamped into every manifest we
        # write. Minted on first start of any service and never regenerated; a
        # corrupt instance.json raises here rather than inventing a second
        # identity for a data_dir that already has one.
        self._instance_id = load_or_create_instance(self._data_dir).instance_id

        # Current-session fields. ``state`` is the single source of truth for
        # whether a session is active; the rest are only meaningful while one is.
        self._state: RunState = RunState.created
        self._run_id: str | None = None
        # The capture the session is (or last was) recording. Minted at prepare
        # or at start, and the only key that resolves to bytes on disk.
        self._capture_id: str | None = None
        self._started_at: str | None = None
        self._compression: Compression = Compression.none
        self._split: SplitConfig | None = None
        self._topics: list[TopicEntry] = []
        self._process: subprocess.Popen[bytes] | None = None
        # Optional session metadata (written to the capture's manifest).
        self._operator: str | None = None
        # Two-host provenance for the live session (rides manifest `extra`).
        self._stamp: dict[str, Any] | None = None
        self._task: str | None = None
        self._robot: str | None = None

        # MAX_RECORD_BYTES auto-stop watcher. 0 disables (default).
        self._max_record_bytes: int = settings.max_record_bytes
        self._max_record_seconds: int = settings.max_record_seconds
        self._size_watcher: threading.Thread | None = None
        self._watcher_stop = threading.Event()
        # Reason for a pending auto-stop, surfaced in the manifest error.
        self._auto_stop_reason: str | None = None

        # Observational arming snapshot (OL-①.4): the --start-paused readiness
        # gate's matched vs missing target topics + auto-resume deadline. ``None``
        # when start_paused is off or no arming has run for this session. Mutated
        # only under ``self._lock`` (the readiness loop runs inside ``start``).
        self._arming: RecordArming | None = None

        # Two-phase start (prepare -> resume): the current armed session, if
        # ``self._state is RunState.armed``; otherwise ``None``. See ``prepare()``,
        # ``_start_from_armed()``, ``_disarm_locked()``.
        self._armed: _Armed | None = None
        # Monotonic identity counter for armed sessions (see `_Armed.generation`).
        self._armed_generation: int = 0

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

    def _objects_root(self) -> Path:
        """``<data_dir>/objects`` — where every capture directory lives (§2)."""
        return objects_dir(self._data_dir)

    def _capture_dir(self, capture_id: str) -> Path:
        """``<data_dir>/objects/<capture_id>`` — one capture's bytes."""
        return capture_dir(self._data_dir, capture_id)

    @staticmethod
    def _make_host_writable(path: Path) -> None:
        """Relax *path* (a directory) to 0o777 so it is host-deletable.

        The recorder runs as root, so the roots it creates and the per-capture
        dirs are root-owned. Setting the directory mode to world-writable lets
        the host user — and the orchestrator (uid 1000) — move a capture into
        ``.trash`` and remove it without sudo. Deleting or renaming a file only
        needs write on its directory, so the bag files themselves need no mode
        change. Best-effort.
        """
        try:
            path.chmod(0o777)
        except OSError:
            logger.warning("could not relax permissions on %s", path)

    def ensure_ready(self) -> None:
        """Raise if the recorder cannot serve recordings (readiness probe).

        Readiness == the objects root is writable with enough free space.
        Reuses the same check ``start`` runs so /readyz predicts start success.
        """
        self._check_writable_and_space()

    def _check_writable_and_space(self) -> None:
        """Raise 507 if ``/data/objects`` is not writable or space is low.

        Also creates ``.trash/`` and ``.incoming/``. The recorder is the only
        service running as root, so it is the only one that can hand uid 1000 a
        writable root. ``.trash`` is where the orchestrator renames captures on
        delete (§7 step 3) and ``.incoming`` is where imports are staged before
        their ``os.replace`` into ``objects/`` (§2); a root-owned one of either
        would fail at runtime, on the operator's delete or import, rather than
        here at startup. Creating all three side by side is also what makes
        them same-filesystem by construction, which those renames require.
        """
        root = self._objects_root()
        try:
            root.mkdir(parents=True, exist_ok=True)
            # Keep the objects root host-writable (so capture dirs can be moved
            # to .trash and removed) — §2.
            self._make_host_writable(root)
            for sibling_root in (
                trash_dir(self._data_dir),
                incoming_dir(self._data_dir),
            ):
                sibling_root.mkdir(parents=True, exist_ok=True)
                self._make_host_writable(sibling_root)
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
        capture_id: str,
        topics: list[str] | str,
        request: RecordStartRequest,
        qos_path: Path | None,
        storage_config_path: Path | None,
        *,
        force_paused: bool = False,
    ) -> list[str]:
        """Assemble the ``ros2 bag record`` argv for this run.

        ``--output`` is the capture directory; rosbag2 derives the bag files'
        names from its basename, so they come out ``<capture_id>_*.mcap``
        alongside ``metadata.yaml``. ``force_paused`` always adds
        ``--start-paused`` regardless of ``recording.start_paused`` (used by
        ``prepare()``: arming without pausing first would begin writing
        immediately, defeating the whole point of two-phase start).
        """
        out = self._capture_dir(capture_id)
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
        if force_paused or self._start_paused_enabled():
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

    def _prepare_disarm_timeout_s(self) -> float:
        """Auto-disarm timeout for an unclaimed ``armed`` session (two-phase start)."""
        if self._config is None:
            return 120.0
        return self._config.recording.prepare_disarm_timeout_s

    def _spawn_process(self, cmd: list[str]) -> subprocess.Popen[bytes]:
        """Spawn *cmd* in a new process group (test seam).

        A new session/process group lets :meth:`stop` deliver SIGINT to the
        whole ``ros2 bag record`` tree (it spawns children), which is how
        rosbag2 flushes and writes ``metadata.yaml`` cleanly.

        stdout/stderr are redirected to a per-run log FILE (``_pending_log_path``,
        a sibling of the capture dir), NOT a PIPE. A regular file has no fixed-size
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

    # -- two-phase start (prepare -> resume) ---------------------------------

    def prepare(self, request: RecordStartRequest) -> RecordPrepareResponse:
        """Spawn ``ros2 bag record --start-paused`` and wait for subscription
        match, parking the session ``armed`` — waiting for a later ``start()``.

        Pays today's full spawn + DDS-discovery/subscription-match cost, but
        BEFORE the operator's actual start action, so a later matching
        ``start()`` is just a near-instant resume call. Raises 409 if a
        session is already recording/stopping. If a session is already
        ``armed``, last-wins: the old one is disarmed before this one arms
        (mirrors ``start()``'s single-active-session model — there is only
        ever at most one armed session, same as at most one recording one).
        """
        run_id = validate_run_id(request.run_id)
        with self._lock:
            self._raise_if_active()
            self._check_writable_and_space()
            if self._state is RunState.armed:
                if self._armed is not None and self._armed_matches(
                    self._armed, request
                ):
                    # Keep-alive: a matching re-prepare only extends the
                    # auto-disarm deadline — no kill/respawn churn (see
                    # _extend_armed_locked). The caller-allocated run_id is
                    # discarded; the response carries the armed session's.
                    return self._extend_armed_locked()
                logger.info(
                    "re-preparing while already armed; disarming the old session",
                    extra={"component": "recorder"},
                )
                self._disarm_locked()

        # Same pre-spawn ramp-up delay as start() (config-driven); done OUTSIDE
        # the lock so /record/status stays responsive for the whole wait.
        self._apply_start_delay()

        with self._lock:
            self._raise_if_active()
            if self._state is RunState.armed:
                # A concurrent prepare() could have armed a session while we
                # slept above. A matching one is extended (same keep-alive
                # semantics as above); otherwise last-wins here too.
                if self._armed is not None and self._armed_matches(
                    self._armed, request
                ):
                    return self._extend_armed_locked()
                self._disarm_locked()
            previous_state = self._state

            topics = request.topics
            selected = list(topics) if topics != "all" else []
            staged_topics = [
                TopicEntry(name=name, qos=self._resolve_qos(name, request))
                for name in selected
            ]
            # The capture's identity is minted HERE, not at start: the
            # subprocess spawned below immediately owns objects/<capture_id>/,
            # so the id has to exist before the spawn (§1).
            capture_id = new_capture_id()
            qos_path = self._materialise_qos(capture_id, selected, request)
            storage_config_path = self._materialise_storage_config(capture_id, request)
            # ALWAYS spawn --start-paused here, regardless of recording.
            # start_paused: arming without pausing first would begin writing
            # immediately, defeating the whole point of two-phase start.
            cmd = self._build_command(
                capture_id,
                topics,
                request,
                qos_path,
                storage_config_path,
                force_paused=True,
            )

            self._dropped_messages = None
            self._integrity = "unknown"
            self._pending_log_path = _recorder_log_path(
                self._objects_root(), capture_id
            )

            started_at = utc_now_iso8601()
            try:
                process = self._spawn_process(cmd)
            except (OSError, ValueError) as exc:
                marker_error = self._fail(
                    capture_id, run_id, started_at, request, staged_topics, str(exc)
                )
                raise ApiError(
                    status_code=507,
                    code="record_spawn_failed",
                    message="Failed to start the recording process.",
                    details=self._failed_start_details(
                        capture_id, marker_error, error=str(exc)
                    ),
                ) from exc

            if not self._await_started(capture_id, process):
                self._terminate_failed_start(process)
                returncode = process.returncode
                # The process was alive a moment ago and may have created the
                # dir just as we gave up on it. Removing it keeps §3.4 exact: a
                # failed start is a .failed.json sibling and NOTHING else, never
                # a marker plus a directory the next scan reads as a capture.
                self._remove_capture_dir(capture_id)
                marker_error = self._fail(
                    capture_id,
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
                    details=self._failed_start_details(
                        capture_id, marker_error, run_id=run_id, returncode=returncode
                    ),
                )

            # Bag process is up, still paused. Wait for subscription match and
            # hold the (now-matched) Resume/IsPaused clients — but do NOT
            # resume. FAIL-SAFE: any failure here must not leave a paused
            # process lying around silently; kill it and fail like today's
            # single-call arm gate does.
            self._arming = None
            try:
                node, resume_client, is_paused_client, owns_rclpy = self._prepare_arm(
                    run_id, selected, topics == "all"
                )
            except Exception as exc:  # noqa: BLE001 - convert to a clean fail
                self._terminate_failed_start(process)
                self._remove_capture_dir(capture_id)
                self._arming = None
                marker_error = self._fail(
                    capture_id,
                    run_id,
                    started_at,
                    request,
                    staged_topics,
                    f"arming: {exc}",
                )
                raise ApiError(
                    status_code=507,
                    code="record_arm_failed",
                    message="Recording failed to arm (subscribe + resume).",
                    details=self._failed_start_details(
                        capture_id, marker_error, run_id=run_id, error=str(exc)
                    ),
                ) from exc

            # SUCCESS: detach the log handle from instance state into the armed
            # bundle. self._log_file/_pending_log_path must not keep pointing
            # at THIS run while the session sits armed — a later, unrelated
            # start()/prepare() would otherwise clobber (or be clobbered by) it.
            armed_log_file = self._log_file
            armed_pending_log_path = self._pending_log_path
            self._log_file = None
            self._pending_log_path = None

            self._armed_generation += 1
            generation = self._armed_generation
            disarm_timeout = self._prepare_disarm_timeout_s()
            disarm_at = _iso8601_after(disarm_timeout)
            if self._arming is not None:
                self._arming.disarm_at = disarm_at

            timer = threading.Timer(
                disarm_timeout, self._on_disarm_timer, args=(generation,)
            )
            timer.daemon = True

            armed = _Armed(
                generation=generation,
                run_id=run_id,
                capture_id=capture_id,
                request=request,
                staged_topics=staged_topics,
                started_at=started_at,
                previous_state=previous_state,
                process=process,
                qos_path=qos_path,
                storage_config_path=storage_config_path,
                pending_log_path=armed_pending_log_path,
                log_file=armed_log_file,
                node=node,
                resume_client=resume_client,
                is_paused_client=is_paused_client,
                owns_rclpy=owns_rclpy,
                disarm_at=disarm_at,
                timer=timer,
            )
            self._armed = armed
            self._state = RunState.armed
            timer.start()

            logger.info(
                "recording session armed",
                extra={
                    "run_id": run_id,
                    "capture_id": capture_id,
                    "component": "recorder",
                },
            )
            return RecordPrepareResponse(
                run_id=run_id,
                capture_id=capture_id,
                state=RunState.armed,
                arming=self._arming.model_copy(deep=True) if self._arming else None,
                disarm_at=disarm_at,
            )

    def _on_disarm_timer(self, generation: int) -> None:
        """Auto-disarm callback (fires on a background timer thread).

        Re-checks — under the lock — that the session is STILL armed AND
        still this SAME armed session (``generation`` matches) before
        disarming. Guards the ABA race where disarm -> re-prepare happens
        between the timer firing and this callback acquiring the lock, which
        would otherwise let a stale timer tear down a later, unrelated armed
        session.
        """
        with self._lock:
            if (
                self._state is RunState.armed
                and self._armed is not None
                and self._armed.generation == generation
            ):
                logger.warning(
                    "armed session auto-disarmed (prepare_disarm_timeout_s elapsed)",
                    extra={"run_id": self._armed.run_id, "component": "recorder"},
                )
                self._disarm_locked()

    def _extend_armed_locked(self) -> RecordPrepareResponse:
        """Keep-alive: extend the current armed session's auto-disarm deadline.

        Called (with ``self._lock`` held) when a re-``prepare()`` MATCHES the
        already-armed session: the paused subprocess and its live
        subscriptions are reused as-is — no kill/respawn churn for a caller
        that re-prepares periodically to keep a session armed. The armed
        ``generation`` is bumped so a cancelled-but-already-running old timer
        callback (blocked on the lock while we extend) can no longer disarm
        the extended session — same ABA guard as re-arming.
        """
        armed = self._armed
        if armed is None:  # pragma: no cover - guarded by the caller
            raise RuntimeError("_extend_armed_locked called with no armed session")
        # Re-read readiness: reusing the subprocess must not also mean reusing a
        # stale view of which targets are live (this response feeds the console).
        self._refresh_arming_locked()
        if armed.timer is not None:
            armed.timer.cancel()
        self._armed_generation += 1
        armed.generation = self._armed_generation
        disarm_timeout = self._prepare_disarm_timeout_s()
        disarm_at = _iso8601_after(disarm_timeout)
        armed.disarm_at = disarm_at
        if self._arming is not None:
            self._arming.disarm_at = disarm_at
        timer = threading.Timer(
            disarm_timeout, self._on_disarm_timer, args=(armed.generation,)
        )
        timer.daemon = True
        armed.timer = timer
        timer.start()
        logger.info(
            "armed session extended (matching re-prepare)",
            extra={
                "run_id": armed.run_id,
                "capture_id": armed.capture_id,
                "component": "recorder",
            },
        )
        return RecordPrepareResponse(
            run_id=armed.run_id,
            capture_id=armed.capture_id,
            state=RunState.armed,
            arming=self._arming.model_copy(deep=True) if self._arming else None,
            disarm_at=disarm_at,
        )

    def _armed_matches(self, armed: _Armed, request: RecordStartRequest) -> bool:
        """Whether *request*'s spawn-affecting fields match *armed*'s.

        Only fields that shape ``ros2 bag record``'s argv are compared: the
        normalised topic selection, compression, split, and QoS. ``run_id`` is
        deliberately NOT compared — it was fixed at prepare time (the
        subprocess is already writing into that output dir) — and
        ``operator``/``task`` are NOT compared either: they are metadata only,
        applied from the *start* request at commit time (see
        ``_start_from_armed``), not spawn-affecting.
        """
        prepared = armed.request
        return (
            _normalise_topics(prepared.topics) == _normalise_topics(request.topics)
            and prepared.compression == request.compression
            and prepared.split == request.split
            and prepared.qos_default == request.qos_default
            and prepared.qos_overrides == request.qos_overrides
        )

    def _claim_armed_locked(
        self, request: RecordStartRequest
    ) -> RecordStatusResponse | None:
        """Consume the armed session, if any. ``None`` = caller must spawn.

        A matching armed session is resumed and committed (the two-phase fast
        path); a non-matching one is disarmed so the caller falls through to a
        full synchronous start. Caller must hold ``self._lock``.

        Called from BOTH of :meth:`start`'s lock blocks. The second call is the
        one that matters: an armed session can appear during the start_delay
        window between them, and skipping the check there leaves that session
        with no owner at all — see the comment at the second call site.
        """
        if self._state is not RunState.armed or self._armed is None:
            return None
        if self._armed_matches(self._armed, request):
            return self._start_from_armed(request)
        logger.warning(
            "armed session does not match the start request; disarming",
            extra={
                "run_id": self._armed.run_id,
                "capture_id": self._armed.capture_id,
                "component": "recorder",
            },
        )
        self._disarm_locked()
        return None

    def _remove_capture_dir(self, capture_id: str) -> bool:
        """Delete a capture directory that never became a recording.

        Returns whether it is actually gone, so a caller cannot go on to
        announce a removal that did not happen.

        Residue is reported rather than ignored: a directory under ``objects/``
        with no manifest breaks §2's invariant, and the next startup has to
        guess what it was (see :meth:`_adopt_manifestless_capture`). Deletion
        stays best-effort — a failure here must not turn a cancelled arm into a
        failed request — but it is never silent.
        """
        path = self._capture_dir(capture_id)
        shutil.rmtree(path, ignore_errors=True)
        if path.exists():
            logger.warning(
                "could not fully remove an abandoned capture directory; "
                "startup recovery will have to reclaim it",
                extra={
                    "capture_id": capture_id,
                    "path": str(path),
                    "component": "recorder",
                },
            )
            return False
        return True

    def _start_from_armed(self, request: RecordStartRequest) -> RecordStatusResponse:
        """Fast resume path: a matching armed session exists — resume + commit.

        No spawn, no discovery wait: both already ran in ``prepare()``. Must be
        called with ``self._lock`` held and ``self._armed`` set to a session
        that :meth:`_armed_matches` has already confirmed matches *request*.
        """
        armed = self._armed
        if armed is None:  # pragma: no cover - guarded by the caller
            raise RuntimeError("_start_from_armed called with no armed session")
        if armed.timer is not None:
            armed.timer.cancel()
        # Freeze the snapshot on what is live NOW, not at the first prepare:
        # this is the value the whole recording is judged by ("start-time
        # coverage"), and the node is destroyed a few lines below.
        self._refresh_arming_locked()

        try:
            self._resume_armed(armed)
        except Exception as exc:  # noqa: BLE001 - convert to a clean fail
            self._terminate_failed_start(armed.process)
            self._remove_capture_dir(armed.capture_id)
            self._teardown_armed_rclpy(armed)
            # Restore the detached log handle so the existing _fail() cleanup
            # (which closes/unlinks via self._log_file) finds and closes it.
            self._log_file = armed.log_file
            self._arming = None
            self._armed = None
            self._state = armed.previous_state
            marker_error = self._fail(
                armed.capture_id,
                armed.run_id,
                armed.started_at,
                armed.request,
                armed.staged_topics,
                f"arming: {exc}",
            )
            raise ApiError(
                status_code=507,
                code="record_arm_failed",
                message="Recording failed to arm (subscribe + resume).",
                details=self._failed_start_details(
                    armed.capture_id,
                    marker_error,
                    run_id=armed.run_id,
                    error=str(exc),
                ),
            ) from exc

        # Resumed: no longer waiting.
        if self._arming is not None:
            self._arming.active = False

        # Commit: promote the armed subprocess/log-file onto the session's
        # live fields, exactly like today's post-arm commit path in start().
        self._process = armed.process
        self._state = RunState.recording
        self._run_id = armed.run_id
        self._capture_id = armed.capture_id
        self._started_at = utc_now_iso8601()
        self._compression = request.compression
        self._split = request.split
        # operator/task/robot come from the START request (armed.request is
        # stale prepare-time metadata; see _armed_matches).
        self._operator = _default_meta(request.operator, _UNKNOWN_OPERATOR)
        self._stamp = self._build_stamp(request.console_stamp)
        self._task = _default_meta(request.task, _UNKNOWN_TASK)
        self._robot = self._resolve_robot(request)
        self._topics = armed.staged_topics
        self._log_file = armed.log_file
        self._pending_log_path = armed.pending_log_path
        # Fresh integrity state for this run. prepare() already reset these
        # before spawn (nothing mutates them while armed), but resetting here
        # too keeps this commit point locally correct on its own, matching the
        # full synchronous start() path's commit.
        self._dropped_messages = None
        self._integrity = "unknown"

        # The node/clients are no longer needed: the subprocess now runs
        # unattended (like any other recording) until stop().
        self._teardown_armed_rclpy(armed)
        self._armed = None

        self._write_manifest()
        self._start_size_watcher(armed.capture_id)
        logger.info(
            "recording started (fast resume from armed)",
            extra={
                "run_id": armed.run_id,
                "capture_id": armed.capture_id,
                "component": "recorder",
            },
        )
        return self._status_locked()

    def _disarm_locked(self) -> None:
        """Tear down the current armed session (caller must hold ``self._lock``).

        Terminates the paused subprocess (process-group SIGTERM — there is no
        recorded data to flush cleanly, the process never left the paused
        state), removes the capture dir + sibling qos/storage-config/log files,
        destroys the held rclpy node (+ shuts down rclpy if this session owned
        the context), cancels the auto-disarm timer, and restores the state to
        whatever it was before ``prepare()`` armed it (so disarming a session
        never erases visibility of a genuinely-completed previous run). Writes
        NO failure record: a disarm is a deliberate or expired cancel, not a
        recording failure. The minted capture_id dies with it — nothing ever
        committed under it, so nothing can refer to it.
        """
        armed = self._armed
        if armed is None:
            return
        if armed.timer is not None:
            armed.timer.cancel()
        self._terminate_failed_start(armed.process)
        self._remove_capture_dir(armed.capture_id)
        self._teardown_armed_rclpy(armed)
        # Restore the detached log handle so the existing cleanup helpers
        # (which act on self._log_file) can close + unlink it normally.
        self._log_file = armed.log_file
        self._cleanup_qos_file(armed.capture_id)
        self._cleanup_storage_config(armed.capture_id)
        self._cleanup_log_file(armed.capture_id)
        self._armed = None
        self._arming = None
        self._state = armed.previous_state
        logger.info(
            "armed session disarmed",
            extra={"run_id": armed.run_id, "component": "recorder"},
        )

    def start(self, request: RecordStartRequest) -> RecordStatusResponse:
        """Start a recording session; raise 409 if one is already active.

        If a matching ``armed`` session exists (from a prior ``prepare()``),
        this is the two-phase fast path: resume the already-spawned,
        already-matched subprocess and commit — no spawn, no discovery wait.
        A non-matching armed session is disarmed first, then this falls
        through to the full synchronous path unchanged, so ``start()`` alone
        stays complete and correct on its own (see
        ``docs/specs/ja/rosbag2_recorder.md``).
        """
        run_id = validate_run_id(request.run_id)
        with self._lock:
            self._raise_if_active()
            self._check_writable_and_space()
            claimed = self._claim_armed_locked(request)
            if claimed is not None:
                return claimed
            # Nothing armed (or it did not match and was disarmed): fall
            # through to the full synchronous path below.

        # Let drivers/cameras ramp up so they are publishing before recording
        # begins (RECORDING_CONFIG recording.start_delay_s). Done OUTSIDE the
        # lock so GET /record/status is not blocked for the whole delay; the
        # active state is re-checked after re-acquiring (the orchestrator also
        # serializes starts, so a concurrent start is already unlikely).
        self._apply_start_delay()

        with self._lock:
            self._raise_if_active()
            # A prepare() can have armed a session while we slept above, and
            # that is the NORMAL console sequence: it pre-arms, then the
            # operator presses start a moment later. Re-checking here is not
            # belt-and-braces — without it this path spawns a second
            # ``ros2 bag record`` and strands the armed one: nothing would ever
            # disarm it (the auto-disarm timer no-ops because the state is no
            # longer ``armed``), its directory is absent from live_capture_ids,
            # and two recorders write the same topics at once.
            claimed = self._claim_armed_locked(request)
            if claimed is not None:
                return claimed

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

            # No prepare() ran (or its armed session did not match), so the
            # capture's identity is minted here instead (§1).
            capture_id = new_capture_id()

            # The QoS file is a sibling of the capture dir; the capture dir
            # itself must NOT exist before spawn (ros2 bag record refuses a
            # pre-existing --output). So nothing here may create it.
            qos_path = self._materialise_qos(capture_id, selected, request)
            storage_config_path = self._materialise_storage_config(capture_id, request)
            cmd = self._build_command(
                capture_id, topics, request, qos_path, storage_config_path
            )

            # Fresh integrity state for this attempt; _spawn_process captures the
            # recorder's stdout+stderr here so finalise can scan it for drops.
            self._dropped_messages = None
            self._integrity = "unknown"
            self._pending_log_path = _recorder_log_path(
                self._objects_root(), capture_id
            )

            started_at = utc_now_iso8601()
            try:
                process = self._spawn_process(cmd)
            except (OSError, ValueError) as exc:
                marker_error = self._fail(
                    capture_id, run_id, started_at, request, staged_topics, str(exc)
                )
                raise ApiError(
                    status_code=507,
                    code="record_spawn_failed",
                    message="Failed to start the recording process.",
                    details=self._failed_start_details(
                        capture_id, marker_error, error=str(exc)
                    ),
                ) from exc

            # Confirm ros2 bag record actually started: wait for it to create its
            # --output directory (it does so only after passing its own checks).
            # If it exits — or hangs without creating the dir — it failed to start.
            if not self._await_started(capture_id, process):
                # Kill a still-alive but stuck process so it cannot later create
                # the output dir behind our back, then clear any directory it
                # managed to create in the meantime (§3.4: a failed start is a
                # sibling marker and nothing else).
                self._terminate_failed_start(process)
                returncode = process.returncode
                self._remove_capture_dir(capture_id)
                marker_error = self._fail(
                    capture_id,
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
                    details=self._failed_start_details(
                        capture_id, marker_error, run_id=run_id, returncode=returncode
                    ),
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
                    self._remove_capture_dir(capture_id)
                    # Drop the partial arming snapshot; this session never started.
                    self._arming = None
                    marker_error = self._fail(
                        capture_id,
                        run_id,
                        started_at,
                        request,
                        staged_topics,
                        f"arming: {exc}",
                    )
                    raise ApiError(
                        status_code=507,
                        code="record_arm_failed",
                        message="Recording failed to arm (subscribe + resume).",
                        details=self._failed_start_details(
                            capture_id, marker_error, run_id=run_id, error=str(exc)
                        ),
                    ) from exc

            self._process = process
            self._state = RunState.recording
            self._run_id = run_id
            self._capture_id = capture_id
            # Stamp the session at the moment capture actually begins (the bag
            # process is up and, when armed, resumed) — NOT the pre-spawn
            # `started_at` above, which is seconds earlier (start_delay + spawn
            # + arming). The UI elapsed timer and the manifest measure the bag,
            # not the start overhead; the pre-spawn stamp stays for _fail().
            self._started_at = utc_now_iso8601()
            self._compression = request.compression
            self._split = request.split
            # Default operator/task so a standalone recorder call (no orchestrator
            # to normalize them) still names one (see _UNKNOWN_OPERATOR).
            self._operator = _default_meta(request.operator, _UNKNOWN_OPERATOR)
            self._stamp = self._build_stamp(request.console_stamp)
            self._task = _default_meta(request.task, _UNKNOWN_TASK)
            self._robot = self._resolve_robot(request)
            self._topics = staged_topics
            # The capture dir now exists (ros2 created it), so writing the
            # manifest into it no longer races the "folder exists" check.
            self._write_manifest()
            self._start_size_watcher(capture_id)
            logger.info(
                "recording started",
                extra={
                    "run_id": run_id,
                    "capture_id": capture_id,
                    "component": "recorder",
                },
            )
            return self._status_locked()

    def _resolve_robot(self, request: RecordStartRequest) -> str | None:
        """Which robot this capture came from: the request, else the config.

        The orchestrator knows the active robot and passes it; a standalone
        ``/record/start`` does not, so the recorder's own RECORDING_CONFIG is
        the honest second answer. ``None`` only when neither knows.
        """
        if request.robot and request.robot.strip():
            return request.robot.strip()
        return self._configured_robot()

    def _configured_robot(self) -> str | None:
        """The robot this recorder is configured for, if it has a config.

        The only answer available to crash recovery, which has no request to
        read — and the right one: whatever this recorder was set up to record
        is what produced the bytes it is reclaiming.
        """
        return self._config.robot_name if self._config is not None else None

    def _start_size_watcher(self, capture_id: str) -> None:
        """Start the auto-stop watcher (no-op when both limits are disabled).

        Runs a daemon thread that polls the run and triggers ``stop()`` once
        ``MAX_RECORD_BYTES`` (disk size, 0 = unlimited) or
        ``MAX_RECORD_SECONDS`` (wall clock, 0 = unlimited; default 600) is
        exceeded. The duration cap is the zombie-recording backstop (persona
        review R2 / HCD D-9①): an orphaned session that nobody stops must not
        hold the recorder and eat disk forever. The orchestrator's lazy status
        reconciliation then finalizes the run as COMPLETED (not interrupted)
        within one status poll.
        """
        if self._max_record_bytes <= 0 and self._max_record_seconds <= 0:
            return
        self._watcher_stop.clear()
        watcher = threading.Thread(
            target=self._watch_size,
            args=(capture_id,),
            name=f"size-watcher-{capture_id}",
            daemon=True,
        )
        self._size_watcher = watcher
        watcher.start()

    def _watch_size(self, capture_id: str) -> None:
        """Poll the run and auto-stop on the byte or wall-clock limit.

        Triggered via the public ``stop()`` (which takes the lock and is
        idempotent), so this never touches session state directly and cannot
        deadlock against a concurrent user stop.
        """
        byte_limit = self._max_record_bytes
        seconds_limit = self._max_record_seconds
        started = time.monotonic()
        while not self._watcher_stop.wait(SIZE_POLL_S):
            if byte_limit > 0:
                size = self._recorded_bytes(capture_id)
                if size >= byte_limit:
                    self._auto_stop_reason = (
                        f"auto-stopped: recorded {size} bytes reached "
                        f"MAX_RECORD_BYTES={byte_limit}"
                    )
                    logger.warning(
                        "MAX_RECORD_BYTES exceeded; auto-stopping",
                        extra={"capture_id": capture_id, "component": "recorder"},
                    )
                    self.stop()
                    return
            if seconds_limit > 0:
                elapsed = time.monotonic() - started
                if elapsed >= seconds_limit:
                    self._auto_stop_reason = (
                        f"auto-stopped: recording ran {int(elapsed)}s, reaching "
                        f"MAX_RECORD_SECONDS={seconds_limit}"
                    )
                    logger.warning(
                        "MAX_RECORD_SECONDS exceeded; auto-stopping",
                        extra={"capture_id": capture_id, "component": "recorder"},
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

    def _await_started(self, capture_id: str, process: subprocess.Popen[bytes]) -> bool:
        """Wait for ``ros2 bag record`` to create its output dir.

        Success REQUIRES the capture directory to actually exist — that is the
        only proof ros2 passed its own checks and is recording into a real bag.
        Returns ``True`` only once the dir exists; returns ``False`` if the
        process exits first OR the dir has still not appeared by
        ``START_DIR_TIMEOUT_S`` (even if the process is still alive). We never
        assume success without the dir, because the caller would then create it
        itself (writing the manifest), re-introducing the pre-existing-output-dir
        failure for any retry/observer.
        """
        target = self._capture_dir(capture_id)
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

    def _await_subscription_match(
        self,
        node: Any,
        rclpy_mod: Any,
        topics: list[str],
        all_mode: bool,
        timeout: float,
    ) -> None:
        """Seed the arming snapshot and wait for the recorder to subscribe.

        Shared by the single-call ``recording.start_paused`` gate
        (:meth:`_arm_and_resume`) and the two-phase ``prepare()`` path
        (:meth:`_prepare_arm`): both need the exact same "spawned paused ->
        wait for subscription match -> settle" sequence, just followed by a
        different next step (resume immediately vs. hold for a later resume).
        """
        # Seed the observational arming snapshot: active while we wait, with the
        # auto-resume deadline (now + timeout) and every target still unmatched
        # until the readiness poll confirms a subscription (OL-①.4). They seed as
        # "unsubscribed", not "missing": we have not read the graph yet, and the
        # one thing we do know is that the recorder has not subscribed — claiming
        # "not publishing" before looking would be a guess.
        self._arming = RecordArming(
            active=True,
            matched_topics=[],
            unsubscribed_topics=list(topics),
            resume_at=_iso8601_after(timeout),
        )
        self._await_recorder_subscribed(rclpy_mod, node, topics, all_mode, timeout)
        # Settle time after subscriptions matched, before resume, so the bag
        # opens past sensor/camera ramp-up rather than on warm-up frames (OL-①.2).
        self._apply_post_discovery_delay()

    def _arm_and_resume(self, run_id: str, topics: list[str], all_mode: bool) -> None:
        """Wait until ``ros2 bag record`` has subscribed to the target topics,
        then resume it (it was spawned ``--start-paused``).

        Raises on any hard failure so the caller fails the start rather than
        leaving a paused recorder capturing nothing. rclpy + rosbag2_interfaces
        are imported lazily so the module imports without ROS; the live path runs
        in the ROS image (verified in Docker, like the monitor's rclpy paths).

        This is the single-call gate (``recording.start_paused``): the node it
        creates is transient — it exists purely to arm-then-resume within this
        one call, unlike ``_prepare_arm``'s node, which is kept alive across
        ``prepare()`` -> ``start()``.
        """
        import rclpy
        from rclpy.node import Node
        from rosbag2_interfaces.srv import IsPaused, Resume

        timeout = (
            self._config.recording.subscription_ready_timeout_s
            if self._config is not None
            else 5.0
        )
        owns_rclpy = not rclpy.ok()
        if owns_rclpy:
            rclpy.init()
        node = Node("kairos_recorder_arming")
        try:
            self._await_subscription_match(node, rclpy, topics, all_mode, timeout)
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

    def _prepare_arm(
        self, run_id: str, topics: list[str], all_mode: bool
    ) -> tuple[Any, Any, Any, bool]:
        """Wait for subscription match and create MATCHED Resume/IsPaused clients.

        Unlike :meth:`_arm_and_resume`, this does NOT call resume and does NOT
        destroy the node on success: both the node and the clients are handed
        back to the caller (:meth:`prepare`) to hold on the armed session, so a
        later fast ``start()`` is just a resume call — no repeat DDS-participant
        creation or service discovery (the whole point of two-phase start).

        Returns ``(node, resume_client, is_paused_client, owns_rclpy)``. On any
        failure the node/context are torn down here before raising, so the
        caller's except-clause only has to deal with the subprocess + capture dir.
        """
        import rclpy
        from rclpy.node import Node
        from rosbag2_interfaces.srv import IsPaused, Resume

        timeout = (
            self._config.recording.subscription_ready_timeout_s
            if self._config is not None
            else 5.0
        )
        owns_rclpy = not rclpy.ok()
        if owns_rclpy:
            rclpy.init()
        node = Node("kairos_recorder_arming")
        try:
            self._await_subscription_match(node, rclpy, topics, all_mode, timeout)
            resume_client = node.create_client(Resume, f"/{RECORDER_NODE_NAME}/resume")
            is_paused_client = node.create_client(
                IsPaused, f"/{RECORDER_NODE_NAME}/is_paused"
            )
            if not resume_client.wait_for_service(timeout_sec=RESUME_SERVICE_TIMEOUT_S):
                raise RuntimeError("recorder resume service did not appear")
            # is_paused is only used to CONFIRM resume; best-effort like
            # _resume_recorder (arm anyway if it never appears).
            is_paused_client.wait_for_service(timeout_sec=2.0)
            logger.info("recording armed (two-phase prepare)", extra={"run_id": run_id})
            return node, resume_client, is_paused_client, owns_rclpy
        except Exception:
            node.destroy_node()
            if owns_rclpy:
                rclpy.shutdown()
            raise

    def _resume_armed(self, armed: _Armed) -> None:
        """Resume an armed subprocess via its already-matched clients.

        No ``wait_for_service`` calls: ``prepare()`` (:meth:`_prepare_arm`)
        already confirmed both services are present, so re-waiting here would
        reintroduce the exact discovery latency two-phase start exists to
        remove. Same fail-safe confirmation as :meth:`_resume_recorder`: raises
        if resume doesn't return, or if ``is_paused`` still reports paused
        afterwards.
        """
        import rclpy
        from rosbag2_interfaces.srv import IsPaused, Resume

        fut = armed.resume_client.call_async(Resume.Request())
        rclpy.spin_until_future_complete(
            armed.node, fut, timeout_sec=RESUME_SERVICE_TIMEOUT_S
        )
        if fut.result() is None:
            raise RuntimeError("recorder resume call did not return")
        f2 = armed.is_paused_client.call_async(IsPaused.Request())
        rclpy.spin_until_future_complete(armed.node, f2, timeout_sec=3.0)
        res = f2.result()
        if res is not None and getattr(res, "paused", False):
            raise RuntimeError("recorder still paused after resume")

    def _teardown_armed_rclpy(self, armed: _Armed) -> None:
        """Destroy the armed session's held rclpy node (+ shutdown if owned).

        Called both when a session is committed (resume succeeded — the node
        is no longer needed, the subprocess runs unattended until ``stop()``)
        and when it is disarmed/failed. Best-effort: teardown must not raise
        over a session that is being torn down anyway.
        """
        try:
            armed.node.destroy_node()
        except Exception:  # noqa: BLE001 - best-effort teardown
            logger.exception("failed to destroy the armed rclpy node")
        if armed.owns_rclpy:
            import rclpy

            try:
                if rclpy.ok():
                    rclpy.shutdown()
            except Exception:  # noqa: BLE001
                logger.exception("failed to shut down the armed rclpy context")

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

    def _readiness_view(
        self, node: Any, topics: list[str], all_mode: bool
    ) -> tuple[list[str], list[str], list[str]]:
        """One graph read -> ``(matched, unsubscribed, missing)`` for the targets.

        The gate's "pending" set is ``unsubscribed + missing``; splitting it by
        CAUSE is what lets the UI say "not publishing" only about a topic that
        really has no publisher (see :class:`RecordArming`).
        """
        matched: list[str] = []
        unsubscribed: list[str] = []
        missing: list[str] = []
        for topic in self._readiness_targets(node, topics, all_mode):
            if node.count_publishers(topic) == 0:
                missing.append(topic)
            elif self._recorder_subscribed(node, topic):
                matched.append(topic)
            else:
                unsubscribed.append(topic)
        return matched, unsubscribed, missing

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
            matched, unsubscribed, missing = self._readiness_view(
                node, topics, all_mode
            )
            pending = unsubscribed + missing
            self._update_arming(matched, unsubscribed, missing)
            if matched and not pending:
                return
            if time.monotonic() >= deadline:
                if pending:
                    logger.warning(
                        "arming timed out; resuming with topics not yet matched",
                        extra={"pending_topics": pending},
                    )
                return

    def _update_arming(
        self, matched: list[str], unsubscribed: list[str], missing: list[str]
    ) -> None:
        """Refresh the observational arming snapshot's readiness lists.

        Called from each readiness poll and from :meth:`_refresh_arming_locked`
        (both under ``self._lock``). Purely observational: it never affects
        subscription timing or the resume path.
        """
        if self._arming is not None:
            self._arming.matched_topics = matched
            self._arming.unsubscribed_topics = unsubscribed
            self._arming.missing_topics = missing

    def _refresh_arming_locked(self) -> None:
        """Re-evaluate the ARMED session's snapshot against the live ROS graph.

        A ``prepare()`` arms once but the session then sits armed indefinitely
        (the console's pre-arm keep-alive re-prepares it, and a matching
        re-prepare deliberately reuses the paused subprocess rather than
        respawning it). Without this, the readiness snapshot stayed frozen at
        the FIRST arm: a topic that was down then — and came up seconds later —
        was still reported "not publishing" through the keep-alives, through the
        start, and for the whole recording.

        Best-effort and observational: the armed session's rclpy node is only
        read (graph queries, no spin), and any failure keeps the last snapshot
        rather than blanking it. Caller must hold ``self._lock`` (which also
        serialises this against the node's teardown).
        """
        armed = self._armed
        if armed is None or self._arming is None:
            return
        requested = armed.request.topics
        all_mode = requested == "all"
        targets = [] if all_mode else list(requested or [])
        try:
            matched, unsubscribed, missing = self._readiness_view(
                armed.node, targets, all_mode
            )
        except Exception:  # noqa: BLE001 - observational; keep the last snapshot
            logger.exception("failed to refresh the arming snapshot")
            return
        self._update_arming(matched, unsubscribed, missing)

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
        self, capture_id: str, selected: list[str], request: RecordStartRequest
    ) -> Path | None:
        """Write the QoS overrides file for this run, if any overrides apply.

        The file is written to a *sibling* of the capture directory
        (``objects/<capture_id>.qos.yaml``), never inside it: ``ros2 bag
        record`` refuses to start if its ``--output`` directory already exists,
        so the capture dir must not exist until ros2 itself creates it.

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
            overrides, _qos_overrides_path(self._objects_root(), capture_id)
        )

    def _cleanup_qos_file(self, capture_id: str) -> None:
        """Remove the run's QoS overrides sibling file if it was written."""
        _qos_overrides_path(self._objects_root(), capture_id).unlink(missing_ok=True)

    def _materialise_storage_config(
        self, capture_id: str, request: RecordStartRequest
    ) -> Path | None:
        """Write the MCAP storage-config file for zstd compression, if requested.

        Like the QoS file, it is a *sibling* of the capture dir (which must not
        exist before ``ros2 bag record`` creates it). Returns ``None`` when
        compression is off (no file written, normal uncompressed record).
        """
        if request.compression is not Compression.zstd:
            return None
        path = _mcap_storage_config_path(self._objects_root(), capture_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_MCAP_ZSTD_STORAGE_CONFIG, encoding="utf-8")
        return path

    def _cleanup_storage_config(self, capture_id: str) -> None:
        """Remove the run's MCAP storage-config sibling file if it was written."""
        _mcap_storage_config_path(self._objects_root(), capture_id).unlink(
            missing_ok=True
        )

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

    def _scan_dropped_messages(self, capture_id: str | None) -> int | None:
        """Messages the in-recorder cache dropped this run, from the captured log.

        rosbag2 logs ``Total lost: N`` once at shutdown when its MessageCache
        overflowed. Returns that N, ``0`` when the log exists with no such line
        (no overflow), or ``None`` when the log is unavailable/unreadable (drop
        count unknown — e.g. a stubbed spawn in unit tests).

        Both log locations are tried, because the two callers see different
        ones: finalise scans before :meth:`_archive_log` moves the sibling in,
        while crash recovery scans a capture whose log was archived first. A
        single hard-coded location would silently report "unknown" for one of
        them, which reads as "no overflow was detectable" rather than "nobody
        looked in the right place".
        """
        if not capture_id:
            return None
        for path in self._recorder_log_locations(capture_id):
            try:
                text = path.read_text(errors="replace")
            except OSError:
                continue
            # One report per run (at shutdown); take the last match to be safe.
            matches = _TOTAL_LOST_RE.findall(text)
            return int(matches[-1]) if matches else 0
        return None

    def _recorder_log_locations(self, capture_id: str) -> tuple[Path, Path]:
        """Where a capture's log can be: the live sibling, then the archived copy."""
        return (
            _recorder_log_path(self._objects_root(), capture_id),
            self._capture_dir(capture_id) / RECORDER_LOG_FILENAME,
        )

    def _classify_integrity(self) -> str:
        """Classify recording integrity from state + cache-drop count.

        ``failed`` whenever the recording did not end cleanly — a capture that
        was interrupted is missing whatever the operator meant to record after
        the crash, which the drop count cannot describe. Otherwise ``unknown``
        when the drop count could not be determined, ``dropped`` when the cache
        lost >0 messages, and ``ok`` when a readable log reported no overflow.
        """
        if self._state in _BROKEN_STATES:
            return "failed"
        if self._dropped_messages is None:
            return "unknown"
        return "dropped" if self._dropped_messages > 0 else "ok"

    def _archive_log(self, capture_id: str | None) -> None:
        """Move the sibling recorder log into the capture dir (best-effort).

        Done at finalise — while the recorder is still the capture's sole writer
        (§3.3). Adding a file after the digest job has sealed ``files`` would
        make the sealed digest describe a directory that no longer matches, so
        this must never run over a capture the recorder has already handed off.
        A missing sibling (stubbed spawn) is a no-op.
        """
        if not capture_id:
            return
        src = _recorder_log_path(self._objects_root(), capture_id)
        dst = self._capture_dir(capture_id) / RECORDER_LOG_FILENAME
        try:
            if src.exists():
                src.replace(dst)
        except OSError:
            logger.warning("could not archive recorder log for %s", capture_id)

    def _cleanup_log_file(self, capture_id: str | None) -> None:
        """Close the log handle and drop the sibling log (failed-start paths)."""
        self._close_log_file()
        if capture_id:
            _recorder_log_path(self._objects_root(), capture_id).unlink(missing_ok=True)

    def stop(self) -> RecordStatusResponse:
        """Stop the active session (idempotent).

        Recording -> SIGINT the process group, wait, finalise, return the
        terminal status. ``armed`` -> disarm (the paused subprocess is killed,
        the empty capture dir removed — there is nothing recorded to flush). Any
        other state — idle, or a stop already in progress (``stopping``) —
        returns the current status unchanged.
        """
        # Signal the size watcher to stop polling up front so it does not race
        # us into a second stop. (Safe if we ARE the watcher thread.)
        self._watcher_stop.set()
        with self._lock:
            if self._state is RunState.armed:
                # Without this, an operator-initiated cancel while armed would
                # leak the paused subprocess forever (stop() would otherwise
                # silently no-op below, since state is not `recording`).
                disarmed = self._armed.capture_id if self._armed else None
                self._disarm_locked()
                # Name the cancelled capture. ``capture_id`` cannot carry it —
                # it reverts to the last FINALISED capture, which a cancel must
                # not overwrite — so a caller holding the id from prepare() has
                # no other way to learn it is now dead.
                return self._status_locked(disarmed_capture_id=disarmed)

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
        ``metadata.yaml`` AND flushed MCAP bytes. Metadata presence alone is not
        enough: an abnormal exit (disk full, partial write, rosbag2 crash,
        SIGTERM escalation) can leave a stale/partial metadata.yaml.

        Anything short of that splits on whether a bag exists at all, using the
        same discriminator the rebuild applies (:func:`has_bag`), so a crashed
        recording and a cleanly stopped one are judged by one standard (§8 rule
        2): bytes on disk mean ``interrupted`` — incomplete but real, and worth
        hashing and keeping — while an empty directory means ``failed``.

        *ended_at* is the capture-end stamp taken when the stop was DECIDED
        (see :meth:`stop`); falling back to now() here would silently re-add
        the SIGINT flush time to the session length.
        """
        capture_id = self._capture_id
        process = self._process
        returncode = process.returncode if process is not None else None
        ended_at = ended_at or utc_now_iso8601()

        meta = self._read_rosbag2_metadata(capture_id) if capture_id else None
        clean_exit = returncode in _CLEAN_STOP_RETURNCODES
        # Stop-time verification (OL-①.3): a flushed bag has its MCAP data on disk.
        mcap_present = bool(capture_id) and self._recorded_bytes(capture_id) > 0
        if meta is not None:
            # Sync what the bag says even when the run ended badly: the topic
            # list is the audit record, and a bad ending is not a reason to
            # report the recording as having captured nothing.
            self._sync_topics_from_metadata(meta)
        if meta is not None and clean_exit and mcap_present:
            self._state = RunState.completed
            # A MAX_RECORD_BYTES auto-stop is a *successful* completion at the
            # cap; record why it ended in the note field (no error occurred).
            error = self._auto_stop_reason
        elif capture_id is not None and has_bag(self._capture_dir(capture_id)):
            self._state = RunState.interrupted
            if meta is None:
                error = f"recording produced no metadata.yaml (rc={returncode})"
            elif not mcap_present:
                # Clean metadata but no MCAP data flushed: the bag is empty/lost.
                error = "recording produced metadata but no MCAP data file"
            else:
                error = f"recording ended abnormally (rc={returncode})"
        else:
            # Neither metadata.yaml nor an MCAP: the process opened its output
            # directory and wrote nothing into it, so there is no recording to
            # salvage or hash.
            self._state = RunState.failed
            error = (
                "recording produced no metadata.yaml and no MCAP data "
                f"(rc={returncode})"
            )

        self._process = None
        self._auto_stop_reason = None
        # Recording integrity: the process has exited, so close the captured log,
        # scan it for rosbag2's in-recorder cache-overflow drop count, and classify
        # the run (a clean run that still dropped messages is completed but
        # integrity="dropped" — the bag is missing data the cache could not hold).
        self._close_log_file()
        self._dropped_messages = self._scan_dropped_messages(capture_id)
        self._integrity = self._classify_integrity()
        if capture_id:
            # Before the manifest write, which is the handoff point: after it the
            # capture is terminal and the digest job owns the directory (§3.3).
            self._cleanup_qos_file(capture_id)
            self._cleanup_storage_config(capture_id)
            self._archive_log(capture_id)
        self._write_manifest(ended_at=ended_at, error=error)
        logger.info(
            "recording finalised",
            extra={
                "run_id": self._run_id,
                "capture_id": capture_id,
                "component": "recorder",
                "state": self._state.value,
                "integrity": self._integrity,
                "dropped_messages": self._dropped_messages,
            },
        )

    def _fail(
        self,
        capture_id: str,
        run_id: str,
        started_at: str,
        request: RecordStartRequest,
        topics: list[TopicEntry],
        error: str,
    ) -> str | None:
        """Record a START failure WITHOUT creating a capture directory (§3.4).

        The session never produced a bag, so we must not leave an
        ``objects/<capture_id>/`` directory: §2's invariant is that a directory
        under ``objects/`` means bytes were written, and every scan trusts it.
        The failure goes to the sibling ``objects/<capture_id>.failed.json``
        instead. ``topics`` is the staged selection for this failed attempt
        (NOT ``self._topics``, which still reflects the previous session).

        Returns ``None`` when the marker was written, or a description of why
        it was not — which the caller MUST put in the start's error response.
        A start that failed and left no record of having failed is one nobody
        can account for afterwards, so this cannot be swallowed here (§3.4).
        """
        manifest = ObjectManifestV2(
            capture_id=capture_id,
            source_instance_id=self._instance_id,
            run_id=run_id,
            state=CaptureState.failed.value,
            started_at=started_at,
            ended_at=utc_now_iso8601(),
            operator=_default_meta(request.operator, _UNKNOWN_OPERATOR),
            task=_default_meta(request.task, _UNKNOWN_TASK),
            robot=self._resolve_robot(request),
            topics=tuple(topic.model_dump(mode="json") for topic in topics),
            compression=str(request.compression),
            split=request.split.model_dump(mode="json") if request.split else None,
            integrity="failed",
            error=error,
            digest_state=DigestState.pending.value,
        )
        marker_error: str | None = None
        try:
            write_failed_start(self._data_dir, manifest)
        except OSError as exc:
            logger.exception(
                "could not write the failed-start record",
                extra={"capture_id": capture_id, "component": "recorder"},
            )
            marker_error = str(exc)
        self._cleanup_qos_file(capture_id)
        self._cleanup_storage_config(capture_id)
        self._cleanup_log_file(capture_id)
        return marker_error

    def _failed_start_details(
        self, capture_id: str, marker_error: str | None, **extra: Any
    ) -> dict[str, Any]:
        """Build the ``details`` of a failed start's error response.

        Always names the capture_id, and — when :meth:`_fail` could not write
        ``objects/<capture_id>.failed.json`` — says so, because the caller is
        then the only party that will ever learn the failure left no trace on
        disk (§3.4).
        """
        details: dict[str, Any] = {"capture_id": capture_id, **extra}
        if marker_error is not None:
            details["failed_start_record_error"] = marker_error
        return details

    # -- metadata sync ------------------------------------------------------

    def _read_rosbag2_metadata(self, capture_id: str) -> dict[str, Any] | None:
        """Parse the capture's rosbag2 ``metadata.yaml`` if present."""
        path = self._capture_dir(capture_id) / ROSBAG2_METADATA_FILENAME
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

    def _recorded_bytes(self, capture_id: str) -> int:
        """Total size on disk of the capture's recorded MCAP files.

        rosbag2's ``metadata.yaml`` ``files:`` entries do not carry a ``size``
        field in this storage format, so the on-disk size must be measured by
        stat'ing the actual bag files (covers every split part).
        """
        rd = self._capture_dir(capture_id)
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

    def _build_stamp(self, console_stamp: dict[str, Any] | None) -> dict[str, Any]:
        """Identity recorded WITH the capture: which build recorded it, which
        config file (by content hash) it read, and — when the orchestrator sent
        its half — which console asked. Rides the manifest's ``extra``
        passthrough, so the sidecar schema is untouched and older readers
        simply carry it along."""
        recorder: dict[str, Any] = {"git_sha": os.environ.get("KAIROS_GIT_SHA") or None}
        cfg = os.environ.get("RECORDING_CONFIG")
        if cfg:
            try:
                recorder["config_sha256"] = hashlib.sha256(
                    Path(cfg).read_bytes()
                ).hexdigest()
            except OSError:
                pass  # unreadable config: no hash beats a made-up one
        stamp: dict[str, Any] = {"recorder": recorder}
        if console_stamp:
            stamp["console"] = console_stamp
        return stamp

    def _disk_free_bytes(self) -> int | None:
        """Free bytes on THIS recorder's data-dir filesystem (the robot's disk
        in the split deploy). ``None`` when it cannot be statted — never a
        made-up number."""
        try:
            return shutil.disk_usage(self._data_dir).free
        except OSError:
            return None

    def _status_locked(
        self, *, disarmed_capture_id: str | None = None
    ) -> RecordStatusResponse:
        """Build the status payload. Caller must hold ``self._lock``.

        *disarmed_capture_id* is set only by the stop() that cancelled an armed
        session; every other caller leaves it ``None``.
        """
        if self._state is RunState.armed and self._armed is not None:
            # Live readiness, not the first-arm snapshot: an armed session can
            # sit armed for a long time (pre-arm keep-alive), and the console
            # renders this as a CURRENT warning ("target topics not
            # publishing"), so it must be re-read here.
            self._refresh_arming_locked()
            # Nothing has been committed yet (no manifest, no capture row) —
            # report the ARMED run/capture/topics, not the previous session's
            # self._run_id/_capture_id/_topics (those stay untouched until a
            # matching start() commits; see prepare()/_start_from_armed()).
            return RecordStatusResponse(
                state=self._state,
                run_id=self._armed.run_id,
                capture_id=self._armed.capture_id,
                live_capture_ids=self._live_capture_ids_locked(),
                disarmed_capture_id=disarmed_capture_id,
                started_at=None,
                message_count=0,
                bytes=0,
                topics=list(self._armed.staged_topics),
                arming=self._arming.model_copy(deep=True) if self._arming else None,
                dropped_messages=None,
                integrity="unknown",
                git_sha=os.environ.get("KAIROS_GIT_SHA") or None,
                disk_free_bytes=self._disk_free_bytes(),
            )
        message_count, size = 0, 0
        if self._capture_id is not None:
            meta = self._read_rosbag2_metadata(self._capture_id)
            if meta is not None:
                message_count = self._message_count(meta)
            # bytes is the real on-disk size (metadata files[].size is absent).
            size = self._recorded_bytes(self._capture_id)
        return RecordStatusResponse(
            state=self._state,
            run_id=self._run_id,
            capture_id=self._capture_id,
            live_capture_ids=self._live_capture_ids_locked(),
            disarmed_capture_id=disarmed_capture_id,
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
            git_sha=os.environ.get("KAIROS_GIT_SHA") or None,
            disk_free_bytes=self._disk_free_bytes(),
        )

    def _live_capture_ids_locked(self) -> list[str]:
        """The status endpoint's ``live_capture_ids``: what this recorder owns.

        The orchestrator's rebuild MUST skip every id returned here (§8 rule 1,
        §3.3). An armed capture has a directory but no manifest at all; a
        recording one has a manifest that still says ``recording``. Adopting
        either would turn a capture that is being written right now into an
        ``interrupted`` row — and the finalise that follows would then be
        writing to a capture the orchestrator already considers finished.
        """
        if self._state is RunState.armed and self._armed is not None:
            return [self._armed.capture_id]
        if self._state in _ACTIVE_STATES and self._capture_id is not None:
            return [self._capture_id]
        return []

    def _write_manifest(
        self, ended_at: str | None = None, error: str | None = None
    ) -> None:
        """Write the capture's ``object_manifest.json`` (§3).

        One file replaces the pre-v2 pair (manifest.json + session.json) that
        could disagree about the same recording. Written at every point the
        recorder's view changes: the commit that starts the capture, the
        transition to ``stopping``, and finalise.

        ``digest_state`` is always ``pending`` and ``files``/``manifest_digest``
        are always null here: the recorder is the sole writer only up to the
        terminal state, and the per-file hashes are the orchestrator's single
        atomic write afterwards (§3.3). Writing anything else would be claiming
        work this process never did.

        A write failure is logged, not raised — recording must not depend on a
        sidecar landing (§9-5), and the live capture is excluded from rebuild
        by the status endpoint's ``live_capture_ids`` for exactly the window
        in which the manifest may be missing or stale.
        """
        capture_id = self._capture_id
        run_id = self._run_id
        if capture_id is None or run_id is None:
            return
        meta = self._read_rosbag2_metadata(capture_id)
        manifest = ObjectManifestV2(
            extra={"stamp": self._stamp} if self._stamp else {},
            capture_id=capture_id,
            source_instance_id=self._instance_id,
            run_id=run_id,
            state=str(self._state),
            started_at=self._started_at or utc_now_iso8601(),
            operator=self._operator,
            task=self._task,
            robot=self._robot,
            ended_at=ended_at,
            topics=tuple(topic.model_dump(mode="json") for topic in self._topics),
            # Finalised counters (OL-①.5): None until the bag's metadata exists.
            message_count=self._message_count(meta) if meta is not None else None,
            bytes=self._recorded_bytes(capture_id),
            compression=str(self._compression),
            split=self._split.model_dump(mode="json") if self._split else None,
            dropped_messages=self._dropped_messages,
            integrity=self._integrity,
            error=error,
            digest_state=DigestState.pending.value,
            files=None,
            manifest_digest=None,
        )
        try:
            write_object_manifest(self._capture_dir(capture_id), manifest)
        except OSError:
            logger.exception(
                "could not write object_manifest.json",
                extra={"capture_id": capture_id, "component": "recorder"},
            )
        # Keep the capture dir host-writable (root container -> host user / the
        # orchestrator's delete, which renames it into .trash as uid 1000).
        self._make_host_writable(self._capture_dir(capture_id))

    def get_metadata(self) -> dict[str, Any]:
        """The last capture's rosbag2 metadata + its object manifest."""
        with self._lock:
            capture_id = self._capture_id
            run_id = self._run_id
        if capture_id is None:
            raise ApiError(
                status_code=404,
                code="no_recording",
                message="No recording has been made yet.",
            )
        read = read_object_manifest(self._capture_dir(capture_id))
        if read.status is SidecarStatus.missing:
            raise ApiError(
                status_code=404,
                code="manifest_not_found",
                message="No object manifest for the requested capture.",
                details={"capture_id": capture_id},
            )
        if read.manifest is None:
            # Unreadable is not absent (§8 rule 4): reporting a corrupt manifest
            # as 404 would tell the caller the capture never existed.
            raise ApiError(
                status_code=500,
                code="manifest_corrupt",
                message="The capture's object manifest could not be read.",
                details={"capture_id": capture_id, "error": read.error},
            )
        meta = self._read_rosbag2_metadata(capture_id)
        return {
            "capture_id": capture_id,
            "run_id": run_id,
            "manifest": read.manifest.to_json(),
            "rosbag2_metadata": meta,
            # Real on-disk total of the recorded MCAP files; the orchestrator
            # reads this (rosbag2 metadata files[].size is absent in this format).
            "bytes": self._recorded_bytes(capture_id),
        }

    def reconcile_on_startup(self) -> None:
        """Finalise captures a previous process left mid-flight.

        Scans ``objects/`` for manifests still in ``recording``/``stopping`` —
        the only states this process would still own had it not died — and
        rewrites them so the audit trail reflects the crash/restart. The new
        state comes from the same discriminator finalise and the rebuild use:
        a capture with a bag is ``interrupted``, one without ever produced
        nothing and is ``failed``.

        Directories with **no manifest at all** are reclaimed here too (see
        :meth:`_adopt_manifestless_capture`). They can only be this recorder's
        own abandoned arm or start — imports land atomically from
        ``.incoming/`` — and leaving them would break §2's invariant that an
        incomplete directory under ``objects/`` means a live capture, which is
        exactly what makes the orchestrator's scan trustworthy.

        Every other manifest is left strictly alone (§3.3). Once a capture is
        terminal the orchestrator's digest job is its sole writer, and a
        rewrite from here would race — or silently undo — the single atomic
        write that seals ``files``/``manifest_digest``. A corrupt manifest is
        reported and left as it is, never repaired (§8 rule 4).
        """
        root = self._objects_root()
        try:
            children = sorted(root.iterdir())
        except FileNotFoundError:
            return
        except OSError:
            logger.exception("could not scan %s for interrupted captures", root)
            return

        for child in children:
            # Nothing kairos writes under objects/ is a symlink, and following
            # one would let a planted link redirect a manifest rewrite outside
            # the store entirely.
            if child.is_symlink() or not child.is_dir():
                continue
            capture_id = child.name
            if not is_uuid7(capture_id):
                continue
            self._recover_capture(child, capture_id)

    def _recover_capture(self, path: Path, capture_id: str) -> None:
        """Rewrite one crashed capture's manifest, if it is ours to rewrite."""
        read = read_object_manifest(path)
        if read.status is SidecarStatus.corrupt:
            logger.error(
                "capture manifest is unreadable; leaving it untouched",
                extra={
                    "capture_id": capture_id,
                    "error": read.error,
                    "component": "recorder",
                },
            )
            return
        if read.status is SidecarStatus.missing:
            self._adopt_manifestless_capture(path, capture_id)
            return
        manifest = read.manifest
        if manifest is None or manifest.state not in UNFINALIZED_STATES:
            return
        if manifest.capture_id != capture_id:
            # The manifest names a different capture than the directory it sits
            # in. Rewriting it would stamp this directory's id onto whatever
            # that other capture actually is.
            logger.error(
                "capture manifest names another capture; leaving it untouched",
                extra={
                    "capture_id": capture_id,
                    "manifest_capture_id": manifest.capture_id,
                    "component": "recorder",
                },
            )
            return

        recovered_state = (
            CaptureState.interrupted.value
            if has_bag(path)
            else CaptureState.failed.value
        )
        # Siblings first: the manifest write is the handoff (§3.3), and adding
        # recorder.log to the directory afterwards would leave the digest job's
        # sealed file list describing a directory that no longer matches.
        self._archive_log(capture_id)
        self._cleanup_qos_file(capture_id)
        self._cleanup_storage_config(capture_id)
        # Re-measure rather than carrying the last manifest's numbers forward.
        # Those were written at start, before the recording ran; a crash after
        # an hour would otherwise be filed as the few kilobytes that existed in
        # its first second, and the drop count the process reported on its way
        # down would never be read at all.
        meta = self._read_rosbag2_metadata(capture_id)
        recovered = replace(
            manifest,
            state=recovered_state,
            ended_at=manifest.ended_at or utc_now_iso8601(),
            error=(
                manifest.error
                or f"recorder restarted while the capture was {manifest.state}"
            ),
            message_count=(
                self._message_count(meta)
                if meta is not None
                else manifest.message_count
            ),
            bytes=self._recorded_bytes(capture_id),
            dropped_messages=self._scan_dropped_messages(capture_id),
            integrity="failed",
            digest_state=DigestState.pending.value,
            files=None,
            manifest_digest=None,
        )
        try:
            write_object_manifest(path, recovered)
        except OSError:
            logger.exception(
                "could not rewrite the interrupted capture's manifest",
                extra={"capture_id": capture_id, "component": "recorder"},
            )
            return
        self._make_host_writable(path)
        logger.info(
            "recovered a capture left mid-flight",
            extra={
                "capture_id": capture_id,
                "run_id": manifest.run_id,
                "state": recovered_state,
                "component": "recorder",
            },
        )

    def _adopt_manifestless_capture(self, path: Path, capture_id: str) -> None:
        """Reclaim an ``objects/<id>/`` that has no manifest at all.

        Such a directory can only be this recorder's own abandoned work: an arm
        or a start that died between ``ros2 bag record`` creating its output
        directory and the first manifest write. Imports never produce one —
        they are completed under ``.incoming/`` and moved in with a single
        ``os.replace`` (§2) — so there is no third party whose directory this
        could be, and leaving it in place would break the invariant that an
        incomplete directory under ``objects/`` means a *live* capture.

        Whether it is worth keeping is decided by the same discriminator as
        everywhere else. Bytes on disk become an ``interrupted`` capture with a
        synthesized manifest, because throwing away a recording just for
        missing its sidecar is not a call this function gets to make. Nothing on
        disk is deleted outright: a crash while armed is materially a disarm,
        and a disarm writes no failure record.
        """
        if self._holds_recorded_data(path):
            self._synthesize_manifest(path, capture_id)
            return
        # No bag: remove the directory and the siblings that only made sense
        # while it was being spawned into.
        removed = self._remove_capture_dir(capture_id)
        self._cleanup_qos_file(capture_id)
        self._cleanup_storage_config(capture_id)
        _recorder_log_path(self._objects_root(), capture_id).unlink(missing_ok=True)
        if removed:
            # Only when it is genuinely gone: _remove_capture_dir has already
            # warned about residue, and announcing a removal on top of that
            # would leave two log lines flatly contradicting each other for
            # whoever reads them during an incident.
            logger.warning(
                "removed an empty capture directory left by a crash while armed "
                "or starting; no bag was ever written, so there is nothing to "
                "recover",
                extra={"capture_id": capture_id, "component": "recorder"},
            )

    def _synthesize_manifest(self, path: Path, capture_id: str) -> None:
        """Write an ``interrupted`` manifest for a capture that never got one.

        Every field is best-effort: the operator, task and topic selection died
        with the process that knew them. What can be measured is measured, and
        what cannot falls back to the same ``unknown_*`` placeholders a live
        start uses — deliberately NOT null. Null operator/task is §3.3's
        import-only spelling, which ``bag_import`` sets to say "this capture
        came from somewhere else"; a recovered capture was recorded right here,
        and borrowing the import spelling would misfile its origin. ``unknown_*``
        fabricates nothing: it is the same honest "we don't know" the live path
        already writes when a standalone start names no operator.

        The ``run_id`` is synthesized from the directory's mtime because the
        manifest requires one and it is a display name only (§1) — no key, no
        path, nothing that a collision could corrupt.
        """
        stamp = self._directory_timestamp(path)
        self._archive_log(capture_id)
        self._cleanup_qos_file(capture_id)
        self._cleanup_storage_config(capture_id)
        meta = self._read_rosbag2_metadata(capture_id)
        manifest = ObjectManifestV2(
            capture_id=capture_id,
            source_instance_id=self._instance_id,
            run_id="run_recovered_" + stamp.strftime("%Y%m%d_%H%M%S"),
            state=CaptureState.interrupted.value,
            started_at=_iso8601_of(stamp),
            ended_at=utc_now_iso8601(),
            operator=_UNKNOWN_OPERATOR,
            task=_UNKNOWN_TASK,
            robot=self._configured_robot(),
            topics=tuple(
                {"name": name, "type": type_, "qos": None}
                for name, type_ in self._metadata_topics(meta)
            ),
            message_count=self._message_count(meta) if meta is not None else None,
            bytes=self._recorded_bytes(capture_id),
            dropped_messages=self._scan_dropped_messages(capture_id),
            integrity="failed",
            error=(
                "recovered from bytes on disk: the recorder died before it wrote "
                "a manifest, so operator, task and settings are unknown"
            ),
            digest_state=DigestState.pending.value,
        )
        try:
            write_object_manifest(path, manifest)
        except OSError:
            logger.exception(
                "could not synthesize a manifest for an orphaned capture",
                extra={"capture_id": capture_id, "component": "recorder"},
            )
            return
        self._make_host_writable(path)
        logger.warning(
            "adopted a capture directory that had no manifest; it holds a bag, "
            "so it was recovered as interrupted with synthesized metadata",
            extra={
                "capture_id": capture_id,
                "run_id": manifest.run_id,
                "component": "recorder",
            },
        )

    @staticmethod
    def _holds_recorded_data(path: Path) -> bool:
        """Whether a manifest-less directory is worth keeping: real bytes or none.

        Stricter than :func:`has_bag` on purpose, and only for this decision.
        ``has_bag`` answers "is there a bag here" for a capture that already has
        a manifest, where a row exists either way and agreeing with the
        rebuild's spelling is what matters (§8 rule 2). Here the question is
        whether to *invent* a capture, and the difference is a single file: a
        paused ``ros2 bag record`` creates its storage file the moment it
        starts, so a crash while armed leaves a 0-byte ``.mcap`` and nothing
        else. Counting that as a recording would publish an empty capture with
        fabricated metadata for an operator to puzzle over, when the honest
        reading is that the arm was cancelled by the crash.
        """
        if (path / ROSBAG2_METADATA_FILENAME).is_file():
            return True
        try:
            return any(mcap.stat().st_size > 0 for mcap in path.glob("*.mcap"))
        except OSError:
            return False

    @staticmethod
    def _directory_timestamp(path: Path) -> datetime:
        """The capture directory's mtime — when its last bytes were written."""
        try:
            return datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
        except OSError:
            return datetime.now(UTC)

    @staticmethod
    def _metadata_topics(meta: dict[str, Any] | None) -> list[tuple[str, str | None]]:
        """``(name, type)`` for every topic rosbag2 recorded, or an empty list."""
        if meta is None:
            return []
        topics: list[tuple[str, str | None]] = []
        for item in meta.get("topics_with_message_count") or []:
            tmeta = (item or {}).get("topic_metadata") or {}
            name = tmeta.get("name")
            if name:
                topics.append((name, tmeta.get("type")))
        return topics
