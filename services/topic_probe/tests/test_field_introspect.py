"""Pure-logic tests for numeric-field introspection (no ROS).

Feeds plain Python / fake-decoded objects (``SimpleNamespace`` stands in for a
decoded rosidl message, since both expose fields as attributes) and asserts the
dotted numeric paths and extracted values.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from topic_probe.field_introspect import (
    extract_value,
    iter_numeric_fields,
    parse_path,
)


def _pose_msg() -> SimpleNamespace:
    """A nested message-like object: pose.position.{x,y,z} + orientation."""
    return SimpleNamespace(
        header=SimpleNamespace(stamp=SimpleNamespace(sec=12, nanosec=500), frame="map"),
        pose=SimpleNamespace(
            position=SimpleNamespace(x=1.5, y=-2.0, z=0.0),
            orientation=SimpleNamespace(x=0.0, y=0.0, z=0.0, w=1.0),
        ),
        active=True,  # bool: excluded from numeric leaves
        name="robot",  # str: skipped
    )


def test_walks_nested_numeric_leaves_as_dotted_paths() -> None:
    fields = iter_numeric_fields(_pose_msg())
    assert "pose.position.x" in fields
    assert "pose.position.y" in fields
    assert "pose.orientation.w" in fields
    assert "header.stamp.sec" in fields
    assert "header.stamp.nanosec" in fields


def test_excludes_bool_and_string_leaves() -> None:
    fields = iter_numeric_fields(_pose_msg())
    assert "active" not in fields  # bool is not a plot signal
    assert "name" not in fields  # str
    assert "header.frame" not in fields


def test_indexes_small_numeric_arrays() -> None:
    msg = SimpleNamespace(data=[10.0, 20.0, 30.0])
    fields = iter_numeric_fields(msg)
    assert fields == ["data[0]", "data[1]", "data[2]"]


def test_indexes_arrays_of_submessages() -> None:
    msg = SimpleNamespace(
        points=[SimpleNamespace(x=1.0, y=2.0), SimpleNamespace(x=3.0, y=4.0)]
    )
    fields = iter_numeric_fields(msg)
    assert fields == ["points[0].x", "points[0].y", "points[1].x", "points[1].y"]


def test_dict_messages_and_top_level_scalars() -> None:
    fields = iter_numeric_fields({"a": 1, "b": {"c": 2.0}})
    assert fields == ["a", "b.c"]


def test_caps_array_length() -> None:
    msg = SimpleNamespace(data=list(range(1000)))
    fields = iter_numeric_fields(msg, max_array=4)
    assert fields == ["data[0]", "data[1]", "data[2]", "data[3]"]


def test_caps_total_fields() -> None:
    msg = SimpleNamespace(data=list(range(1000)))
    fields = iter_numeric_fields(msg, max_array=1000, max_fields=10)
    assert len(fields) == 10


def test_respects_max_depth() -> None:
    # a.b.c.value at depth 4; with max_depth=2 the leaf is unreachable.
    msg = {"a": {"b": {"c": {"value": 1.0}}}}
    assert iter_numeric_fields(msg) == ["a.b.c.value"]
    assert iter_numeric_fields(msg, max_depth=2) == []


def test_rosidl_style_field_order() -> None:
    """rosidl messages expose get_fields_and_field_types(); honour that order."""

    class FakeMsg:
        def __init__(self) -> None:
            self.z = 3.0
            self.a = 1.0
            self.m = 2.0

        def get_fields_and_field_types(self) -> dict[str, str]:
            return {"z": "float64", "a": "float64", "m": "float64"}

    assert iter_numeric_fields(FakeMsg()) == ["z", "a", "m"]


# ---- parse_path -------------------------------------------------------------
def test_parse_path_dotted_and_indexed() -> None:
    assert parse_path("pose.position.x") == ["pose", "position", "x"]
    assert parse_path("data[2]") == ["data", 2]
    assert parse_path("a[0].b[1]") == ["a", 0, "b", 1]


@pytest.mark.parametrize("bad", ["", "a..b", "data[x]", "data[1", "a[]"])
def test_parse_path_rejects_malformed(bad: str) -> None:
    with pytest.raises(ValueError):
        parse_path(bad)


# ---- extract_value ----------------------------------------------------------
def test_extract_nested_and_indexed_values() -> None:
    msg = _pose_msg()
    assert extract_value(msg, "pose.position.x") == 1.5
    assert extract_value(msg, "pose.orientation.w") == 1.0

    arr = SimpleNamespace(data=[10, 20, 30])
    assert extract_value(arr, "data[1]") == 20.0


def test_extract_returns_none_for_missing_or_nonnumeric() -> None:
    msg = _pose_msg()
    assert extract_value(msg, "pose.position.missing") is None  # missing attr
    assert extract_value(msg, "name") is None  # str leaf
    assert extract_value(msg, "active") is None  # bool leaf
    assert extract_value(SimpleNamespace(data=[1, 2]), "data[9]") is None  # OOB
    assert extract_value(SimpleNamespace(x=1.0), "x[0]") is None  # index a scalar


def test_extract_value_is_float() -> None:
    assert extract_value({"a": 7}, "a") == 7.0
    assert isinstance(extract_value({"a": 7}, "a"), float)
