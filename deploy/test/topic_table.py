#!/usr/bin/env python3
"""Live "what's flowing on the graph" table — the observable half of the test
harness.

``ros2 bag play`` is silent: you cannot see which topics are flowing or at what
rate. This node makes a bag replay (or a real robot) *visible*. It discovers
every topic on the ROS 2 graph, subscribes to each with a permissive QoS
(``best_effort`` so it receives from both reliable and best-effort publishers —
the same lesson the recorder/monitor encode), and prints a refreshing table of
per-topic Hz / bandwidth / message count.

It does not deserialize payloads (``raw=True``): it only counts messages and
bytes, so it is cheap even for camera topics.

Usage (inside the rosbag-player image, which already sources ROS 2):

    python3 /topic_table.py                 # run until Ctrl-C
    REFRESH=2 python3 /topic_table.py       # 2s refresh interval
    DURATION=15 python3 /topic_table.py      # auto-exit after 15s (smoke tests)

Environment:
    REFRESH   Seconds between table prints (default 1.0).
    DURATION  Total seconds to run, then exit 0 (default: run forever).
"""

from __future__ import annotations

import os
import sys
import time

import rclpy
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
from rosidl_runtime_py.utilities import get_message

# Infra topics that are noise for a "what's flowing" view.
_HIDE = {"/parameter_events", "/rosout"}

# best_effort reader receives from both reliable and best-effort writers; a
# reliable reader would silently drop best-effort camera streams.
_QOS = QoSProfile(
    reliability=ReliabilityPolicy.BEST_EFFORT,
    durability=DurabilityPolicy.VOLATILE,
    history=HistoryPolicy.KEEP_LAST,
    depth=10,
)


class TopicTable(Node):
    """Subscribe to every discovered topic (raw) and print a periodic table."""

    def __init__(self, refresh_s: float) -> None:
        super().__init__("kairos_topic_table")
        self._refresh_s = refresh_s
        # topic -> {"type", "count", "bytes", "last_count", "last_bytes"}
        self._stats: dict[str, dict] = {}
        self._unresolved: set[str] = set()
        self._last_print = time.monotonic()
        # Redraw the table in place (like `top`) on a real terminal; fall back to
        # append-mode when piped (smoke-test logs / redirected output).
        self._tty = sys.stdout.isatty()
        # Re-scan the graph and (re)print on a timer.
        self.create_timer(refresh_s, self._tick)

    # ---- discovery + subscription ----------------------------------------

    def _discover(self) -> None:
        for name, types in self.get_topic_names_and_types():
            if name in _HIDE or name in self._stats or name in self._unresolved:
                continue
            type_str = types[0] if types else None
            if not type_str:
                continue
            try:
                msg_type = get_message(type_str)
            except (ImportError, ValueError, ModuleNotFoundError):
                # Type not available in this image; skip it (still counted in
                # discovery so we don't retry forever).
                self._unresolved.add(name)
                continue
            self._stats[name] = {
                "type": type_str,
                "count": 0,
                "bytes": 0,
                "last_count": 0,
                "last_bytes": 0,
            }
            self.create_subscription(
                msg_type,
                name,
                self._make_cb(name),
                _QOS,
                raw=True,
            )

    def _make_cb(self, topic: str):
        def _cb(raw: bytes) -> None:
            st = self._stats.get(topic)
            if st is None:
                return
            st["count"] += 1
            st["bytes"] += len(raw)

        return _cb

    # ---- printing --------------------------------------------------------

    def _tick(self) -> None:
        self._discover()
        now = time.monotonic()
        dt = now - self._last_print
        self._last_print = now
        rows = []
        for name in sorted(self._stats):
            st = self._stats[name]
            d_count = st["count"] - st["last_count"]
            d_bytes = st["bytes"] - st["last_bytes"]
            st["last_count"] = st["count"]
            st["last_bytes"] = st["bytes"]
            hz = d_count / dt if dt > 0 else 0.0
            bw = d_bytes / dt if dt > 0 else 0.0
            rows.append((name, st["type"], hz, bw, st["count"]))

        active = sum(1 for r in rows if r[2] > 0)
        lines = [
            f"=== topics on graph: {len(self._stats)} "
            f"(flowing now: {active})  [{time.strftime('%H:%M:%S')}]  "
            f"refresh {self._refresh_s:g}s — Ctrl-C to quit ===",
            f"{'TOPIC':<52} {'Hz':>7} {'BANDWIDTH':>12} {'COUNT':>9}  TYPE",
        ]
        for name, type_str, hz, bw, count in rows:
            mark = " " if hz > 0 else "·"  # dot marks a topic with no traffic now
            lines.append(
                f"{mark}{name:<51} {hz:>7.1f} {_fmt_bw(bw):>12} {count:>9}  {type_str}"
            )
        if self._unresolved:
            skipped = ", ".join(sorted(self._unresolved))
            lines.append(f"(unresolved types, not counted: {skipped})")

        if self._tty:
            # Cursor home + clear-below: redraw in place (no vertical scrolling).
            # Clearing AFTER home handles a shrinking table (fewer rows than last
            # frame) — leftover lines below are wiped.
            sys.stdout.write("\033[H\033[J" + "\n".join(lines) + "\n")
        else:
            sys.stdout.write("\n" + "\n".join(lines) + "\n")
        sys.stdout.flush()


def _fmt_bw(bps: float) -> str:
    if bps >= 1e6:
        return f"{bps / 1e6:.1f} MB/s"
    if bps >= 1e3:
        return f"{bps / 1e3:.1f} kB/s"
    return f"{bps:.0f} B/s"


def main() -> int:
    refresh_s = float(os.environ.get("REFRESH", "1.0"))
    duration = os.environ.get("DURATION")
    deadline = time.monotonic() + float(duration) if duration else None

    rclpy.init()
    node = TopicTable(refresh_s)
    try:
        while rclpy.ok():
            rclpy.spin_once(node, timeout_sec=0.2)
            if deadline is not None and time.monotonic() >= deadline:
                break
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
