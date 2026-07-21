"""Dict-based dotted-path extraction and numeric-leaf introspection."""

from dora_live.fieldpath import extract_value, iter_numeric_paths

MSG = {
    "header": {"stamp": {"sec": 5, "nanosec": 100}, "frame_id": "base"},
    "position": [0.1, 0.2, 0.3],
    "effort": [],
    "name": ["a", "b"],
    "wrench": {"force": {"x": 1.5, "y": -2.0, "z": 0.0}},
    "is_ready": True,
}


def test_extract_nested_and_indexed():
    assert extract_value(MSG, "wrench.force.x") == 1.5
    assert extract_value(MSG, "position[2]") == 0.3
    assert extract_value(MSG, "header.stamp.sec") == 5.0
    assert extract_value(MSG, "is_ready") == 1.0


def test_extract_unresolvable_returns_none():
    assert extract_value(MSG, "wrench.force.q") is None
    assert extract_value(MSG, "position[9]") is None
    assert extract_value(MSG, "name[0]") is None  # string leaf is not numeric
    assert extract_value(MSG, "header..x") is None


def test_iter_numeric_paths_covers_leaves():
    paths = set(iter_numeric_paths(MSG))
    assert "wrench.force.x" in paths
    assert "position[0]" in paths
    assert "header.stamp.nanosec" in paths
    assert "is_ready" in paths
    assert not any(p.startswith("name") for p in paths)


def test_iter_numeric_paths_bounds_large_arrays():
    big = {"data": list(range(10_000))}
    paths = list(iter_numeric_paths(big))
    assert len(paths) <= 8  # _MAX_ARRAY_LEAVES guard
