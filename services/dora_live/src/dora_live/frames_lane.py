"""Live-frames lane: latest compressed camera payloads, pullable over HTTP.

The robot-side half of future off-robot image analysis (ruled 2026-07-22): a
``frames`` dataflow node forwards ALREADY-COMPRESSED payloads — decimated per
topic — to the control sidecar, and any container on the wired LAN pulls them
from the monitor-compat port (``GET /live/frames`` index + ``GET /live/frame``
payload). Pull (not push) on purpose: the robot never needs to know a
consumer's address, a dead consumer costs the robot nothing, and the consumer
paces its own intake. The PC-side consumer (image validator etc.) is NOT built
yet — this lane is the stable contract it will attach to.

Robot budget rules baked in here:
- No decode / no re-encode on the robot: ``image`` topics forward the JPEG/PNG
  bytes as-is; ``ffmpeg`` topics forward KEYFRAMES ONLY (a keyframe AU is
  standalone-decodable; deltas are useless without decode state, which a
  decimated feed cannot carry); ``raw`` topics are excluded (forwarding
  uncompressed frames would need a robot-side encode = budget violation).
- Latest-frame-wins, one slot per topic (freshness over completeness, same
  philosophy as the WebRTC lane), with a monotonically growing ``seq`` so a
  poller can skip unchanged frames (ETag / 304).

Pure module (no dora / HTTP imports) so the gate and store are unit-testable.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

# Codecs the lane forwards. "raw" is deliberately absent (see module docstring).
FRAMES_CODECS = ("image", "ffmpeg")

_KEYFRAME_FLAG = 0x0001


def frame_eligible(codec: str | None, flags: object) -> bool:
    """Whether a message of *codec* with packet *flags* may enter the lane.

    ``image`` payloads always qualify; ``ffmpeg`` only on a keyframe (missing
    flags = not provably a keyframe = refused, never smeared downstream).
    """
    if codec == "image":
        return True
    if codec == "ffmpeg":
        try:
            return bool(int(flags) & _KEYFRAME_FLAG)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return False
    return False


class SampleGate:
    """Per-topic rate cap: at most ``sample_hz`` forwards per topic."""

    def __init__(self, sample_hz: float) -> None:
        if sample_hz <= 0:
            raise ValueError(f"sample_hz must be > 0: {sample_hz}")
        self._min_interval = 1.0 / sample_hz
        self._last: dict[str, float] = {}
        self._clock = time.monotonic

    def allow(self, topic: str) -> bool:
        now = self._clock()
        last = self._last.get(topic)
        if last is not None and now - last < self._min_interval:
            return False
        self._last[topic] = now
        return True


@dataclass(frozen=True)
class FrameRecord:
    """One stored frame: payload plus the metadata a consumer needs."""

    topic: str
    codec: str  # "image" | "ffmpeg"
    encoding: str  # CompressedImage format (jpeg/png/...) or FFMPEG encoding
    data: bytes
    stamp_ns: int | None
    recv_t: float
    seq: int


class FrameStore:
    """Thread-safe latest-frame-per-topic store behind the pull API.

    ``put`` overwrites (the overwrite IS the drop the lane accepts); ``seq``
    is global-monotonic so ETag comparisons work across topics too.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._frames: dict[str, FrameRecord] = {}
        self._seq = 0

    def put(
        self,
        topic: str,
        *,
        codec: str,
        encoding: str,
        data: bytes,
        stamp_ns: int | None,
        recv_t: float,
    ) -> int:
        with self._lock:
            self._seq += 1
            self._frames[topic] = FrameRecord(
                topic=topic,
                codec=codec,
                encoding=encoding,
                data=data,
                stamp_ns=stamp_ns,
                recv_t=recv_t,
                seq=self._seq,
            )
            return self._seq

    def get(self, topic: str) -> FrameRecord | None:
        with self._lock:
            return self._frames.get(topic)

    def index(self) -> list[dict[str, object]]:
        """Per-topic metadata WITHOUT payloads (the ``/live/frames`` body)."""
        with self._lock:
            records = sorted(self._frames.values(), key=lambda r: r.topic)
        return [
            {
                "topic": r.topic,
                "codec": r.codec,
                "encoding": r.encoding,
                "size_bytes": len(r.data),
                "stamp_ns": r.stamp_ns,
                "recv_t": r.recv_t,
                "seq": r.seq,
            }
            for r in records
        ]


def content_type(codec: str, encoding: str) -> str:
    """HTTP content type for a stored frame payload."""
    if codec == "image":
        e = encoding.lower()
        if "png" in e:
            return "image/png"
        return "image/jpeg"  # CompressedImage default in practice
    return "application/octet-stream"  # ffmpeg keyframe AU
