"""clock_check pipeline tests.

The stats helper is pure and unit-tested directly; the pipeline is exercised
against small synthetic MCAPs written with ``mcap_ros2.writer`` (real,
decodable ROS2 messages — the check must read ``header.stamp``), covering the
offset / negative-offset / mid-recording-step verdicts, the headerless and
zero-stamp honesty paths, the publish_time cross-check, and the registry
adapter's param validation. No live ROS graph needed.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path

import pytest
from dora_runner.clock_check import (
    DEFAULT_THRESHOLD_MS,
    offset_stats,
    run_clock_check,
)
from dora_runner.models import JobCanceled
from dora_runner.registry import (
    _max_samples_param,
    _threshold_ms_param,
    build_default_registry,
)
from kairos_common import ApiError
from mcap_ros2.writer import Writer

_MS = 1_000_000  # nanoseconds per millisecond
# An epoch-like base so timestamps carry real-bag magnitudes.
_BASE_NS = 1_760_000_000 * 1_000_000_000

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
_STRING_DEF = "string data\n"


def _write_stamped_mcap(
    path: Path,
    *,
    n: int = 30,
    log_step_ms: int = 100,
    offset_ms: float | Callable[[int], float] = 5.0,
    topic: str = "/arm/joint_states",
    publish_offset_ms: float | None = None,
    zero_stamp: bool = False,
) -> None:
    """Write a header-stamped topic whose ``log_time - header.stamp`` is known.

    *offset_ms* is the recorder-minus-publisher offset per message (constant,
    or a function of the message index for step scenarios).
    ``publish_offset_ms=None`` writes ``publish_time == log_time`` (the
    untrustworthy-writer shape); a number writes a real sender-side stamp.
    """
    with path.open("wb") as fh:
        w = Writer(fh)
        schema = w.register_msgdef("sensor_msgs/msg/JointState", _JOINT_DEF)
        for i in range(n):
            log = _BASE_NS + i * log_step_ms * _MS
            off = offset_ms(i) if callable(offset_ms) else offset_ms
            stamp_ns = 0 if zero_stamp else int(log - off * _MS)
            pub = (
                log if publish_offset_ms is None else int(log + publish_offset_ms * _MS)
            )
            w.write_message(
                topic=topic,
                schema=schema,
                message={
                    "header": {
                        "stamp": {
                            "sec": stamp_ns // 1_000_000_000,
                            "nanosec": stamp_ns % 1_000_000_000,
                        },
                        "frame_id": "f",
                    },
                    "name": ["j"],
                    "position": [float(i)],
                    "velocity": [0.0],
                },
                log_time=log,
                publish_time=pub,
            )
        w.finish()


def _write_headerless_mcap(path: Path, *, n: int = 10) -> None:
    with path.open("wb") as fh:
        w = Writer(fh)
        schema = w.register_msgdef("std_msgs/msg/String", _STRING_DEF)
        for i in range(n):
            ts = _BASE_NS + i * 100 * _MS
            w.write_message(
                topic="/notes",
                schema=schema,
                message={"data": "x"},
                log_time=ts,
                publish_time=ts,
            )
        w.finish()


def _topic(summary: dict, name: str) -> dict:
    return next(t for t in summary["topics"] if t["name"] == name)


# ---- offset_stats (pure) -----------------------------------------------------


def test_offset_stats_empty() -> None:
    stats = offset_stats([])
    assert stats["count"] == 0
    assert stats["median_ms"] is None
    assert stats["negative_share"] is None


def test_offset_stats_basic() -> None:
    stats = offset_stats([-10.0, 5.0, 5.0, 5.0, 100.0])
    assert stats["count"] == 5
    assert stats["median_ms"] == 5.0
    assert stats["min_ms"] == -10.0
    assert stats["max_ms"] == 100.0
    assert stats["negative_share"] == pytest.approx(0.2)


# ---- verdicts over synthetic bags -------------------------------------------


def test_aligned_clocks_pass(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """A few ms of transport latency is latency, not a clock problem."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(capture_dir / "run_x_0.mcap", offset_ms=5.0)

    result = run_clock_check(capture_id=capture_id, data_dir=data_dir)
    summary = result["summary"]
    assert summary["result"] == "pass"
    assert summary["flagged"] == []
    topic = _topic(summary, "/arm/joint_states")
    assert topic["median_ms"] == pytest.approx(5.0, abs=0.1)
    assert topic["offset_suspected"] is False
    assert topic["step_suspected"] is False
    # The sidecar landed where the orchestrator looks for it.
    assert (data_dir / "report" / "clock_check" / capture_id / "summary.json").exists()


def test_recorder_running_behind_fails_with_negative_offsets(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """Recorder clock 3 s behind: 'received before published', all negative."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(capture_dir / "run_x_0.mcap", offset_ms=-3000.0)

    summary = run_clock_check(capture_id=capture_id, data_dir=data_dir)["summary"]
    assert summary["result"] == "fail"
    topic = _topic(summary, "/arm/joint_states")
    assert topic["offset_suspected"] is True
    assert topic["median_ms"] == pytest.approx(-3000.0, abs=0.1)
    assert topic["negative_share"] == 1.0


def test_mid_recording_clock_step_is_flagged(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """An NTP step mid-bag: head and tail disagree about the offset."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(
        capture_dir / "run_x_0.mcap",
        n=40,
        offset_ms=lambda i: 10.0 if i < 20 else 2000.0,
    )

    summary = run_clock_check(
        capture_id=capture_id,
        data_dir=data_dir,
        # A budget below the bag size keeps the head window genuinely the head.
        max_samples_per_topic=20,
    )["summary"]
    topic = _topic(summary, "/arm/joint_states")
    assert topic["head_median_ms"] == pytest.approx(10.0, abs=0.1)
    assert topic["tail_median_ms"] == pytest.approx(2000.0, abs=0.1)
    assert topic["step_suspected"] is True
    assert summary["result"] == "fail"
    assert "/arm/joint_states" in summary["flagged"]


def test_headerless_topic_is_reported_not_flagged(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_headerless_mcap(capture_dir / "run_x_0.mcap")

    summary = run_clock_check(capture_id=capture_id, data_dir=data_dir)["summary"]
    topic = _topic(summary, "/notes")
    assert topic["count"] == 0
    assert "no usable header.stamp" in topic["reason"]
    assert topic["offset_suspected"] is False
    assert summary["result"] == "pass"


def test_zero_stamps_never_fabricate_an_epoch_offset(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """stamp == 0 is 'never stamped', not a ~56-year clock offset."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(capture_dir / "run_x_0.mcap", zero_stamp=True)

    summary = run_clock_check(capture_id=capture_id, data_dir=data_dir)["summary"]
    topic = _topic(summary, "/arm/joint_states")
    assert topic["count"] == 0
    assert "no usable header.stamp" in topic["reason"]
    assert summary["result"] == "pass"


def test_threshold_param_tightens_the_verdict(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(capture_dir / "run_x_0.mcap", offset_ms=100.0)

    default = run_clock_check(capture_id=capture_id, data_dir=data_dir)["summary"]
    assert default["result"] == "pass"  # 100 ms < the 500 ms default

    strict = run_clock_check(
        capture_id=capture_id, data_dir=data_dir, threshold_ms=50.0
    )["summary"]
    assert strict["result"] == "fail"


def test_target_topics_filter(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(
        capture_dir / "run_x_0.mcap", offset_ms=-3000.0, topic="/arm/joint_states"
    )

    summary = run_clock_check(
        capture_id=capture_id, data_dir=data_dir, target_topics=["/camera/*"]
    )["summary"]
    assert summary["topics"] == []
    assert summary["result"] == "pass"


def test_publish_time_cross_check(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """A trustworthy sender-side publish_time yields the no-decode cross-check;
    a writer that copied the receive time in yields None, never a vacuous 0."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(capture_dir / "run_x_0.mcap", publish_offset_ms=7.0)

    summary = run_clock_check(capture_id=capture_id, data_dir=data_dir)["summary"]
    topic = _topic(summary, "/arm/joint_states")
    assert topic["publish_offset_median_ms"] == pytest.approx(7.0, abs=0.1)

    capture_id2, capture_dir2 = make_capture(data_dir)
    _write_stamped_mcap(capture_dir2 / "run_x_0.mcap", publish_offset_ms=None)
    summary2 = run_clock_check(capture_id=capture_id2, data_dir=data_dir)["summary"]
    assert _topic(summary2, "/arm/joint_states")["publish_offset_median_ms"] is None


def test_cancel_checkpoint(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(capture_dir / "run_x_0.mcap")
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(JobCanceled):
        run_clock_check(capture_id=capture_id, data_dir=data_dir, cancel=cancel)


# ---- registry adapter --------------------------------------------------------


def test_clock_check_is_registered_and_runnable() -> None:
    registry = build_default_registry(discover=False)
    pipeline = registry.get("clock_check")
    assert pipeline is not None
    assert pipeline.enabled
    assert pipeline.params_schema["properties"]["threshold_ms"]["default"] == (
        DEFAULT_THRESHOLD_MS
    )


def test_param_coercers_reject_bad_values() -> None:
    with pytest.raises(ApiError):
        _threshold_ms_param({"threshold_ms": 0})
    with pytest.raises(ApiError):
        _threshold_ms_param({"threshold_ms": "nope"})
    with pytest.raises(ApiError):
        _max_samples_param({"max_samples_per_topic": 5})
    assert _threshold_ms_param({}) == DEFAULT_THRESHOLD_MS
    assert _max_samples_param({"max_samples_per_topic": 50}) == 50


def test_bad_capture_id_and_missing_capture() -> None:
    with pytest.raises(ValueError):
        run_clock_check(capture_id="../escape", data_dir=Path("/tmp"))


def test_missing_capture_dir(tmp_path: Path) -> None:
    from kairos_common.ids import new_capture_id

    with pytest.raises(FileNotFoundError):
        run_clock_check(capture_id=new_capture_id(), data_dir=tmp_path)
