"""Realtime demo detectors (pure logic, no dora/ROS imports).

Honesty first: these are DEMO-grade heuristics that prove the live-analysis
lane end to end — they are labeled ``demo`` in every emitted event and are not
trained models. Detector state is per topic; inputs are the bridge-decoded
dict form of a message plus its arrival metadata.

Detectors:
- ``joint_velocity``: z-score spike of the mean |velocity| derived from
  consecutive JointState positions (works even when velocity[] is empty).
- ``stamp_lag``: header.stamp lagging arrival time beyond a threshold —
  catches a stalled driver or a wrong clock without decoding payload details.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

JOINT_STATE_TYPE = "sensor_msgs/JointState"

Z_THRESHOLD = 4.0
MIN_SAMPLES = 30
STAMP_LAG_WARN_S = 0.5


@dataclass
class Event:
    """One detector finding (the /live/events row)."""

    detector: str
    topic: str
    t: float
    severity: str
    message: str
    value: float | None = None
    grade: str = "demo"

    def as_dict(self) -> dict[str, Any]:
        return {
            "detector": self.detector,
            "topic": self.topic,
            "t": self.t,
            "severity": self.severity,
            "message": self.message,
            "value": self.value,
            "grade": self.grade,
        }


@dataclass
class _Welford:
    """Streaming mean/std (Welford) for the z-score baseline."""

    n: int = 0
    mean: float = 0.0
    m2: float = 0.0

    def push(self, x: float) -> None:
        self.n += 1
        delta = x - self.mean
        self.mean += delta / self.n
        self.m2 += delta * (x - self.mean)

    def std(self) -> float:
        if self.n < 2:
            return 0.0
        return math.sqrt(self.m2 / (self.n - 1))


@dataclass
class JointVelocityDetector:
    """Spike detection on mean |velocity| across joints."""

    threshold: float = Z_THRESHOLD
    min_samples: int = MIN_SAMPLES
    _last: dict[str, tuple[float, list[float]]] = field(default_factory=dict)
    _stats: dict[str, _Welford] = field(default_factory=dict)

    def on_message(
        self, topic: str, decoded: dict[str, Any], recv_t: float
    ) -> Event | None:
        positions = decoded.get("position")
        if not isinstance(positions, list) or not positions:
            return None
        prev = self._last.get(topic)
        self._last[topic] = (recv_t, positions)
        if prev is None:
            return None
        dt = recv_t - prev[0]
        if dt <= 0 or len(prev[1]) != len(positions):
            return None
        speed = sum(abs(a - b) for a, b in zip(positions, prev[1], strict=True)) / (
            len(positions) * dt
        )
        stats = self._stats.setdefault(topic, _Welford())
        if stats.n >= self.min_samples:
            # Floor the std at a fraction of the mean: a perfectly steady
            # baseline (zero variance) must still let a violent spike score.
            std = max(stats.std(), 0.05 * abs(stats.mean), 1e-6)
            z = (speed - stats.mean) / std
            if z >= self.threshold:
                stats.push(speed)
                return Event(
                    detector="joint_velocity",
                    topic=topic,
                    t=recv_t,
                    severity="warn",
                    value=round(z, 2),
                    message=(
                        f"joint speed spike: z={z:.1f} (mean|v|={speed:.3f} rad/s)"
                    ),
                )
        stats.push(speed)
        return None


@dataclass
class StampLagDetector:
    """header.stamp trailing wall-clock arrival by more than the threshold."""

    warn_s: float = STAMP_LAG_WARN_S
    _alerted: set[str] = field(default_factory=set)

    def on_sample(
        self, topic: str, stamp_s: float | None, wall_t: float
    ) -> Event | None:
        if stamp_s is None or stamp_s <= 0:
            return None
        lag = wall_t - stamp_s
        if lag >= self.warn_s:
            if topic in self._alerted:
                return None
            self._alerted.add(topic)
            return Event(
                detector="stamp_lag",
                topic=topic,
                t=wall_t,
                severity="warn",
                value=round(lag, 3),
                message=f"header.stamp lags arrival by {lag:.2f}s",
            )
        self._alerted.discard(topic)
        return None
