# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The image source seam: ROS image topic -> latest BGR frame.

A :class:`FrameSource` produces decoded BGR frames into a :class:`LatestFrame`
buffer. The registry depends only on this Protocol, so its start/stop/idle and
status logic is unit-testable with a :class:`FakeFrameSource` — no live DDS
graph or image codec required.

The real :class:`RosImageSource` runs an rclpy node on a background thread (the
pattern from the ros2-web-integration skill: executor spins off-thread, frames
land in lock-protected shared state). It subscribes to ``sensor_msgs/Image`` or
``sensor_msgs/CompressedImage``, converts each message to a BGR ``numpy`` array
via OpenCV, optionally downscales it (preview is lossy), and pushes it into the
buffer. rclpy / cv2 are imported lazily so this module imports cleanly in the
unit-test environment, where neither is installed.
"""

from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

from webrtc_streamer.frame_queue import LatestFrame

if TYPE_CHECKING:  # pragma: no cover - typing only
    import numpy as np

    Frame = np.ndarray[Any, Any]
else:  # numpy may be absent in the minimal unit-test env; frames are opaque there.
    Frame = Any

logger = logging.getLogger("kairos.webrtc_streamer")


@runtime_checkable
class FrameSource(Protocol):
    """A source of BGR preview frames for one stream.

    Lifecycle is ``start() -> running -> stop()``. Frames are delivered into
    :attr:`frames`; consumers (media tracks) read the latest from there. The
    registry treats sources opaquely through this Protocol.
    """

    @property
    def frames(self) -> LatestFrame[Frame]:
        """The latest-frame-wins buffer this source feeds."""
        ...

    def start(self) -> None:
        """Begin producing frames (idempotent)."""
        ...

    def stop(self) -> None:
        """Stop producing frames and release resources (idempotent)."""
        ...

    @property
    def fps(self) -> float:
        """Recent measured input frame rate (frames/s), 0 if unknown."""
        ...


class _RateMeter:
    """Sliding measure of recent input frame rate over a short window."""

    def __init__(self, window_s: float = 2.0) -> None:
        import time

        self._window_s = window_s
        self._times: list[float] = []
        self._lock = threading.Lock()
        self._clock = time.monotonic

    def tick(self) -> None:
        now = self._clock()
        with self._lock:
            self._times.append(now)
            cutoff = now - self._window_s
            while self._times and self._times[0] < cutoff:
                self._times.pop(0)

    def rate(self) -> float:
        now = self._clock()
        with self._lock:
            cutoff = now - self._window_s
            recent = [t for t in self._times if t >= cutoff]
        if len(recent) < 2:
            return 0.0
        span = recent[-1] - recent[0]
        return (len(recent) - 1) / span if span > 0 else 0.0


class FakeFrameSource:
    """In-memory :class:`FrameSource` for tests (no ROS / OpenCV).

    Tests push frames via :meth:`emit` (or any opaque object — the registry and
    peer manager treat frames opaquely), and read lifecycle state to assert the
    registry's start/stop/idle behaviour without a live DDS graph.
    """

    def __init__(self, fps: float = 0.0) -> None:
        self._frames: LatestFrame[Frame] = LatestFrame()
        self._started = False
        self._fps = fps

    @property
    def frames(self) -> LatestFrame[Frame]:
        return self._frames

    @property
    def fps(self) -> float:
        return self._fps

    @property
    def started(self) -> bool:
        return self._started

    def start(self) -> None:
        self._started = True

    def stop(self) -> None:
        self._started = False
        self._frames.close()

    def emit(self, frame: Frame) -> None:
        """Push one frame into the buffer (no-op once stopped/closed)."""
        self._frames.put(frame)


class RosImageSource:
    """rclpy-backed :class:`FrameSource` for one image topic.

    Subscribes with best-effort / keep-last-1 QoS (preview wants the freshest
    frame, not reliable delivery), decodes each message to BGR via OpenCV, and
    pushes it into :attr:`frames`. The executor spins on a background thread so
    it never blocks the asyncio web server.

    rclpy and OpenCV are imported inside :meth:`start` so importing this module
    (and unit-testing the registry against a fake source) needs neither.
    """

    def __init__(
        self,
        topic: str,
        *,
        max_width: int | None = None,
        max_height: int | None = None,
        node_name: str = "webrtc_streamer_source",
    ) -> None:
        self._topic = topic
        self._max_width = max_width
        self._max_height = max_height
        self._node_name = node_name
        self._frames: LatestFrame[Frame] = LatestFrame()
        self._meter = _RateMeter()
        self._lock = threading.Lock()
        self._started = False
        self._node: Any = None
        self._executor: Any = None
        self._thread: threading.Thread | None = None

    @property
    def frames(self) -> LatestFrame[Frame]:
        return self._frames

    @property
    def fps(self) -> float:
        return self._meter.rate()

    def start(self) -> None:
        try:
            # Serialize direct lifecycle calls as well as registry calls. The
            # source becomes visible as started only after all ROS resources
            # exist and the executor thread has been launched.
            with self._lock:
                if self._started:
                    return
                self._spin_up()
                self._started = True
        except BaseException:
            self._abandon_partial()
            raise

    def _abandon_partial(self) -> None:
        """Roll back resources allocated by an unsuccessful :meth:`start`."""
        with self._lock:
            self._started = False
            node, executor, thread = self._node, self._executor, self._thread
            self._node = self._executor = self._thread = None
        self._teardown(node, executor, thread)

    def _spin_up(self) -> None:
        """Create the rclpy node + subscription and spin it off-thread."""
        import rclpy
        from rclpy.node import Node
        from rclpy.qos import (
            DurabilityPolicy,
            HistoryPolicy,
            QoSProfile,
            ReliabilityPolicy,
        )
        from sensor_msgs.msg import CompressedImage, Image

        if not rclpy.ok():
            rclpy.init()

        node = Node(self._node_name)
        self._node = node
        # Preview QoS: best-effort + keep-last-1 mirrors the latest-frame-wins
        # policy at the DDS layer, so the middleware also drops stale frames.
        qos = QoSProfile(
            reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
        )
        # A topic has exactly ONE type. Subscribing to both Image and
        # CompressedImage on the same name creates a type conflict (rcl raises
        # "invalid allocator"), so resolve the actual type and subscribe once.
        if _is_compressed_topic(node, self._topic):
            node.create_subscription(
                CompressedImage, self._topic, self._on_compressed, qos
            )
        else:
            node.create_subscription(Image, self._topic, self._on_image, qos)

        from rclpy.executors import SingleThreadedExecutor

        executor = SingleThreadedExecutor()
        self._executor = executor
        executor.add_node(node)
        thread = threading.Thread(
            target=executor.spin, name=f"ros-src-{self._topic}", daemon=True
        )
        self._thread = thread
        thread.start()
        logger.info(
            "ros image source started",
            extra={"component": "webrtc_streamer", "topic": self._topic},
        )

    def _on_image(self, msg: Any) -> None:
        from webrtc_streamer.convert import image_to_bgr

        try:
            frame = image_to_bgr(msg)
        except Exception:  # noqa: BLE001 - a bad frame must not kill the source
            logger.exception("failed to decode Image message")
            return
        self._publish(frame)

    def _on_compressed(self, msg: Any) -> None:
        from webrtc_streamer.convert import compressed_image_to_bgr

        try:
            frame = compressed_image_to_bgr(msg)
        except Exception:  # noqa: BLE001
            logger.exception("failed to decode CompressedImage message")
            return
        self._publish(frame)

    def _publish(self, frame: Frame) -> None:
        from webrtc_streamer.convert import downscale_bgr

        frame = downscale_bgr(frame, self._max_width, self._max_height)
        self._meter.tick()
        self._frames.put(frame)

    def stop(self) -> None:
        with self._lock:
            if (
                not self._started
                and self._node is None
                and self._executor is None
                and self._thread is None
            ):
                return
            self._started = False
            node, executor, thread = self._node, self._executor, self._thread
            self._node = self._executor = self._thread = None
        self._frames.close()
        self._teardown(node, executor, thread)
        logger.info(
            "ros image source stopped",
            extra={"component": "webrtc_streamer", "topic": self._topic},
        )

    @staticmethod
    def _teardown(node: Any, executor: Any, thread: threading.Thread | None) -> None:
        """Release a detached set of ROS resources, attempting every step."""
        if executor is not None:
            try:
                executor.shutdown()
            except Exception:  # noqa: BLE001 - best-effort teardown
                logger.exception("error shutting down ros executor")
        if node is not None:
            try:
                node.destroy_node()
            except Exception:  # noqa: BLE001
                logger.exception("error destroying ros node")
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)


def _is_compressed_topic(node: Any, topic: str) -> bool:
    """Decide whether *topic* carries ``CompressedImage`` (vs raw ``Image``).

    Prefer the real type from the ROS 2 graph; if the topic has no publisher yet
    (so the graph doesn't know its type), fall back to the naming convention
    (``.../compressed`` / ``.../compressedDepth``).
    """
    try:
        for name, types in node.get_topic_names_and_types():
            if name == topic and types:
                return any("CompressedImage" in t for t in types)
    except Exception:  # noqa: BLE001 - discovery is best-effort; use the name.
        pass
    return topic.endswith("/compressed") or topic.endswith("/compressedDepth")
