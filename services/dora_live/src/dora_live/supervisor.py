"""Dataflow supervisor: manifest derivation + ``dora run`` lifecycle.

Startup self-checks (cell-verified failure modes):
- Discovery settle budget defaults to 15 s: cross-RMW (Cyclone<->RustDDS)
  SPDP matching takes ~6-8 s, so a short budget would falsely report topics
  as missing (cell A).
- A silently wrong DDS domain shows up as "0 of N allowlist topics
  discovered" — that state keeps ``pending`` non-empty and readiness false
  rather than pretending health (released dora ignores ROS_DOMAIN_ID; the
  pinned main build honors it, but we never trust that silently).
- Crash-loop guard: repeated ``dora run`` exits within the window mark the
  dataflow dead (readyz goes 503 through the feed subscriber's liveness probe).
"""

from __future__ import annotations

import logging
import os
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from kairos_common import RecordingConfig
from kairos_common.monitoring.models import QosInfo

from dora_live.dataflow_gen import WEBRTC_ENV_KEYS, generate_dataflow, to_yaml
from dora_live.feed_subscriber import DoraFeedSubscriber
from dora_live.live_config import (
    LiveConfig,
    resolve_live_topics,
    resolve_topic_qos,
    resolve_video_codec,
)
from dora_live.manifest import LaneQueues, LiveManifest, LiveTopic

logger = logging.getLogger("kairos.dora_live.supervisor")

DISCOVERY_BUDGET_S = 15.0
RETRY_PERIOD_S = 60.0
CRASH_WINDOW_S = 120.0
CRASH_LIMIT = 3
# Degraded is a cooloff, not a tombstone: after this long the supervisor
# retries on its own (audit finding — a flaky wire tripping the crash-loop
# guard would otherwise brick the live lanes until a manual restart).
DEGRADED_COOLOFF_S = 600.0


def derive_manifest(
    allowlist: list[str],
    discovered: dict[str, str],
    *,
    publisher_qos: dict[str, list[QosInfo]] | None = None,
    live_config: LiveConfig | None = None,
    recording_config: RecordingConfig | None = None,
    queue_size: int | None = None,
) -> tuple[LiveManifest, list[str]]:
    """Allowlist + discovery -> (manifest, pending-without-type).

    Each resolved topic carries its subscription QoS (live override >
    recording override > publisher auto-match) and its video-lane codec
    (config rules > ros-type default) — see :mod:`dora_live.live_config`.
    """
    live = live_config or LiveConfig()
    pub_qos = publisher_qos or {}
    default_depth = (
        recording_config.monitor.qos_depth if recording_config is not None else 30
    )
    topics: list[LiveTopic] = []
    pending: list[str] = []
    for name in allowlist:
        ros_type = discovered.get(name)
        if ros_type is None:
            pending.append(name)
            continue
        qos = resolve_topic_qos(
            name,
            pub_qos.get(name, []),
            live,
            recording_config,
            default_depth=default_depth,
        )
        topics.append(
            LiveTopic(
                name=name,
                ros_type=ros_type,
                qos=qos.reliability,
                durability=qos.durability,
                depth=max(1, qos.depth),
                video=resolve_video_codec(name, ros_type, live),
            )
        )
    metrics_queue = live.queue_size if queue_size is None else queue_size
    return (
        LiveManifest(
            topics=topics,
            queue_size=metrics_queue,
            queues=LaneQueues(
                metrics=(
                    live.queues.metrics
                    if live.queues.metrics is not None
                    else metrics_queue
                ),
                probe=live.queues.probe,
                webrtc=live.queues.webrtc,
                frames=live.queues.frames,
            ),
            frames_enabled=live.frames.enabled,
            frames_sample_hz=live.frames.sample_hz,
        ),
        pending,
    )


def _kill_session(sid: int, sig: int) -> int:
    """Signal every process in session *sid*; returns how many were signalled.

    killpg is NOT enough here: ``dora run`` puts each spawned node into its
    OWN process group (PGID = the node's pid, verified on the pinned build),
    so the leader's group contains only the leader. The session id, however,
    is shared by the whole tree and is immutable — it survives both the
    leader's death and orphan reparenting to PID 1 — and POSIX has no
    ``killsid``, so we sweep ``/proc`` for members. Linux-only, like the rest
    of the deployment.
    """
    count = 0
    for pid_s in os.listdir("/proc"):
        if not pid_s.isdigit():
            continue
        try:
            with open(f"/proc/{pid_s}/stat") as f:
                # Fields after the comm's closing paren: state ppid pgrp session
                if int(f.read().rsplit(")", 1)[1].split()[3]) != sid:
                    continue
            os.kill(int(pid_s), sig)
            count += 1
        except (OSError, ValueError, IndexError):
            continue  # raced away or unreadable — fine
    return count


def _manifest_key(manifest: LiveManifest) -> tuple[Any, ...]:
    """Comparable identity of everything the generated dataflow depends on."""
    return (
        manifest.queue_size,
        tuple(manifest.queues.model_dump().items()),
        manifest.frames_enabled,
        manifest.frames_sample_hz,
        tuple(
            (t.name, t.ros_type, t.qos, t.durability, t.depth, t.video)
            for t in manifest.topics
        ),
    )


class DataflowSupervisor:
    """Owns the dataflow process; restarts it when the manifest changes."""

    def __init__(
        self,
        *,
        config: RecordingConfig | None,
        feed: DoraFeedSubscriber,
        workdir: Path,
        control_url: str,
        live_config: LiveConfig | None = None,
        dora_bin: str = "/opt/venv/bin/dora",
        node_launcher: str = "/run_node.sh",
        discovery_budget_s: float = DISCOVERY_BUDGET_S,
    ) -> None:
        self._config = config
        self._live_config = live_config or LiveConfig()
        self._allowlist = resolve_live_topics(self._live_config, config)
        self._feed = feed
        self._workdir = workdir
        self._control_url = control_url
        self._dora_bin = dora_bin
        self._node_launcher = node_launcher
        self._discovery_budget_s = discovery_budget_s
        self._proc: subprocess.Popen[bytes] | None = None
        self._manifest = LiveManifest()
        self._pending: list[str] = list(self._allowlist)
        self._crashes: list[float] = []
        self._degraded = False
        self._stop_evt = threading.Event()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        feed.set_dataflow_liveness(self.alive)

    # -- public -----------------------------------------------------------

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(
                target=self._run, name="dora-live-supervisor", daemon=True
            )
            self._thread.start()

    def stop(self) -> None:
        self._stop_evt.set()
        self._terminate_proc()
        if self._thread is not None:
            self._thread.join(timeout=15.0)
            self._thread = None

    def reload(self) -> dict[str, Any]:
        """Re-derive the manifest now; restart the dataflow if it changed."""
        changed = self._rederive_and_maybe_restart(force_log=True)
        return {"changed": changed, **self.status()}

    def alive(self) -> bool:
        if self._degraded:
            return False
        if not self._manifest.topics:
            # No dataflow needed yet — not a failure state.
            return not self._pending
        return self._proc is not None and self._proc.poll() is None

    def status(self) -> dict[str, Any]:
        return {
            "topics": [t.name for t in self._manifest.topics],
            "pending": list(self._pending),
            "dataflow_alive": self._proc is not None and self._proc.poll() is None,
            "degraded": self._degraded,
            "allowlist_total": len(self._allowlist),
            # Honesty markers: where the live set came from and what the video
            # lane will actually decode (config rules + type defaults resolved).
            "topics_source": (
                "live_config" if self._live_config.topics is not None else "recording"
            ),
            "qos": {
                t.name: {
                    "reliability": t.qos,
                    "durability": t.durability,
                    "depth": t.depth,
                }
                for t in self._manifest.topics
            },
            "video": {
                t.name: t.video for t in self._manifest.topics if t.video is not None
            },
        }

    # -- internals ----------------------------------------------------------

    def _discovered_types(self) -> dict[str, str]:
        return {
            e.name: e.type for e in self._feed.discover_topics() if e.type is not None
        }

    def _run(self) -> None:
        # Discovery settle: wait for the full allowlist or the budget, whichever
        # comes first (cell A: cross-RMW matching needs ~6-8 s).
        deadline = time.monotonic() + self._discovery_budget_s
        while time.monotonic() < deadline and not self._stop_evt.is_set():
            if set(self._allowlist) <= set(self._discovered_types()):
                break
            time.sleep(0.5)

        # Every iteration is exception-guarded: one bad derive/spawn must never
        # kill the supervision thread (review finding — a dead thread left the
        # service 503 forever with no retry and no crash-loop accounting).
        last_retry = time.monotonic()
        first = True
        while not self._stop_evt.wait(0.0 if first else 1.0):
            try:
                if first or (
                    self._pending and time.monotonic() - last_retry > RETRY_PERIOD_S
                ):
                    if not first:
                        last_retry = time.monotonic()
                    self._rederive_and_maybe_restart(force_log=first)
                    first = False
                self._ensure_running()
            except Exception:
                first = False
                logger.exception("supervisor iteration failed (retrying)")

    def _ensure_running(self) -> None:
        """Keep the dataflow process alive; all _proc access under the lock."""
        with self._lock:
            if self._degraded:
                last = self._crashes[-1] if self._crashes else 0.0
                if time.monotonic() - last < DEGRADED_COOLOFF_S:
                    return
                logger.warning(
                    "degraded cooloff (%.0fs) elapsed — retrying the dataflow",
                    DEGRADED_COOLOFF_S,
                )
                self._degraded = False
                self._crashes.clear()
            if not self._manifest.topics:
                return
            proc = self._proc
            if proc is not None and proc.poll() is None:
                return
            if proc is not None:
                logger.error("dora run exited rc=%s; restarting", proc.returncode)
                # A dead `dora run` can strand node processes (verified: an
                # orphaned webrtc node keeps port 8007 LISTENing and every
                # respawn then dies on EADDRINUSE) — sweep the run's whole
                # SESSION before spawning the replacement.
                swept = _kill_session(proc.pid, signal.SIGKILL)
                if swept:
                    logger.warning("swept %d stranded node process(es)", swept)
                self._note_crash()
                self._proc = None
            if not self._degraded:
                self._spawn()

    def _rederive_and_maybe_restart(self, *, force_log: bool = False) -> bool:
        with self._lock:
            manifest, pending = derive_manifest(
                self._allowlist,
                self._discovered_types(),
                publisher_qos=self._feed.publisher_qos(),
                live_config=self._live_config,
                recording_config=self._config,
            )
            if pending and (force_log or pending != self._pending):
                logger.warning(
                    "topics not yet discoverable (wrong ROS_DOMAIN_ID? robot "
                    "down? cross-RMW settle?): %s",
                    pending,
                )
            # Restart on ANY effective change — topic set, resolved QoS, or the
            # video lane — because a running dataflow can apply none of them.
            # (QoS resolution only re-runs on the rederive cadence: pending
            # retry / explicit /live/reload — publisher churn cannot flap it.)
            changed = _manifest_key(manifest) != _manifest_key(self._manifest)
            self._manifest = manifest
            self._pending = pending
            self._feed.set_topic_types({t.name: t.ros_type for t in manifest.topics})
            if changed:
                self._terminate_proc()
                if manifest.topics:
                    self._spawn()
            return changed

    def _spawn(self) -> None:
        self._workdir.mkdir(parents=True, exist_ok=True)
        dataflow_path = self._workdir / "dataflow.yml"
        common_env = {
            key: os.environ[key]
            for key in ("ROS_DOMAIN_ID", "AMENT_PREFIX_PATH", "RMW_IMPLEMENTATION")
            if key in os.environ
        }
        webrtc_env = {
            key: os.environ[key] for key in WEBRTC_ENV_KEYS if key in os.environ
        }
        dataflow = generate_dataflow(
            self._manifest,
            node_launcher=self._node_launcher,
            common_env=common_env,
            control_url=self._control_url,
            webrtc_env=webrtc_env,
        )
        dataflow_path.write_text(to_yaml(dataflow))
        logger.info(
            "starting dora run: %d topics (%s)",
            len(self._manifest.topics),
            dataflow_path,
        )
        try:
            # New session => `dora run` leads a process group containing every
            # node it spawns, so termination can address the WHOLE tree. A bare
            # terminate() only reached the parent, and its surviving children
            # (the webrtc node holds a LISTEN socket) got reparented to PID 1
            # still owning port 8007 — the next spawn then crash-looped on
            # EADDRINUSE (field incident 2026-07-22, reproduced locally).
            self._proc = subprocess.Popen(  # noqa: S603 - fixed binary, our file
                [self._dora_bin, "run", str(dataflow_path)],
                cwd=self._workdir,
                start_new_session=True,
            )
        except OSError:
            # Missing/broken dora binary: count toward the crash-loop guard so
            # persistent failure degrades loudly instead of retrying forever.
            self._note_crash()
            raise

    def _terminate_proc(self) -> None:
        proc = self._proc
        self._proc = None
        if proc is None:
            return
        if proc.poll() is not None:
            # Already dead — but its nodes may not be (see _kill_session); the
            # session id outlives the leader while any member remains.
            _kill_session(proc.pid, signal.SIGKILL)
            return
        _kill_session(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=10.0)
        except subprocess.TimeoutExpired:
            _kill_session(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5.0)
        # Late stragglers: a node that ignored/outraced SIGTERM would keep its
        # LISTEN socket and EADDRINUSE the next spawn.
        _kill_session(proc.pid, signal.SIGKILL)

    def _note_crash(self) -> None:
        now = time.monotonic()
        self._crashes = [t for t in self._crashes if now - t < CRASH_WINDOW_S]
        self._crashes.append(now)
        if len(self._crashes) >= CRASH_LIMIT:
            logger.error(
                "dataflow crash-looping (%d exits in %.0fs) — marking degraded",
                len(self._crashes),
                CRASH_WINDOW_S,
            )
            self._degraded = True
