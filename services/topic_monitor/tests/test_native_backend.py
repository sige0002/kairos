# SPDX-License-Identifier: Apache-2.0
"""ABI/lifecycle failure checks without ROS or a compiled library."""

import ctypes
from unittest.mock import MagicMock, patch

import pytest
from kairos_common.monitoring.models import QosInfo
from topic_monitor.native_backend import NativeEngine, NativeTopicSubscriber, Snapshot


def library():
    lib = MagicMock()
    lib.km_abi_version.return_value = 1
    lib.km_snapshot_size.return_value = ctypes.sizeof(Snapshot)
    lib.km_create.return_value = 123
    lib.km_destroy.return_value = 0
    lib.km_error.return_value = b"injected failure"
    return lib


@pytest.mark.parametrize("version,size", [(2, 72), (1, 1)])
def test_abi_rejected_before_allocation(version, size):
    lib = library()
    lib.km_abi_version.return_value = version
    lib.km_snapshot_size.return_value = size
    with patch("topic_monitor.native_backend.C.CDLL", return_value=lib):
        with pytest.raises(RuntimeError, match="ABI mismatch"):
            NativeEngine(5)
    lib.km_create.assert_not_called()


def test_unversioned_library_rejected():
    with patch("topic_monitor.native_backend.C.CDLL", return_value=object()):
        with pytest.raises(RuntimeError, match="no ABI handshake"):
            NativeEngine(5)


def test_allocation_failure_and_close_retry():
    lib = library()
    with patch("topic_monitor.native_backend.C.CDLL", return_value=lib):
        lib.km_create.return_value = None
        with pytest.raises(RuntimeError, match="injected failure"):
            NativeEngine(5)
        lib.km_create.return_value = 123
        engine = NativeEngine(5)
        lib.km_destroy.return_value = -1
        with pytest.raises(RuntimeError, match="injected failure"):
            engine.close()
        assert engine.handle == 123
        lib.km_destroy.return_value = 0
        engine.close()
        engine.close()
        assert lib.km_destroy.call_count == 2
        with pytest.raises(RuntimeError, match="stopped"):
            engine.call("start")


def test_partial_graph_startup_stops_native_engine():
    sub = NativeTopicSubscriber([])
    sub.registry_factory([1, 5])
    engine = MagicMock()
    with (
        patch("topic_monitor.native_backend.NativeEngine", return_value=engine),
        patch(
            "topic_monitor.ros_subscriber.RosTopicSubscriber._spin_up",
            side_effect=RuntimeError("graph failed"),
        ),
    ):
        with pytest.raises(RuntimeError, match="graph failed"):
            sub.start()
    engine.call.assert_any_call("stop")
    assert not sub.is_up()
    assert sub.engine is engine


def test_native_stop_attempted_even_when_graph_teardown_fails():
    sub = NativeTopicSubscriber([])
    sub.engine = MagicMock()
    with patch(
        "topic_monitor.ros_subscriber.RosTopicSubscriber.stop",
        side_effect=RuntimeError("teardown failed"),
    ):
        with pytest.raises(RuntimeError, match="teardown failed"):
            sub.stop()
    sub.engine.call.assert_called_once_with("stop")


def test_subscription_failure_is_visible_until_success():
    sub = NativeTopicSubscriber(["/missing"])
    sub.registry = MagicMock()
    sub.engine = MagicMock()
    sub.engine.metadata.return_value = Snapshot(last=-1)
    qos = QosInfo(reliability="reliable", durability="volatile", depth=10)
    sub.engine.call.side_effect = RuntimeError("typesupport library not found")
    sub._subscribe(None, "/missing", "custom_msgs/msg/Test", qos, ())
    diagnostic = sub.diagnostics()
    assert diagnostic["backend"] == "native"
    assert diagnostic["subscription_count"] == 0
    assert diagnostic["subscription_failures"][0]["topic"] == "/missing"
    assert "typesupport" in diagnostic["subscription_failures"][0]["error"]
    sub.engine.call.side_effect = None
    sub._subscribe(None, "/missing", "custom_msgs/msg/Test", qos, ())
    assert sub.diagnostics()["subscription_failures"] == []


def test_start_recovers_when_only_native_executor_failed():
    sub = NativeTopicSubscriber([])
    sub._up = True
    sub.engine = MagicMock()
    sub.engine.call.return_value = 0
    with (
        patch.object(sub, "stop") as stop,
        patch("topic_monitor.ros_subscriber.RosTopicSubscriber.start") as start,
    ):
        sub.start()
    stop.assert_called_once()
    start.assert_called_once()
