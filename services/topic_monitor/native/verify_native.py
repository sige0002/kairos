# SPDX-License-Identifier: Apache-2.0
"""Explicit ROS-only checks; excluded from the host's pytest discovery."""

import dataclasses
import math
import random
import time
import unittest

import rclpy
from kairos_common import RecordingConfig
from kairos_common.monitoring.metrics import TopicWindow
from kairos_common.monitoring.monitor import MonitorService
from kairos_common.monitoring.subscriber import Sample
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from std_msgs.msg import String
from topic_monitor.native_backend import (
    NativeEngine,
    NativeTopicSubscriber,
    NativeWindow,
)


class NativeTests(unittest.TestCase):
    def test_native_lifecycle_errors_and_counter_retention(self):
        with self.assertRaisesRegex(RuntimeError, "invalid horizon"):
            NativeEngine(float("nan"))
        engine = NativeEngine(5)
        try:
            self.assertEqual(engine.call("alive"), 0)
            with self.assertRaisesRegex(RuntimeError, "stopped"):
                engine.call("subscribe", b"/test", b"std_msgs/msg/String", 1, 0, 10)
            engine.call("test_add", b"/counter", 100.0, 16)
            engine.call("test_lost", b"/counter", 3)
            engine.call("start")
            with self.assertRaisesRegex(RuntimeError, "already started"):
                engine.call("start")
            with self.assertRaises(RuntimeError):
                engine.call(
                    "subscribe", b"invalid topic", b"std_msgs/msg/String", 1, 0, 10
                )
            with self.assertRaisesRegex(RuntimeError, "invalid snapshot"):
                engine.snapshot("/counter", 6, 100)
            engine.call("stop")
            engine.call("stop")
            self.assertEqual(engine.call("alive"), 0)
            engine.call("start")
            engine.call("test_add", b"/counter", 100.1, 20)
            snapshot = engine.snapshot("/counter", 5, 100.1)
            self.assertEqual((snapshot.total, snapshot.lost, snapshot.count), (2, 3, 2))
            # Null handles are rejected inside the C ABI, not dereferenced.
            self.assertEqual(engine.lib.km_stop(None), -1)
        finally:
            engine.close()
            engine.close()

    def test_window_parity(self):
        engine = NativeEngine(5)
        try:
            for expected in (None, 10.0, 200.0):
                name = f"/test_{expected}"
                original = TopicWindow([1, 5], expected_hz=expected)
                native = NativeWindow(original, engine, name)
                rng = random.Random(17)
                t = 100.0
                for i in range(600):
                    t += rng.choice([0.001, 0.02, 0.1, 0.3])
                    size = rng.randint(0, 100000)
                    original.add(
                        Sample(
                            topic=name,
                            type="std_msgs/msg/String",
                            recv_t=t,
                            size_bytes=size,
                        )
                    )
                    engine.call("test_add", name.encode(), t, size)
                    if i % 17 == 0:
                        for window in (1, 5):
                            left = dataclasses.asdict(original.compute(window, t))
                            right = dataclasses.asdict(native.compute(window, t))
                            for key, value in left.items():
                                if isinstance(value, float):
                                    self.assertTrue(
                                        math.isclose(
                                            value,
                                            right[key],
                                            rel_tol=1e-12,
                                            abs_tol=1e-9,
                                        ),
                                        (key, value, right[key]),
                                    )
                                else:
                                    self.assertEqual(value, right[key], key)
                self.assertEqual(
                    dataclasses.asdict(original.compute(5, t + 6)),
                    dataclasses.asdict(native.compute(5, t + 6)),
                )
                self.assertEqual(native.messages_total, 600)
            engine.call("test_lost", b"/lost", 4)
            engine.call("test_lost", b"/lost", -2)
            self.assertEqual(engine.snapshot("/lost", 5, 0).lost, 4)
            engine.call("pause", 1)
            engine.call("test_add", b"/paused", 0, 12)
            self.assertEqual(engine.snapshot("/paused", 5, 0).total, 0)
        finally:
            engine.close()

    def test_ros_receive_graph_qos_pause_and_restart(self):
        config = RecordingConfig(
            robot_name="myrobot", default_topics=["/native_test/*"]
        )
        sub = NativeTopicSubscriber(config.default_topics, config=config)
        service = MonitorService(
            sub, config=config, registry_factory=sub.registry_factory
        )
        rclpy.init() if not rclpy.ok() else None
        node = Node("native_test_publisher")
        publishers = []

        def wait_for(predicate, reason, timeout=10):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                rclpy.spin_once(node, timeout_sec=0.02)
                if predicate():
                    return
            self.fail(reason + ": " + str(sub.diagnostics()))

        def row(name):
            return next(
                (t for t in service.metrics_snapshot().topics if t.name == name), None
            )

        try:
            service.start()
            for i in range(3):
                publishers.append(
                    node.create_publisher(String, f"/native_test/topic{i}", 30)
                )
            wait_for(
                lambda: all(p.get_subscription_count() == 1 for p in publishers),
                "all-topic discovery",
            )
            for _ in range(20):
                for p in publishers:
                    p.publish(String(data="a" * 10000))
                rclpy.spin_once(node, timeout_sec=0.01)
            wait_for(
                lambda: all(
                    row(f"/native_test/topic{i}")
                    and row(f"/native_test/topic{i}").messages_total == 20
                    for i in range(3)
                ),
                "exact native receive counts",
            )
            metrics = row("/native_test/topic0")
            self.assertGreater(metrics.hz, 0)
            self.assertGreater(metrics.gap_max_ms, 0)
            self.assertGreater(metrics.bandwidth_bps, 40000)
            self.assertIsNone(metrics.loss_rate)
            self.assertIsNone(service.metrics_snapshot().self_load.callback_lag_ms)
            self.assertTrue(service.is_ready())
            service.pause()
            for _ in range(10):
                publishers[0].publish(String(data="paused"))
                rclpy.spin_once(node, timeout_sec=0.02)
            service.resume()
            self.assertEqual(row("/native_test/topic0").messages_total, 20)
            node.destroy_publisher(publishers.pop(0))
            qos = QoSProfile(
                depth=40,
                reliability=ReliabilityPolicy.BEST_EFFORT,
                durability=DurabilityPolicy.TRANSIENT_LOCAL,
            )
            changed = node.create_publisher(String, "/native_test/topic0", qos)
            publishers.append(changed)
            wait_for(
                lambda: any(
                    s["topic"] == "/native_test/topic0"
                    and s["qos"]["reliability"] == "best_effort"
                    for s in sub.diagnostics()["subscriptions"]
                ),
                "QoS refresh",
            )
            wait_for(
                lambda: changed.get_subscription_count() == 1, "changed publisher match"
            )
            changed.publish(String(data="after qos change"))
            wait_for(
                lambda: row("/native_test/topic0").messages_total == 21,
                "QoS recreation retains counter",
            )
            graph = service.topics()
            q = next(t.qos for t in graph.topics if t.name == "/native_test/topic0")
            self.assertEqual(q.reliability, "best_effort")
            service.stop()
            self.assertFalse(service.is_ready())
            before_restart = {
                f"/native_test/topic{i}": sub.engine.metadata(
                    f"/native_test/topic{i}"
                ).total
                for i in range(3)
            }
            wait_for(
                lambda: all(p.get_subscription_count() == 0 for p in publishers),
                "old subscriptions disappear",
            )
            service.start()
            wait_for(
                lambda: all(p.get_subscription_count() == 1 for p in publishers),
                "restart discovery",
            )
            publishers[0].publish(String(data="reliable after restart"))
            wait_for(
                lambda: (
                    row("/native_test/topic1").messages_total
                    > before_restart["/native_test/topic1"]
                ),
                "reliable restart receives",
            )

            def probe_restarted_best_effort():
                changed.publish(String(data="after restart"))
                return (
                    row("/native_test/topic0").messages_total
                    > before_restart["/native_test/topic0"]
                )

            wait_for(probe_restarted_best_effort, "best-effort restart receives")
        finally:
            service.stop()
            node.destroy_node()
            rclpy.shutdown()


if __name__ == "__main__":
    unittest.main(verbosity=2)
