# SPDX-License-Identifier: Apache-2.0
"""Native C++ receive/aggregation; Python retains graph, policy and HTTP ownership."""

from __future__ import annotations

import ctypes as C
import logging
import os
import threading
import time
import weakref
from typing import Any

from kairos_common.monitoring.metrics import MetricsRegistry, TopicWindow, WindowMetrics

from topic_monitor.ros_subscriber import RosTopicSubscriber, _SubscriptionState

logger = logging.getLogger("kairos.topic_monitor")


class Snapshot(C.Structure):
    _fields_ = [
        (n, C.c_uint64) for n in ("count", "bytes", "total", "lost", "late")
    ] + [(n, C.c_double) for n in ("last", "gap_max_ms", "p50_ms", "p95_ms")]


class NativeEngine:
    def __init__(self, horizon: float) -> None:
        self._lock = threading.RLock()
        self.handle = None
        self.lib = C.CDLL(
            os.environ.get(
                "KAIROS_MONITOR_NATIVE_LIBRARY", "libkairos_monitor_native.so"
            )
        )
        # Validate before any allocation or pointer-bearing ABI call.
        try:
            self.lib.km_abi_version.argtypes = []
            self.lib.km_abi_version.restype = C.c_uint32
            self.lib.km_snapshot_size.argtypes = []
            self.lib.km_snapshot_size.restype = C.c_size_t
            version = self.lib.km_abi_version()
            size = self.lib.km_snapshot_size()
        except AttributeError as exc:
            raise RuntimeError("native monitor library has no ABI handshake") from exc
        if version != 1 or size != C.sizeof(Snapshot):
            raise RuntimeError(
                f"native monitor ABI mismatch: version={version}, size={size}; "
                f"expected version=1, size={C.sizeof(Snapshot)}"
            )
        signatures = {
            "create": ([C.c_double], C.c_void_p),
            "destroy": ([C.c_void_p], C.c_int),
            "start": ([C.c_void_p], C.c_int),
            "stop": ([C.c_void_p], C.c_int),
            "alive": ([C.c_void_p], C.c_int),
            "pause": ([C.c_void_p, C.c_int], C.c_int),
            "remove": ([C.c_void_p, C.c_char_p], C.c_int),
            "subscribe": (
                [C.c_void_p, C.c_char_p, C.c_char_p, C.c_int, C.c_int, C.c_int],
                C.c_int,
            ),
            "snapshot": (
                [
                    C.c_void_p,
                    C.c_char_p,
                    C.c_double,
                    C.c_double,
                    C.c_double,
                    C.POINTER(Snapshot),
                ],
                C.c_int,
            ),
            "metadata": ([C.c_void_p, C.c_char_p, C.POINTER(Snapshot)], C.c_int),
            "test_add": ([C.c_void_p, C.c_char_p, C.c_double, C.c_uint64], C.c_int),
            "test_lost": ([C.c_void_p, C.c_char_p, C.c_int], C.c_int),
            "error": ([], C.c_char_p),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.lib, "km_" + name)
            function.argtypes, function.restype = args, result
        self.handle = self.lib.km_create(horizon)
        if not self.handle:
            raise RuntimeError(self.lib.km_error().decode())
        self._finalizer = weakref.finalize(self, self._dispose, self.lib, self.handle)

    @staticmethod
    def _dispose(lib: Any, handle: Any) -> None:
        if lib.km_destroy(handle) == -1:
            logger.error("native cleanup failed: %s", lib.km_error().decode())

    def call(self, name: str, *args: Any) -> Any:
        with self._lock:
            if not self.handle:
                raise RuntimeError("native monitor is stopped")
            result = getattr(self.lib, "km_" + name)(self.handle, *args)
            if result == -1:
                raise RuntimeError(self.lib.km_error().decode())
            return result

    def snapshot(
        self, name: str, window: float, now: float, threshold: float = -1
    ) -> Snapshot:
        result = Snapshot()
        self.call("snapshot", name.encode(), window, now, threshold, C.byref(result))
        return result

    def close(self) -> None:
        with self._lock:
            if self.handle:
                self.call("destroy")
                self.handle = None
                self._finalizer.detach()

    def metadata(self, name: str) -> Snapshot:
        result = Snapshot()
        self.call("metadata", name.encode(), C.byref(result))
        return result


class NativeWindow(TopicWindow):
    def __init__(self, original: TopicWindow, engine: NativeEngine, name: str) -> None:
        # Reuse the baseline's health/late configuration and policy functions.
        self.__dict__.update(original.__dict__)
        self.engine, self.name = engine, name
        self.latest = Snapshot(last=-1)

    @property
    def messages_total(self) -> int:
        return self.latest.total

    def last_recv_t(self) -> float | None:
        return self.latest.last if self.latest.last >= 0 else None

    def add(self, sample: Any) -> None:
        raise RuntimeError("native windows receive only from the C++ executor")

    def compute(self, window_s: float, now: float) -> WindowMetrics:
        threshold = self._late_tolerance / self.expected_hz if self.expected_hz else -1
        s = self.engine.snapshot(self.name, window_s, now, threshold)
        self.latest = s
        hz = s.count / window_s
        shortfall, deficit, status, reason = self._health(s.count, hz, window_s)
        late_reason = (
            "no expected_hz"
            if self.expected_hz is None
            else "no samples"
            if s.count == 0
            else "insufficient samples"
            if s.count == 1
            else None
        )
        return WindowMetrics(
            window_s=window_s,
            count=s.count,
            hz=hz,
            bandwidth_bps=s.bytes / window_s,
            gap_max_ms=s.gap_max_ms if s.count > 1 else None,
            gap_exceed_count=s.late,
            inter_arrival_late_ratio=s.late / (s.count - 1)
            if late_reason is None
            else None,
            stamp_delay_ms=None,
            interarrival_p50_ms=s.p50_ms if s.count > 1 else None,
            interarrival_p95_ms=s.p95_ms if s.count > 1 else None,
            rate_shortfall=shortfall,
            deficit_per_s=deficit,
            status=status,
            status_reason=reason,
            late_reason=late_reason,
        )


class NativeRegistry(MetricsRegistry):
    def __init__(self, *args: Any, owner: NativeTopicSubscriber, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.owner = owner
        self._native_lock = threading.RLock()

    def ensure_topic(
        self, name: str, type_: str | None = None, qos: object | None = None
    ) -> Any:
        with self._native_lock:
            state = super().ensure_topic(name, type_, qos)
            if self.owner.engine is not None and (
                not isinstance(state.window, NativeWindow)
                or state.window.engine is not self.owner.engine
            ):
                state.window = NativeWindow(state.window, self.owner.engine, name)
            if type_ is not None:
                state.type = type_
            if qos is not None:
                state.qos = qos
            return state

    def topics(self) -> list[Any]:
        with self._native_lock:
            states = super().topics()
            if self.owner.engine is None:
                return states
            for state in states:
                self.ensure_topic(state.name)
                s = self.owner.engine.metadata(state.name)
                state.last_seen_t = s.last if s.last >= 0 else None
                state.dds_samples_lost = s.lost
            return states


class NativeTopicSubscriber(RosTopicSubscriber):
    """Keep the existing 2s graph/QoS reconciliation; move all raw callbacks to C++."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.engine: NativeEngine | None = None
        self.registry: NativeRegistry | None = None
        self._subscription_failures: dict[str, dict[str, Any]] = {}

    def registry_factory(self, *args: Any, **kwargs: Any) -> NativeRegistry:
        self.registry = NativeRegistry(*args, owner=self, **kwargs)
        return self.registry

    def start(self) -> None:
        with self._lifecycle_lock:
            # The graph thread can outlive a failed native executor.
            if self._up and self.engine is not None and not self.engine.call("alive"):
                self.stop()
            super().start()

    def _spin_up(self) -> None:
        if self.registry is None:
            raise RuntimeError("native subscriber requires native registry_factory")
        if self.engine is None:
            self.engine = NativeEngine(max(self.registry.windows_s))
        self.engine.call("pause", int(self._paused))
        self.engine.call("start")
        super()._spin_up()

    def _abandon_partial(self) -> None:
        try:
            super()._abandon_partial()
        finally:
            if self.engine is not None:
                self.engine.call("stop")

    def _subscribe(
        self, node: Any, topic: str, type_str: str | None, qos: Any, fingerprint: Any
    ) -> None:
        if type_str is None or self.engine is None or self.registry is None:
            return
        try:
            self.engine.call(
                "subscribe",
                topic.encode(),
                type_str.encode(),
                int(qos.reliability == "reliable"),
                int(qos.durability == "transient_local"),
                qos.depth,
            )
        except RuntimeError as exc:
            with self._lock:
                self._subscription_failures[topic] = {
                    "topic": topic,
                    "type": type_str,
                    "error": str(exc),
                    "last_attempt_t": time.monotonic(),
                }
            logger.exception("native subscription failed", extra={"topic": topic})
            return
        self.registry.ensure_topic(topic, type_str, qos)
        with self._lock:
            self._subscription_failures.pop(topic, None)
            self._subscribed[topic] = _SubscriptionState(
                topic, type_str, qos, fingerprint, time.monotonic()
            )

    def _teardown_subscription(self, node: Any, topic: str) -> None:
        if self.engine is not None:
            self.engine.call("remove", topic.encode())
        with self._lock:
            self._subscribed.pop(topic, None)

    def pause(self) -> None:
        super().pause()
        if self.engine is not None:
            self.engine.call("pause", 1)

    def resume(self) -> None:
        super().resume()
        if self.engine is not None:
            self.engine.call("pause", 0)

    def is_up(self) -> bool:
        return bool(
            super().is_up() and self.engine is not None and self.engine.call("alive")
        )

    def diagnostics(self) -> dict[str, Any]:
        result = super().diagnostics()
        ready = self.is_up()
        result.update(
            backend="native",
            state="ready" if ready else "not_ready",
            native_executor_alive=ready,
            callback_lag_available=False,
        )
        now = time.monotonic()
        with self._lock:
            result["subscription_failures"] = [
                {
                    "topic": failure["topic"],
                    "type": failure["type"],
                    "error": failure["error"],
                    "last_attempt_age_s": max(0.0, now - failure["last_attempt_t"]),
                }
                for _, failure in sorted(self._subscription_failures.items())
            ]
        if self.engine is not None and self.registry is not None:
            for entry in result["subscriptions"]:
                s = self.engine.metadata(entry["topic"])
                entry["last_sample_age_s"] = (
                    max(0, now - s.last) if s.last >= 0 else None
                )
        return result

    def stop(self) -> None:
        with self._lifecycle_lock:
            try:
                super().stop()
            finally:
                if self.engine is not None:
                    self.engine.call("stop")
                with self._lock:
                    self._subscription_failures.clear()
