# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""signal_report pipeline tests.

The scoring/downsampling helpers (``compute_continuity`` / ``downsample_stride``)
are pure and fully unit-testable. The extraction path is exercised against small
synthetic MCAPs written with ``mcap_ros2.writer`` (real, decodable ROS2 messages
— unlike loss_report's payload-free bags, signal_report must decode numeric
leaves), so the whole one-pass extract/continuity/downsample flow is covered
without a live ROS graph or a large sample recording.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace

import pytest
from dora_runner.main import create_dora_app
from dora_runner.registry import (
    _max_points_param,
    _topics_param,
    build_default_registry,
)
from dora_runner.signal_report import (
    BIN_COUNT,
    CONTINUITY_DEFINITION,
    DEFAULT_MAX_POINTS,
    LOSS_EVENTS_CAP,
    MAX_TOPIC_FIELDS,
    _first_message_fields,
    compute_bins,
    compute_continuity,
    detect_loss_events,
    downsample_stride,
    run_signal_report,
)
from fastapi.testclient import TestClient
from kairos_common import ApiError, Settings
from kairos_common.ids import new_capture_id
from mcap_ros2.writer import Writer

_MS = 1_000_000  # nanoseconds per millisecond

# ---- Minimal ROS2 message definitions (concatenated msgdef, ros2msg) ---------

_HEADER = """\
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
"""
_JOINT_DEF = (
    "std_msgs/Header header\nstring[] name\nfloat64[] position\n"
    "float64[] velocity\n" + _HEADER
)
_IMAGE_DEF = "std_msgs/Header header\nstring format\nuint8[] data\n" + _HEADER
_STRING_DEF = "string data\n"


def _stamp(i: int) -> dict:
    return {"stamp": {"sec": i, "nanosec": 0}, "frame_id": "f"}


# ---- compute_continuity (pure) ----------------------------------------------


def test_continuity_regular_stream_is_one() -> None:
    times = [i * 100 * _MS for i in range(10)]
    assert compute_continuity(times) == 1.0


def test_continuity_empty_and_single_are_none() -> None:
    assert compute_continuity([]) is None
    assert compute_continuity([42]) is None


def test_continuity_zero_duration_is_none() -> None:
    # Every timestamp identical: no cadence is defined -> None (not a 0/0 crash).
    assert compute_continuity([5, 5, 5]) is None


def test_continuity_single_gap_exact() -> None:
    # intervals [100, 100, 600] ms; median 100 -> threshold 150; the 600 gap
    # contributes 600-150=450 excess over a 800 ms span -> 1 - 450/800 = 0.4375.
    times = [0, 100 * _MS, 200 * _MS, 800 * _MS]
    assert compute_continuity(times) == pytest.approx(0.4375)


def test_continuity_zero_median_is_defined_not_none() -> None:
    # A burst of identical stamps then one gap: median interval 0 -> every
    # positive gap counts, so continuity collapses to 0 (still a defined score).
    times = [0, 0, 0, 100 * _MS]
    assert compute_continuity(times) == 0.0


# ---- downsample_stride (pure) -----------------------------------------------


def test_downsample_stride_no_downsample_when_within_cap() -> None:
    assert downsample_stride(100, 2000) == 1
    assert downsample_stride(2000, 2000) == 1


def test_downsample_stride_beyond_cap() -> None:
    assert downsample_stride(2001, 2000) == 2
    assert downsample_stride(10001, 2000) == 6


@pytest.mark.parametrize("n", [0, 1, 1999, 2000, 2001, 4000, 5000, 123457])
def test_downsample_points_never_exceed_cap(n: int) -> None:
    max_points = 2000
    stride = downsample_stride(n, max_points)
    points = len(range(0, n, stride))
    assert points <= max_points


# ---- detect_loss_events (pure) ----------------------------------------------


def test_detect_loss_events_needs_four_intervals() -> None:
    # 4 timestamps -> 3 intervals (< LOSS_MIN_INTERVALS) -> no cadence to judge.
    times = [0, 100 * _MS, 200 * _MS, 700 * _MS]
    assert detect_loss_events(times, 0) == ([], 0)


def test_detect_loss_events_zero_median_is_empty() -> None:
    # A burst of identical stamps then one gap: median interval 0 -> no rate.
    times = [0, 0, 0, 0, 0, 500 * _MS]
    assert detect_loss_events(times, 0) == ([], 0)


def test_detect_loss_events_single_major_gap() -> None:
    # intervals [100,100,100,100,500] ms; median 100 -> threshold 150; the 500
    # gap is one event at the previous message's time. round(500/100)-1 = 4 -> major.
    times = [t * _MS for t in (0, 100, 200, 300, 400, 900)]
    events, dropped = detect_loss_events(times, 0)
    assert dropped == 0
    assert events == [
        {
            "start_ns": 400 * _MS,
            "duration_ns": 500 * _MS,
            "estimated_lost": 4,
            "severity": "major",
        }
    ]


def test_detect_loss_events_minor_severity() -> None:
    # A 300 ms gap on a 100 ms cadence: round(3)-1 = 2 lost (< 3) -> minor.
    times = [t * _MS for t in (0, 100, 200, 300, 400, 700)]
    events, _ = detect_loss_events(times, 0)
    assert [e["severity"] for e in events] == ["minor"]
    assert events[0]["estimated_lost"] == 2


def test_detect_loss_events_start_ns_is_global_relative() -> None:
    # Same cadence shifted by an epoch-like global zero: start_ns stays small
    # (previous-message time MINUS global zero), never the absolute stamp.
    gz = 1_750_000_000_000_000_000
    times = [gz + t * _MS for t in (0, 100, 200, 300, 400, 900)]
    events, _ = detect_loss_events(times, gz)
    assert events[0]["start_ns"] == 400 * _MS
    assert events[0]["start_ns"] < 9_007_199_254_740_991  # under MAX_SAFE_INTEGER


def test_detect_loss_events_caps_and_reports_dropped() -> None:
    # 300 tight (100 ms) + 250 wide (1000 ms) intervals: median stays 100 ms, so
    # every wide interval is an event (250) -> capped at LOSS_EVENTS_CAP, 50 dropped.
    intervals_ms = [100] * 300 + [1000] * 250
    ms = [0]
    for iv in intervals_ms:
        ms.append(ms[-1] + iv)
    times = [m * _MS for m in ms]
    events, dropped = detect_loss_events(times, 0)
    assert len(events) == LOSS_EVENTS_CAP
    assert dropped == 250 - LOSS_EVENTS_CAP
    # Largest-duration first, and every kept event is one of the wide (major) gaps.
    assert all(e["duration_ns"] == 1000 * _MS for e in events)
    assert all(e["severity"] == "major" for e in events)


# ---- compute_bins (pure) ----------------------------------------------------


def test_compute_bins_under_two_messages_is_none() -> None:
    assert compute_bins([5 * _MS], 0, 10 * _MS) is None


def test_compute_bins_zero_span_is_none() -> None:
    assert compute_bins([0, 0], 0, 0) is None


def test_compute_bins_density_sums_to_message_count() -> None:
    times = [i * _MS for i in range(100)]
    bins = compute_bins(times, 0, 99 * _MS)
    assert bins is not None
    assert bins["count"] == BIN_COUNT
    assert len(bins["densities"]) == BIN_COUNT
    assert sum(bins["densities"]) == len(times)


def test_compute_bins_bin_ns_is_ceil_of_span() -> None:
    # span 600 ms across 600 bins -> exactly 1 ms per bin.
    bins = compute_bins([0, 600 * _MS], 0, 600 * _MS)
    assert bins is not None
    assert bins["bin_ns"] == _MS
    # A timestamp exactly at the global end clamps into the last bin (not #600).
    assert sum(bins["densities"]) == 2
    assert bins["densities"][-1] == 1


# ---- _first_message_fields: field cap + truncated count (pure) --------------


def test_first_message_fields_caps_and_counts_overflow() -> None:
    # 16 rows (array cap) x 20 numeric fields = 320 leaves > MAX_TOPIC_FIELDS.
    row = {f"f{j}": float(j) for j in range(20)}
    msg = SimpleNamespace(rows=[SimpleNamespace(**row) for _ in range(20)])
    paths, truncated = _first_message_fields(msg)
    assert len(paths) == MAX_TOPIC_FIELDS
    assert truncated == 320 - MAX_TOPIC_FIELDS


def test_first_message_fields_no_overflow() -> None:
    paths, truncated = _first_message_fields(SimpleNamespace(a=1.0, b=2.0))
    assert paths == ["a", "b"]
    assert truncated == 0


# ---- MCAP writer helpers -----------------------------------------------------


def _write_joint_mcap(
    path: Path,
    positions: list[list[float]],
    *,
    topic: str = "/hsrb/joint_states",
    log_step_ms: int = 100,
    pub_offset_ms: int | None = 5,
    base_ns: int = 0,
) -> None:
    """Write a JointState topic. ``pub_offset_ms=None`` -> publish_time==log_time.

    ``base_ns`` shifts every timestamp (use an epoch-like value to reproduce the
    absolute-nanosecond magnitudes real bags carry).
    """
    with path.open("wb") as fh:
        w = Writer(fh)
        schema = w.register_msgdef("sensor_msgs/msg/JointState", _JOINT_DEF)
        for i, pos in enumerate(positions):
            log = base_ns + i * log_step_ms * _MS
            pub = log if pub_offset_ms is None else log + pub_offset_ms * _MS
            w.write_message(
                topic=topic,
                schema=schema,
                message={
                    "header": _stamp(i),
                    "name": ["j"] * len(pos),
                    "position": list(pos),
                    "velocity": [0.5] * len(pos),
                },
                log_time=log,
                publish_time=pub,
            )
        w.finish()


def _write_mixed_mcap(path: Path) -> None:
    """A JointState (numeric), a CompressedImage, and a String topic."""
    with path.open("wb") as fh:
        w = Writer(fh)
        js = w.register_msgdef("sensor_msgs/msg/JointState", _JOINT_DEF)
        img = w.register_msgdef("sensor_msgs/msg/CompressedImage", _IMAGE_DEF)
        strs = w.register_msgdef("std_msgs/msg/String", _STRING_DEF)
        for i in range(6):
            ts = i * 100 * _MS
            w.write_message(
                topic="/hsrb/joint_states",
                schema=js,
                message={
                    "header": _stamp(i),
                    "name": ["j1"],
                    "position": [float(i)],
                    "velocity": [0.0],
                },
                log_time=ts,
                publish_time=ts,
            )
            w.write_message(
                topic="/cam/image/compressed",
                schema=img,
                message={"header": _stamp(i), "format": "jpeg", "data": [1, 2, 3]},
                log_time=ts,
                publish_time=ts,
            )
            w.write_message(
                topic="/notes",
                schema=strs,
                message={"data": "hello"},
                log_time=ts,
                publish_time=ts,
            )
        w.finish()


# ---- run_signal_report: extraction + sidecar shape --------------------------


def test_signal_report_extracts_numeric_series(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_joint_mcap(
        capture_dir / "run_x_0.mcap", [[1.0 + i, 2.0 + i] for i in range(20)]
    )

    out = run_signal_report(capture_id=capture_id, data_dir=data_dir, max_points=5)
    summary = out["summary"]
    assert summary["pipeline"] == "signal_report"
    assert summary["params"] == {"topics": None, "max_points": 5}
    assert set(summary["topics"]) == {"/hsrb/joint_states"}

    topic = summary["topics"]["/hsrb/joint_states"]
    assert topic["msg_type"] == "sensor_msgs/msg/JointState"
    assert topic["message_count"] == 20
    assert topic["time_source"] == "publish_time"  # distinct, monotonic pub times
    assert topic["continuity_definition"] == CONTINUITY_DEFINITION
    assert topic["continuity"] == pytest.approx(1.0)
    assert topic["truncated_fields"] == 0
    # Downsample: 20 messages, cap 5 -> stride 4, 5 points; every field aligns.
    assert topic["downsample"] == {"stride": 4, "points": 5}
    assert len(topic["t_ns"]) == 5
    assert set(topic["fields"]) == {
        "header.stamp.sec",
        "header.stamp.nanosec",
        "position[0]",
        "position[1]",
        "velocity[0]",
        "velocity[1]",
    }
    for values in topic["fields"].values():
        assert len(values) == len(topic["t_ns"])
    assert topic["fields"]["position[0]"] == [1.0, 5.0, 9.0, 13.0, 17.0]
    # Written to the report tree and re-parseable.
    assert Path(out["artifacts"][0]) == (
        data_dir / "report" / "signal_report" / capture_id / "summary.json"
    )
    assert Path(out["artifacts"][0]).exists()


def test_signal_report_t_ns_is_relative_to_start(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    # Epoch-like base (> JS Number.MAX_SAFE_INTEGER = 9.007e15): if t_ns were
    # absolute, a JSON consumer would quantize it. pub==log -> log_time series.
    base = 1_750_000_000_000_000_000
    _write_joint_mcap(
        capture_dir / "run_e_0.mcap",
        [[float(i)] for i in range(5)],
        pub_offset_ms=None,
        base_ns=base,
    )
    summary = run_signal_report(capture_id=capture_id, data_dir=data_dir)["summary"]
    topic = summary["topics"]["/hsrb/joint_states"]
    # start_ns / end_ns keep the absolute chosen-clock values (metadata)...
    assert topic["start_ns"] == base
    assert topic["end_ns"] == base + 4 * 100 * _MS
    # ...while t_ns is offset from start_ns: first element 0, values small/safe.
    assert topic["t_ns"][0] == 0
    assert topic["t_ns"] == [i * 100 * _MS for i in range(5)]
    assert max(topic["t_ns"]) < 9_007_199_254_740_991  # under MAX_SAFE_INTEGER


def test_signal_report_falls_back_to_log_time(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    # publish_time == log_time on every message -> log_time series, said out loud.
    _write_joint_mcap(
        capture_dir / "run_l_0.mcap", [[float(i)] for i in range(5)], pub_offset_ms=None
    )
    summary = run_signal_report(capture_id=capture_id, data_dir=data_dir)["summary"]
    topic = summary["topics"]["/hsrb/joint_states"]
    assert topic["time_source"] == "log_time"


def test_signal_report_missing_leaf_is_null(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    # First message has 3 array elements (defines position[0..2]); a later
    # message has only 1 -> position[1]/position[2] extract to null there.
    _write_joint_mcap(
        capture_dir / "run_j_0.mcap",
        [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0]],
    )
    summary = run_signal_report(capture_id=capture_id, data_dir=data_dir)["summary"]
    topic = summary["topics"]["/hsrb/joint_states"]
    assert "position[2]" in topic["fields"]
    assert topic["fields"]["position[2]"] == [3.0, 6.0, None]
    assert topic["fields"]["position[0]"] == [1.0, 4.0, 7.0]


def test_signal_report_gap_lowers_continuity(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    # 10 messages at 100 ms, then one that arrives 500 ms late -> continuity < 1.
    times = list(range(10)) + [14]  # index 10 lands at 1400 ms (400 ms hole)
    with (capture_dir / "run_g_0.mcap").open("wb") as fh:
        w = Writer(fh)
        schema = w.register_msgdef("sensor_msgs/msg/JointState", _JOINT_DEF)
        for i, slot in enumerate(times):
            ts = slot * 100 * _MS
            w.write_message(
                topic="/hsrb/joint_states",
                schema=schema,
                message={
                    "header": _stamp(i),
                    "name": ["j"],
                    "position": [float(i)],
                    "velocity": [0.0],
                },
                log_time=ts,
                publish_time=ts,
            )
        w.finish()
    summary = run_signal_report(capture_id=capture_id, data_dir=data_dir)["summary"]
    topic = summary["topics"]["/hsrb/joint_states"]
    assert topic["continuity"] is not None
    assert 0.0 < topic["continuity"] < 1.0


def test_signal_report_injected_gap_becomes_loss_event(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    # 5 messages at 100 ms, then one 500 ms after the last (400 ms hole). pub==log
    # so the axis is log_time and the global zero is 0 -> loss start is 400 ms.
    with (capture_dir / "run_gap_0.mcap").open("wb") as fh:
        w = Writer(fh)
        schema = w.register_msgdef("sensor_msgs/msg/JointState", _JOINT_DEF)
        for i, slot in enumerate((0, 1, 2, 3, 4, 9)):
            ts = slot * 100 * _MS
            w.write_message(
                topic="/hsrb/joint_states",
                schema=schema,
                message={
                    "header": _stamp(i),
                    "name": ["j"],
                    "position": [float(i)],
                    "velocity": [0.0],
                },
                log_time=ts,
                publish_time=ts,
            )
        w.finish()

    summary = run_signal_report(capture_id=capture_id, data_dir=data_dir)["summary"]
    assert summary["version"] == "1.1.0"
    assert summary["span"] == {"duration_ns": 900 * _MS}
    topic = summary["topics"]["/hsrb/joint_states"]
    assert topic["start_offset_ns"] == 0
    assert topic["edges"] == {"start_delay_ns": 0, "end_early_ns": 0}
    assert topic["loss_events"] == [
        {
            "start_ns": 400 * _MS,
            "duration_ns": 500 * _MS,
            "estimated_lost": 4,
            "severity": "major",
        }
    ]
    assert "loss_events_truncated" not in topic
    # Bins cover the whole global span; every message is counted exactly once.
    assert topic["bins"]["count"] == BIN_COUNT
    assert sum(topic["bins"]["densities"]) == topic["message_count"] == 6


def test_signal_report_multi_topic_global_alignment(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    # Topic A spans [0, 400] ms; topic B starts later at 200 ms and ends at 500 ms.
    # Global zero = 0 (A's start), global end = 500 ms (B's end). pub==log.
    with (capture_dir / "run_two_0.mcap").open("wb") as fh:
        w = Writer(fh)
        schema = w.register_msgdef("sensor_msgs/msg/JointState", _JOINT_DEF)

        def emit(topic: str, slots_ms: list[int]) -> None:
            for i, ms in enumerate(slots_ms):
                ts = ms * _MS
                w.write_message(
                    topic=topic,
                    schema=schema,
                    message={
                        "header": _stamp(i),
                        "name": ["j"],
                        "position": [float(i)],
                        "velocity": [0.0],
                    },
                    log_time=ts,
                    publish_time=ts,
                )

        emit("/topic_a", [0, 100, 200, 300, 400])
        emit("/topic_b", [200, 300, 400, 500])
        w.finish()

    summary = run_signal_report(capture_id=capture_id, data_dir=data_dir)["summary"]
    assert summary["span"] == {"duration_ns": 500 * _MS}
    a = summary["topics"]["/topic_a"]
    b = summary["topics"]["/topic_b"]
    # A is the global-zero topic: offset 0, no start delay, ends 100 ms early.
    assert a["start_offset_ns"] == 0
    assert a["edges"] == {"start_delay_ns": 0, "end_early_ns": 100 * _MS}
    # B begins 200 ms into the episode and runs to the global end.
    assert b["start_offset_ns"] == 200 * _MS
    assert b["edges"] == {"start_delay_ns": 200 * _MS, "end_early_ns": 0}
    # t_ns stays topic-relative for BOTH (first element 0), independent of offset.
    assert a["t_ns"][0] == 0 and b["t_ns"][0] == 0


def test_signal_report_excludes_images_and_no_numeric(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_mixed_mcap(capture_dir / "run_m_0.mcap")

    summary = run_signal_report(capture_id=capture_id, data_dir=data_dir)["summary"]
    assert set(summary["topics"]) == {"/hsrb/joint_states"}
    assert summary["skipped_topics"]["/cam/image/compressed"] == (
        "image topic (use video_check)"
    )
    # A String topic has no numeric leaves -> skipped with that reason.
    assert summary["skipped_topics"]["/notes"] == "no numeric fields"


def test_signal_report_topics_allow_list(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_mixed_mcap(capture_dir / "run_a_0.mcap")

    summary = run_signal_report(
        capture_id=capture_id,
        data_dir=data_dir,
        topics=["/hsrb/joint_states", "/missing"],
    )["summary"]
    assert set(summary["topics"]) == {"/hsrb/joint_states"}
    assert summary["params"]["topics"] == ["/hsrb/joint_states", "/missing"]
    assert summary["skipped_topics"]["/missing"] == "topic not in recording"
    # The image topic was not requested, so it is absent from both maps.
    assert "/cam/image/compressed" not in summary["skipped_topics"]


# ---- guards ------------------------------------------------------------------


@pytest.mark.parametrize("bad", ["../../etc", "run_20260623_232808", "", "nope"])
def test_signal_report_rejects_non_uuid7_capture_id(tmp_path: Path, bad: str) -> None:
    data_dir = tmp_path / "data"
    (data_dir / "objects").mkdir(parents=True)
    with pytest.raises(ValueError, match="capture_id must be a UUIDv7"):
        run_signal_report(capture_id=bad, data_dir=data_dir)


def test_signal_report_missing_capture_dir_raises(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    (data_dir / "objects").mkdir(parents=True)
    with pytest.raises(FileNotFoundError, match="No capture found"):
        run_signal_report(capture_id=new_capture_id(), data_dir=data_dir)


def test_signal_report_rejects_bad_max_points(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, _ = make_capture(data_dir)
    with pytest.raises(ValueError, match="max_points"):
        run_signal_report(capture_id=capture_id, data_dir=data_dir, max_points=0)


# ---- registry wiring ---------------------------------------------------------


def test_registry_registers_signal_report() -> None:
    reg = build_default_registry()
    assert reg.runnable("signal_report")
    pipe = reg.get("signal_report")
    assert pipe is not None
    props = pipe.params_schema["properties"]
    assert props["max_points"]["default"] == DEFAULT_MAX_POINTS
    assert "topics" in props


def test_topics_param_requires_an_array_of_strings() -> None:
    assert _topics_param({}) is None
    assert _topics_param({"topics": None}) is None
    assert _topics_param({"topics": []}) is None
    assert _topics_param({"topics": ["/a", " ", "/b"]}) == ["/a", "/b"]
    with pytest.raises(ApiError):
        _topics_param({"topics": "/a, /b"})
    with pytest.raises(ApiError):
        _topics_param({"topics": 5})


def test_max_points_param_requires_an_integer() -> None:
    assert _max_points_param({}) == DEFAULT_MAX_POINTS
    assert _max_points_param({"max_points": 500}) == 500
    with pytest.raises(ApiError):
        _max_points_param({"max_points": 0})
    with pytest.raises(ApiError):
        _max_points_param({"max_points": "500"})
    with pytest.raises(ApiError):
        _max_points_param({"max_points": True})


def test_pipelines_endpoint_exposes_signal_report() -> None:
    app = create_dora_app(Settings(data_dir="/tmp"))
    with TestClient(app) as client:
        items = client.get("/pipelines").json()["items"]
        sig = next(p for p in items if p["id"] == "signal_report")
        assert sig["enabled"] is True
        assert "max_points" in sig["schema"]["properties"]
        assert "topics" in sig["schema"]["properties"]
