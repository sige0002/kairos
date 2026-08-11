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
import shutil
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
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
    CaptureState,
    DigestState,
    ObjectManifestV2,
    SidecarStatus,
    capture_dir,
    objects_dir,
    read_object_manifest,
    write_failed_start,
    write_object_manifest,
)
from kairos_common.ids import new_capture_id
from kairos_common.instance import load_or_create_instance

# Imported for exactly one predicate, deliberately: "does this capture hold data"
# decides ``interrupted`` vs ``failed`` in BOTH finalise and the orchestrator's
# rebuild, and the two must never drift apart (§8 rule 2). Nothing here waits on
# a rebuild — §9-5 forbids that, and this is a pure function over a directory.
from kairos_common.rebuild import has_bag

# The operator/task placeholders a RECORDED capture falls back to. Shared with
# the orchestrator's /api/v1/record/start so both entry points into a recording
# write the SAME values — they used to be two copies kept in step by a comment.
from kairos_common.record_meta import UNKNOWN_OPERATOR, UNKNOWN_TASK, default_meta
from kairos_common.time import utc_iso8601_of

from rosbag2_recorder import arming, integrity, preflight, startup_recovery

# Re-exported, not redefined: the constant belongs with the readiness gate that
# uses it (arming.py), but ``rosbag2_recorder.recorder`` is where the recorder's
# ROS node name has always been imported from.
from rosbag2_recorder.arming import RECORDER_NODE_NAME as RECORDER_NODE_NAME
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

# How long to wait for the bag process to exit after SIGINT before escalating.
STOP_TIMEOUT_S = 30.0

# How long to wait after the final SIGKILL. Short on purpose: SIGKILL cannot be
# caught, blocked or ignored, so this only has to cover the kernel tearing the
# process down — not another grace period. The one case it can expire is a
# process wedged in uninterruptible sleep (D state, e.g. a hung disk write),
# which dies the instant that I/O returns; waiting a second STOP_TIMEOUT_S for
# that would just hold the stop open with nothing left to escalate to.
KILL_TIMEOUT_S = 5.0

# After spawning ``ros2 bag record`` we wait up to this long for it to create
# its --output directory (proof it passed its own "folder exists" check and
# started). If the process exits before the dir appears, treat it as a start
# failure rather than reporting "recording".
START_DIR_TIMEOUT_S = 3.0
START_DIR_POLL_S = 0.05

# How often the MAX_RECORD_BYTES watcher checks the on-disk size while recording.
SIZE_POLL_S = 2.0


def _stop_flush_delay_s() -> float:
    """Test-only injected flush delay (``KAIROS_STOP_FLUSH_DELAY_S``, 0 = off).

    Holds the session in ``stopping`` before the stop signal, modelling the
    multi-second cache drain of a LARGE bag. It exists for the acceptance
    suite: its 61 MB fixture flushes in milliseconds, so the console's
    stop-confirmation polling ran zero real iterations and its regressions
    were invisible (the 2026-08-07 timing sweep's finding on 36ec49e). Never
    set in production.
    """
    try:
        return max(0.0, float(os.environ.get("KAIROS_STOP_FLUSH_DELAY_S", "")))
    except ValueError:
        return 0.0


# Return codes that count as a clean shutdown of ``ros2 bag record`` on the stop
# path. We stop it with SIGINT: a process that catches SIGINT and exits cleanly
# returns 0; one terminated by the signal reports ``-SIGINT`` (-2 via Popen) or
# the shell-convention 130 (128 + SIGINT). Anything else (SIGTERM escalation,
# disk-full crash, non-zero error exit) is abnormal -> the run is ``failed``.
_CLEAN_STOP_RETURNCODES = frozenset({0, 130, -int(signal.SIGINT)})

# States in which a session is actively holding (or finalising) the subprocess.
_ACTIVE_STATES = frozenset({RunState.recording, RunState.stopping})


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


def _iso8601_after(seconds: float) -> str:
    """ISO8601 (Z-suffixed, ms precision) *seconds* from now.

    Used for the arming auto-resume deadline (``resume_at``).
    """
    return utc_iso8601_of(datetime.now(UTC) + timedelta(seconds=seconds))


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


@dataclass
class _Spawned:
    """What :meth:`RecorderSession._spawn_and_await` hands back on success.

    A live, confirmed-up ``ros2 bag record`` plus everything its two callers
    need afterwards: ``prepare()`` parks all of it on an :class:`_Armed`, while
    ``start()`` only commits the capture and its staged topics. ``arm_result``
    is whatever the injected arming step returned — ``_prepare_arm``'s
    ``(node, resume_client, is_paused_client, owns_rclpy)`` for ``prepare()``,
    and ``None`` for ``start()`` (whose gate resumes rather than handing back
    clients, and may not have run at all).
    """

    capture_id: str
    staged_topics: list[TopicEntry]
    qos_path: Path | None
    storage_config_path: Path | None
    # Pre-spawn stamp, kept for the failure records. NOT the capture's
    # started_at: start() re-reads the clock once the bag is actually up.
    started_at: str
    process: subprocess.Popen[bytes]
    arm_result: Any


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
        """Raise if the recorder cannot serve recordings (readiness probe)."""
        preflight.ensure_ready(self)

    def _check_writable_and_space(self) -> None:
        """Raise 507 if ``/data/objects`` is not writable or space is low."""
        preflight.check_writable_and_space(self)

    def _check_cache_ram(self) -> None:
        """Raise 507 if the configured record cache needs more RAM than is free."""
        preflight.check_cache_ram(self)

    @staticmethod
    def _available_ram_bytes() -> int | None:
        """Free RAM in bytes from ``/proc/meminfo`` MemAvailable (None if absent)."""
        return preflight.available_ram_bytes()

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

    def _spawn_and_await(
        self,
        request: RecordStartRequest,
        run_id: str,
        *,
        force_paused: bool,
        arm: Callable[[str, list[str], bool], Any] | None,
        file_failure: bool = True,
    ) -> _Spawned:
        """Mint the capture, spawn ``ros2 bag record``, and confirm it came up.

        The spawn path ``prepare()`` and the synchronous ``start()`` share: stage
        the topic selection, mint the capture_id, materialise the QoS and
        storage-config siblings, build the argv, reset the integrity state,
        spawn, wait for the output dir, then run the arming gate. Each failure
        raises 507 and leaves the store the way §3.4 requires — a
        ``.failed.json`` sibling and nothing else.

        ``file_failure=False`` (the ``prepare()`` path) reports failures in the
        error response only, without minting the ``.failed.json`` sibling: a
        pre-arm is a background readiness probe the console repeats every 30 s,
        not an operator's attempt to record, so a persistent arm blocker (topic
        mismatch, disk full) must not deposit an unbounded pile of failed
        captures in the store while nothing tells the operator (timing sweep
        S2-7). The failure still reaches the operator — the console surfaces
        the failing pre-arm live — and an actual ``start()`` against the same
        blocker files normally.

        The callers differ only in how the subprocess is paused and armed.
        ``prepare()`` passes ``force_paused=True`` (arming without pausing first
        would begin writing immediately, defeating two-phase start) and arms via
        ``_prepare_arm``, which matches subscriptions and hands back a live node
        + clients WITHOUT resuming. ``start()`` passes ``force_paused=False`` —
        ``_build_command`` still adds ``--start-paused`` on its own when
        ``recording.start_paused`` is on — and arms via ``_arm_and_resume``,
        which resumes and returns nothing; ``arm=None`` skips the gate entirely.

        Caller holds ``self._lock``.
        """
        topics = request.topics
        # Freeze the topic selection. For an explicit list we record each name
        # now; "all" is expanded by rosbag2 at the DDS layer and reconciled from
        # metadata.yaml at finalise time. Staged in a local and committed to
        # self._topics only on success, so a failed start cannot leave the
        # previous run's status carrying these topics.
        selected = list(topics) if topics != "all" else []
        staged_topics = [
            TopicEntry(name=name, qos=self._resolve_qos(name, request))
            for name in selected
        ]

        # The capture's identity is minted HERE, before the spawn: the
        # subprocess immediately owns objects/<capture_id>/, so the id has to
        # exist first (§1).
        capture_id = new_capture_id()

        # The QoS file is a sibling of the capture dir; the capture dir itself
        # must NOT exist before spawn (ros2 bag record refuses a pre-existing
        # --output). So nothing here may create it.
        qos_path = self._materialise_qos(capture_id, selected, request)
        storage_config_path = self._materialise_storage_config(capture_id, request)
        cmd = self._build_command(
            capture_id,
            topics,
            request,
            qos_path,
            storage_config_path,
            force_paused=force_paused,
        )

        # Fresh integrity state for this attempt; _spawn_process captures the
        # recorder's stdout+stderr here so finalise can scan it for drops.
        self._dropped_messages = None
        self._integrity = "unknown"
        self._pending_log_path = _recorder_log_path(self._objects_root(), capture_id)

        started_at = utc_now_iso8601()
        try:
            process = self._spawn_process(cmd)
        except (OSError, ValueError) as exc:
            marker_error = self._record_or_discard_failure(
                file_failure,
                capture_id,
                run_id,
                started_at,
                request,
                staged_topics,
                str(exc),
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
            # Kill a still-alive but stuck process so it cannot later create the
            # output dir behind our back, then clear any directory it managed to
            # create in the meantime — it was alive a moment ago and may have
            # created the dir just as we gave up on it. This keeps §3.4 exact: a
            # failed start is a .failed.json sibling and NOTHING else, never a
            # marker plus a directory the next scan reads as a capture.
            self._terminate_failed_start(process)
            returncode = process.returncode
            self._remove_capture_dir(capture_id)
            marker_error = self._record_or_discard_failure(
                file_failure,
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

        # The bag process is up. When spawned --start-paused it is now waiting
        # paused: bring subscriptions live before anything is recorded, so the
        # bag begins with all topics subscribed (no dropped first frames during
        # DDS discovery). FAIL-SAFE: any failure here must NOT leave a paused
        # recorder silently capturing nothing — kill it and fail the start.
        # Reset the arming snapshot for this attempt; populated below only when
        # the readiness gate actually runs.
        self._arming = None
        arm_result: Any = None
        if arm is not None:
            try:
                arm_result = arm(run_id, selected, topics == "all")
            except Exception as exc:  # noqa: BLE001 - convert to a clean fail
                self._terminate_failed_start(process)
                self._remove_capture_dir(capture_id)
                # Drop the partial arming snapshot; this session never started.
                self._arming = None
                marker_error = self._record_or_discard_failure(
                    file_failure,
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

        return _Spawned(
            capture_id=capture_id,
            staged_topics=staged_topics,
            qos_path=qos_path,
            storage_config_path=storage_config_path,
            started_at=started_at,
            process=process,
            arm_result=arm_result,
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

            # ALWAYS spawn --start-paused here, regardless of
            # recording.start_paused, and arm WITHOUT resuming: the matched
            # node + Resume/IsPaused clients come back alive so a later
            # start() is just a resume call. file_failure=False: a failed
            # pre-arm probe answers its caller but is not filed as a failed
            # capture (S2-7) — only an operator's start() files.
            spawned = self._spawn_and_await(
                request,
                run_id,
                force_paused=True,
                arm=self._prepare_arm,
                file_failure=False,
            )
            capture_id = spawned.capture_id
            node, resume_client, is_paused_client, owns_rclpy = spawned.arm_result

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
                staged_topics=spawned.staged_topics,
                started_at=spawned.started_at,
                previous_state=previous_state,
                process=spawned.process,
                qos_path=spawned.qos_path,
                storage_config_path=spawned.storage_config_path,
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
            # The live-config QoS patterns are spawn-affecting (they were
            # materialised into the armed session's overrides file): a config
            # switched between prepare and start must disarm, not resume with
            # the previous config's QoS (S1-3).
            and prepared.qos_override_patterns == request.qos_override_patterns
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
        self._operator = default_meta(request.operator, UNKNOWN_OPERATOR)
        self._stamp = self._build_stamp(request.console_stamp)
        self._task = default_meta(request.task, UNKNOWN_TASK)
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

            # No prepare() ran (or its armed session did not match), so this
            # spawns its own subprocess and mints the capture's identity (§1).
            # force_paused is False here — _build_command still adds
            # --start-paused on its own when recording.start_paused is on, and
            # the gate that resumes it runs only in that same case.
            spawned = self._spawn_and_await(
                request,
                run_id,
                force_paused=False,
                arm=self._arm_and_resume if self._start_paused_enabled() else None,
            )
            capture_id = spawned.capture_id

            self._process = spawned.process
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
            # to normalize them) still names one (see UNKNOWN_OPERATOR).
            self._operator = default_meta(request.operator, UNKNOWN_OPERATOR)
            self._stamp = self._build_stamp(request.console_stamp)
            self._task = default_meta(request.task, UNKNOWN_TASK)
            self._robot = self._resolve_robot(request)
            self._topics = spawned.staged_topics
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
        """Wait for subscription match, then resume the paused subprocess."""
        arming.arm_and_resume(self, run_id, topics, all_mode)

    def _prepare_arm(
        self, run_id: str, topics: list[str], all_mode: bool
    ) -> tuple[Any, Any, Any, bool]:
        """Wait for subscription match and create MATCHED Resume/IsPaused clients."""
        return arming.prepare_arm(self, run_id, topics, all_mode)

    def _resume_armed(self, armed: _Armed) -> None:
        """Resume an armed subprocess via its already-matched clients."""
        arming.resume_armed(armed)

    def _teardown_armed_rclpy(self, armed: _Armed) -> None:
        """Destroy the armed session's held rclpy node (+ shutdown if owned)."""
        arming.teardown_armed_rclpy(armed)

    def _readiness_targets(
        self, node: Any, topics: list[str], all_mode: bool
    ) -> list[str]:
        """Topics the readiness gate waits on: the list, or every published one."""
        return arming.readiness_targets(node, topics, all_mode)

    def _recorder_subscribed(self, node: Any, topic: str) -> bool:
        """True once a publisher exists AND the recorder node has subscribed."""
        return arming.recorder_subscribed(node, topic)

    def _readiness_view(
        self, node: Any, topics: list[str], all_mode: bool
    ) -> tuple[list[str], list[str], list[str]]:
        """One graph read -> ``(matched, unsubscribed, missing)`` for the targets."""
        return arming.readiness_view(self, node, topics, all_mode)

    def _await_recorder_subscribed(
        self,
        rclpy_mod: Any,
        node: Any,
        topics: list[str],
        all_mode: bool,
        timeout: float,
    ) -> None:
        """Poll the ROS graph until the recorder has subscribed, or until timeout."""
        arming.await_recorder_subscribed(
            self, rclpy_mod, node, topics, all_mode, timeout
        )

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
        arming.resume_recorder(rclpy_mod, node, resume_srv, is_paused_srv)

    def _resolve_qos(
        self, topic: str, request: RecordStartRequest
    ) -> QosProfile | None:
        from rosbag2_recorder.qos import resolve_topic_qos

        return resolve_topic_qos(
            topic,
            self._config,
            request.qos_overrides,
            request.qos_default,
            request.qos_override_patterns,
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
            request.qos_override_patterns,
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
        """Messages the in-recorder cache dropped this run, from the captured log."""
        if not capture_id:
            return None
        return integrity.scan_dropped_messages(self._recorder_log_locations(capture_id))

    def _recorder_log_locations(self, capture_id: str) -> tuple[Path, Path]:
        """Where a capture's log can be: the live sibling, then the archived copy."""
        return (
            _recorder_log_path(self._objects_root(), capture_id),
            self._capture_dir(capture_id) / RECORDER_LOG_FILENAME,
        )

    def _classify_integrity(self) -> str:
        """Classify recording integrity from state + cache-drop count."""
        return integrity.classify_integrity(self._state, self._dropped_messages)

    def _archive_log(self, capture_id: str | None) -> None:
        """Move the sibling recorder log into the capture dir (best-effort)."""
        if not capture_id:
            return
        integrity.archive_log(
            _recorder_log_path(self._objects_root(), capture_id),
            self._capture_dir(capture_id) / RECORDER_LOG_FILENAME,
            capture_id,
        )

    def _cleanup_log_file(self, capture_id: str | None) -> None:
        """Close the log handle and drop the sibling log (failed-start paths)."""
        self._close_log_file()
        if capture_id:
            _recorder_log_path(self._objects_root(), capture_id).unlink(missing_ok=True)

    def stop(self) -> RecordStatusResponse:
        """Stop the active session (idempotent).

        Recording -> signal the process group (SIGINT, escalating as far as
        SIGKILL — see :meth:`_signal_and_wait`), wait, finalise, return the
        terminal status. ``armed`` -> disarm (the paused subprocess is killed,
        the empty capture dir removed — there is nothing recorded to flush). Any
        other state — idle, or a stop already in progress (``stopping``) —
        returns the current status unchanged.

        A session that is ``recording`` with no subprocess handle is broken
        rather than idle, and is finalised from disk here instead of being
        reported back unchanged; see the branch below for why that matters.
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
            if self._state is not RunState.recording:
                return self._status_locked()

            if self._process is None:
                # Invariant violation: ``recording`` means this session owns a
                # live subprocess, and it does not. Returning the status
                # unchanged — which is what this used to do — made the state
                # PERMANENT: every later stop() took the same branch, so the
                # session could never be ended through the API again. That is
                # the wedge an operator sees as an endless "stop not confirmed"
                # (the console re-reads status after each stop, finds
                # ``recording`` again, and offers Retry forever).
                #
                # There is no process to signal, so finalise from what is on
                # disk: with a bag the capture is ``interrupted``, without one
                # ``failed`` (the same discriminator every other path uses).
                # Reaching a terminal state is what frees the operator; the log
                # line below is what lets us find out why it happened at all.
                logger.error(
                    "session is `recording` with no subprocess handle; "
                    "finalising from what is on disk to release the session",
                    extra={
                        "run_id": self._run_id,
                        "capture_id": self._capture_id,
                        "component": "recorder",
                    },
                )
                self._state = RunState.stopping
                self._finalise(utc_now_iso8601())
                status = self._status_locked()
                process = None
            else:
                self._state = RunState.stopping
                # Capture-end stamp: the session ends at the operator's stop
                # decision, HERE — not after the SIGINT flush below, which keeps
                # running (and briefly writing already-queued messages) for
                # however long rosbag2 takes to drain (seconds under load /
                # SIGTERM escalation). Stamping after the wait made
                # ended_at - started_at read longer than the session the UI timer
                # showed; the bag's own metadata.yaml keeps the exact data span.
                ended_at = utc_now_iso8601()
                self._write_manifest()
                process = self._process
                status = None

        if process is not None:
            # Signal + wait outside the lock so /status stays responsive; the
            # single active session means no other start can race in (start
            # re-checks state).
            delay = _stop_flush_delay_s()
            if delay > 0:
                time.sleep(delay)
            self._signal_and_wait(process)
            with self._lock:
                self._finalise(ended_at)
                status = self._status_locked()
        # Join the watcher outside the lock (it self-skips if we are it).
        self._stop_size_watcher()
        return status

    def _signal_and_wait(self, process: subprocess.Popen[bytes]) -> None:
        """Stop the bag process group: SIGINT, then SIGTERM, then SIGKILL.

        Each stage waits before escalating (``STOP_TIMEOUT_S``, then
        ``KILL_TIMEOUT_S`` for the last). SIGINT is the one rosbag2 handles
        cleanly — it flushes the cache and writes ``metadata.yaml`` — so the
        later stages only ever run for a recorder that is not responding.

        The SIGKILL stage exists because the first two are *catchable*: a
        ``ros2 bag record`` that ignores or is wedged past both used to be left
        RUNNING while :meth:`_finalise` went on to declare the capture terminal.
        That is the failure an operator sees as "the recorder says it stopped
        but the bag keeps growing" — the process still owns the MCAP and keeps
        appending to a capture the store has already handed to the digest job.
        SIGKILL cannot be caught, blocked or ignored, so the process WILL die.

        The final wait can still expire without the kill having failed: a
        process in uninterruptible sleep (D state, typically blocked on disk
        I/O) is unreapable until that I/O completes, and then dies immediately.
        We log that and return rather than block the stop forever — there is no
        stronger signal to escalate to.

        Signals go to the process GROUP throughout: ``ros2 bag record`` spawns
        children, and killing only the parent would orphan the writers.
        """
        try:
            pgid = os.getpgid(process.pid)
            os.killpg(pgid, signal.SIGINT)
        except ProcessLookupError:
            return  # Already gone.
        try:
            process.wait(timeout=STOP_TIMEOUT_S)
            return
        except subprocess.TimeoutExpired:
            logger.warning("bag process did not exit on SIGINT; sending SIGTERM")
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            process.wait(timeout=STOP_TIMEOUT_S)
            return
        except ProcessLookupError:
            return  # Exited between the timeout and the signal.
        except subprocess.TimeoutExpired:
            logger.error("bag process did not exit on SIGTERM; sending SIGKILL")
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            process.wait(timeout=KILL_TIMEOUT_S)
        except ProcessLookupError:
            return  # Exited between the timeout and the signal.
        except subprocess.TimeoutExpired:
            # Not "the kill was refused" — SIGKILL cannot be. The process is in
            # uninterruptible sleep and will go the moment its I/O returns.
            logger.error(
                "bag process still present %.0fs after SIGKILL; it is in "
                "uninterruptible sleep and will exit when that I/O completes",
                KILL_TIMEOUT_S,
            )

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

    def _record_or_discard_failure(
        self,
        file_failure: bool,
        capture_id: str,
        run_id: str,
        started_at: str,
        request: RecordStartRequest,
        topics: list[TopicEntry],
        error: str,
    ) -> str | None:
        """Dispatch a spawn/arm failure to :meth:`_fail`, or clean up silently.

        The silent branch (``file_failure=False``, the pre-arm probe) removes
        the same sibling files :meth:`_fail` would but writes no
        ``.failed.json``: the store must not accumulate a failed capture per
        keep-alive attempt (S2-7). The failure is still logged here — the log
        line is then the only durable trace, which is the point.
        """
        if file_failure:
            return self._fail(capture_id, run_id, started_at, request, topics, error)
        logger.warning(
            "pre-arm failed; not filed as a capture (background probe)",
            extra={
                "capture_id": capture_id,
                "run_id": run_id,
                "error": error,
                "component": "recorder",
            },
        )
        self._cleanup_qos_file(capture_id)
        self._cleanup_storage_config(capture_id)
        self._cleanup_log_file(capture_id)
        return None

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
            operator=default_meta(request.operator, UNKNOWN_OPERATOR),
            task=default_meta(request.task, UNKNOWN_TASK),
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

    # -- startup reconciliation ---------------------------------------------

    def reconcile_on_startup(self) -> None:
        """Finalise captures a previous process left mid-flight."""
        startup_recovery.reconcile_on_startup(self)

    def _recover_capture(self, path: Path, capture_id: str) -> None:
        """Rewrite one crashed capture's manifest, if it is ours to rewrite."""
        startup_recovery.recover_capture(self, path, capture_id, now=utc_now_iso8601)

    def _adopt_manifestless_capture(self, path: Path, capture_id: str) -> None:
        """Reclaim an ``objects/<id>/`` that has no manifest at all."""
        startup_recovery.adopt_manifestless_capture(
            self,
            path,
            capture_id,
            log_path=_recorder_log_path(self._objects_root(), capture_id),
        )

    def _synthesize_manifest(self, path: Path, capture_id: str) -> None:
        """Write an ``interrupted`` manifest for a capture that never got one."""
        startup_recovery.synthesize_manifest(
            self, path, capture_id, now=utc_now_iso8601
        )

    @staticmethod
    def _holds_recorded_data(path: Path) -> bool:
        """Whether a manifest-less directory is worth keeping: real bytes or none."""
        return startup_recovery.holds_recorded_data(path)

    @staticmethod
    def _directory_timestamp(path: Path) -> datetime:
        """The capture directory's mtime — when its last bytes were written."""
        return startup_recovery.directory_timestamp(path)

    @staticmethod
    def _metadata_topics(meta: dict[str, Any] | None) -> list[tuple[str, str | None]]:
        """``(name, type)`` for every topic rosbag2 recorded, or an empty list."""
        return startup_recovery.metadata_topics(meta)
