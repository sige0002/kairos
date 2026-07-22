"""Pure-logic tests (no dora, no ROS)."""

import pyarrow as pa
from dora_live.bridge_logic import classify_value, dora_type_name, extract_stamp_ns


def test_classify_runtimeerror_is_unbridged():
    err = RuntimeError("could not find message type rm_ros_interfaces::Udpliftstate")
    info = classify_value(err)
    assert info.bridged is False
    assert info.size_bytes is None
    assert "Udpliftstate" in (info.error or "")


def test_classify_arrow_value():
    val = pa.array([1, 2, 3], type=pa.int32())
    info = classify_value(val)
    assert info.bridged is True
    assert info.size_bytes == val.nbytes
    assert info.error is None


def _stamped_struct(sec: int, nanosec: int) -> pa.Array:
    stamp = {"sec": sec, "nanosec": nanosec}
    header = {"stamp": stamp, "frame_id": "base"}
    return pa.array([{"header": header, "data": [0.5]}])


def test_extract_stamp_ns():
    val = _stamped_struct(7, 250)
    assert extract_stamp_ns(val) == 7_000_000_250


def test_extract_stamp_ns_zero_stamp_is_none():
    assert extract_stamp_ns(_stamped_struct(0, 0)) is None


def test_extract_stamp_ns_absent():
    assert extract_stamp_ns(pa.array([{"x": 1}])) is None
    assert extract_stamp_ns(pa.array([1.0])) is None
    assert extract_stamp_ns(RuntimeError("boom")) is None


def test_dora_type_name_strips_msg_infix():
    assert dora_type_name("sensor_msgs/msg/JointState") == "sensor_msgs/JointState"
    assert dora_type_name("sensor_msgs/JointState") == "sensor_msgs/JointState"
