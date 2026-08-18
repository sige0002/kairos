# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""clock_check pipeline tests.

The stats helper is pure and unit-tested directly; the pipeline is exercised
against small synthetic MCAPs written with ``mcap_ros2.writer`` (real,
decodable ROS2 messages — the check must read ``header.stamp``), covering the
offset / negative-offset / mid-recording-step verdicts (including a step in
the BACK half of a long bag with mixed topic rates — the case a
forward-only "tail" window missed), the sampling invariants (``count`` never
exceeds ``message_count``; the decode budget is real), the headerless /
zero-stamp / partial-stamp / foreign-encoding honesty paths, the
publish_time cross-check and ``offset_kind`` classification, cancellation in
both passes, and the registry adapter's param validation. No live ROS graph
needed.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace

import pytest
from dora_runner.clock_check import (
    DEFAULT_THRESHOLD_MS,
    offset_stats,
    run_clock_check,
)
from dora_runner.models import JobCanceled
from dora_runner.registry import (
    MAX_CLOCK_CHECK_SAMPLES,
    _max_samples_param,
    _run_clock_check,
    _threshold_ms_param,
    build_default_registry,
)
from kairos_common import ApiError
from mcap.writer import Writer as RawWriter
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


def _write_topics(
    path: Path,
    topics: dict[str, dict],
) -> None:
    """Write several header-stamped topics into one MCAP.

    Per topic: ``n`` messages at ``log_step_ms`` cadence starting at
    ``_BASE_NS``; ``offset_ms`` (constant or ``f(i)``) sets
    ``log_time - header.stamp``; ``publish_offset_ms=None`` writes
    ``publish_time == log_time`` (untrustworthy-writer shape) while a number
    writes ``publish_time = log_time - that`` (a real sender-side stamp, so
    ``log - pub`` equals it); ``zero_stamp_from`` zeroes stamps from that
    message index on (``0`` = all).
    """
    with path.open("wb") as fh:
        w = Writer(fh)
        schema = w.register_msgdef("sensor_msgs/msg/JointState", _JOINT_DEF)
        for name, spec in topics.items():
            n = spec.get("n", 30)
            step = spec.get("log_step_ms", 100)
            offset = spec.get("offset_ms", 5.0)
            publish_offset = spec.get("publish_offset_ms")
            zero_from = spec.get("zero_stamp_from")
            for i in range(n):
                log = _BASE_NS + i * step * _MS
                off = offset(i) if callable(offset) else offset
                zeroed = zero_from is not None and i >= zero_from
                stamp_ns = 0 if zeroed else int(log - off * _MS)
                pub = log if publish_offset is None else int(log - publish_offset * _MS)
                w.write_message(
                    topic=name,
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


def _write_stamped_mcap(
    path: Path, *, topic: str = "/arm/joint_states", **spec
) -> None:
    _write_topics(path, {topic: spec})


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


def _write_empty_mcap(path: Path) -> None:
    with path.open("wb") as fh:
        w = Writer(fh)
        w.finish()


def _write_foreign_mcap(path: Path) -> None:
    """A non-ROS2 channel (json payloads), as an imported foreign bag has."""
    with path.open("wb") as fh:
        w = RawWriter(fh)
        w.start()
        schema_id = w.register_schema(name="Foreign", encoding="jsonschema", data=b"{}")
        channel_id = w.register_channel(
            topic="/foreign", message_encoding="json", schema_id=schema_id
        )
        for i in range(5):
            ts = _BASE_NS + i * 100 * _MS
            w.add_message(
                channel_id=channel_id,
                log_time=ts,
                publish_time=ts,
                data=b'{"x": 1}',
            )
        w.finish()


def _topic(summary: dict, name: str) -> dict:
    return next(t for t in summary["topics"] if t["name"] == name)


class _CountingEvent:
    """An Event whose ``is_set`` flips true after N observations.

    Lets a test land the cancellation INSIDE the decode pass: pass 1 checks
    once per message, so a threshold just past the bag's message count means
    the first trip happens in ``_sample_topic``.
    """

    def __init__(self, flip_after: int) -> None:
        self.calls = 0
        self.flip_after = flip_after

    def is_set(self) -> bool:
        self.calls += 1
        return self.calls > self.flip_after


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
    assert summary["note"] is None
    topic = _topic(summary, "/arm/joint_states")
    assert topic["median_ms"] == pytest.approx(5.0, abs=0.1)
    assert topic["offset_suspected"] is False
    assert topic["step_suspected"] is False
    assert topic["offset_kind"] is None
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
    # publish_time == log_time here, so the cross-check cannot classify.
    assert topic["offset_kind"] == "indeterminate"


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
        # A budget below the bag size exercises the two-window path.
        max_samples_per_topic=20,
    )["summary"]
    topic = _topic(summary, "/arm/joint_states")
    assert topic["head_median_ms"] == pytest.approx(10.0, abs=0.1)
    assert topic["tail_median_ms"] == pytest.approx(2000.0, abs=0.1)
    assert topic["step_suspected"] is True
    assert summary["result"] == "fail"
    assert "/arm/joint_states" in summary["flagged"]


def test_late_step_with_mixed_rates_is_caught(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """A step at 80% of a long bag with a dense AND a sparse topic.

    The review's counter-example to the first implementation: a
    forward-iterated 'tail window' sized off the sparsest topic sampled the
    bag's MIDDLE, and this exact scenario passed green. The tail is read in
    reverse now, so it is genuinely the tail for every topic.
    """
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    step_at_ns = _BASE_NS + 80_000 * _MS  # 80 s into a 100 s bag

    def offset(step_ms: int) -> Callable[[int], float]:
        def _f(i: int) -> float:
            return 5.0 if _BASE_NS + i * step_ms * _MS < step_at_ns else 2000.0

        return _f

    _write_topics(
        capture_dir / "run_x_0.mcap",
        {
            "/camera/fast": {"n": 10_000, "log_step_ms": 10, "offset_ms": offset(10)},
            "/diag/slow": {"n": 100, "log_step_ms": 1000, "offset_ms": offset(1000)},
        },
    )

    summary = run_clock_check(capture_id=capture_id, data_dir=data_dir)["summary"]
    fast = _topic(summary, "/camera/fast")
    assert fast["head_median_ms"] == pytest.approx(5.0, abs=0.1)
    assert fast["tail_median_ms"] == pytest.approx(2000.0, abs=0.1)
    assert fast["step_suspected"] is True
    slow = _topic(summary, "/diag/slow")
    assert slow["step_suspected"] is True
    assert summary["result"] == "fail"


def test_samples_never_exceed_messages(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """A topic smaller than the budget is read once — never double-counted."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(capture_dir / "run_x_0.mcap", n=30)

    summary = run_clock_check(capture_id=capture_id, data_dir=data_dir)["summary"]
    topic = _topic(summary, "/arm/joint_states")
    assert topic["message_count"] == 30
    assert topic["count"] == 30  # not 45: head+tail must not overlap
    assert topic["count"] <= topic["message_count"]


def test_decode_budget_is_real(
    tmp_path: Path,
    make_capture: Callable[[Path], tuple[str, Path]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The decoder runs at most ~budget times per topic, not once per message.

    A dense topic over budget plus a tiny topic under it: the first must cost
    head+tail quotas, the second its own message count — a regression to
    a shared full-bag decoded iteration fails this immediately.
    """
    import dora_runner.clock_check as cc

    calls = {"n": 0}
    real_factory = cc.DecoderFactory

    class CountingFactory(real_factory):  # type: ignore[misc, valid-type]
        def decoder_for(self, message_encoding, schema):  # type: ignore[override]
            decoder = super().decoder_for(message_encoding, schema)
            if decoder is None:
                return None

            def counting(data):
                calls["n"] += 1
                return decoder(data)

            return counting

    monkeypatch.setattr(cc, "DecoderFactory", CountingFactory)

    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_topics(
        capture_dir / "run_x_0.mcap",
        {
            "/dense": {"n": 500, "log_step_ms": 10},
            "/tiny": {"n": 2, "log_step_ms": 1000},
        },
    )

    summary = run_clock_check(
        capture_id=capture_id, data_dir=data_dir, max_samples_per_topic=20
    )["summary"]
    assert _topic(summary, "/dense")["count"] == 20
    assert _topic(summary, "/tiny")["count"] == 2
    # 10 head + 10 tail for /dense, 2 single-pass for /tiny.
    assert calls["n"] <= 22


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
    _write_stamped_mcap(capture_dir / "run_x_0.mcap", zero_stamp_from=0)

    summary = run_clock_check(capture_id=capture_id, data_dir=data_dir)["summary"]
    topic = _topic(summary, "/arm/joint_states")
    assert topic["count"] == 0
    assert topic["unstamped_sampled"] == 30
    assert "no usable header.stamp" in topic["reason"]
    assert summary["result"] == "pass"


def test_partially_unstamped_topic_is_disclosed(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """A clean-looking median over half the messages must say so."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(
        capture_dir / "run_x_0.mcap", n=40, offset_ms=9000.0, zero_stamp_from=20
    )

    summary = run_clock_check(capture_id=capture_id, data_dir=data_dir)["summary"]
    topic = _topic(summary, "/arm/joint_states")
    assert topic["count"] == 20
    assert topic["unstamped_sampled"] == 20
    assert topic["message_count"] == 40
    assert topic["offset_suspected"] is True


def test_empty_bag_says_nothing_was_checked(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_empty_mcap(capture_dir / "run_x_0.mcap")

    summary = run_clock_check(capture_id=capture_id, data_dir=data_dir)["summary"]
    assert summary["result"] == "pass"
    assert summary["topics"] == []
    assert "no messages" in summary["note"]


def test_no_match_glob_says_nothing_was_checked(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """A typo'd glob must not produce a silent green vouching for nothing."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(capture_dir / "run_x_0.mcap", offset_ms=-9000.0)

    summary = run_clock_check(
        capture_id=capture_id, data_dir=data_dir, target_topics=["/camera/*"]
    )["summary"]
    assert summary["topics"] == []
    assert "matched no topic" in summary["note"]


def test_foreign_encoding_channel_is_skipped_not_fatal(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """An imported bag's json channel must not lose the whole report."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_foreign_mcap(capture_dir / "run_x_0.mcap")

    summary = run_clock_check(capture_id=capture_id, data_dir=data_dir)["summary"]
    topic = _topic(summary, "/foreign")
    assert "not a ROS2 channel" in topic["reason"]
    assert topic["offset_suspected"] is False
    assert summary["result"] == "pass"


def test_ros2idl_channel_is_skipped_not_fatal(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """cdr+ros2idl is well-known MCAP but mcap_ros2's decoder rejects it.

    The review's N1: the first allowlist admitted ros2idl and the decode pass
    then died with DecoderNotFoundError — the exact crash the allowlist was
    added to prevent.
    """
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    with (capture_dir / "run_x_0.mcap").open("wb") as fh:
        w = RawWriter(fh)
        w.start()
        schema_id = w.register_schema(
            name="pkg/msg/Idl", encoding="ros2idl", data=b"module pkg {};"
        )
        channel_id = w.register_channel(
            topic="/idl", message_encoding="cdr", schema_id=schema_id
        )
        for i in range(5):
            ts = _BASE_NS + i * 100 * _MS
            w.add_message(
                channel_id=channel_id, log_time=ts, publish_time=ts, data=b"\x00"
            )
        w.finish()

    summary = run_clock_check(capture_id=capture_id, data_dir=data_dir)["summary"]
    topic = _topic(summary, "/idl")
    assert "not a ROS2 channel" in topic["reason"]
    assert summary["result"] == "pass"


def _unchunked_ros2_writer(fh):
    """A ros2 Writer over an UNCHUNKED mcap (no chunk index on disk).

    mcap_ros2's Writer does not expose ``use_chunking``, so this rebuilds its
    tiny __init__ around a raw writer with chunking off (test-only use of the
    private attributes; the write_message/finish paths are untouched).
    """
    from mcap.writer import Writer as McapWriter
    from mcap_ros2.writer import Writer as Ros2Writer
    from mcap_ros2.writer import _library_identifier

    w = Ros2Writer.__new__(Ros2Writer)
    w._writer = McapWriter(output=fh, use_chunking=False)
    w._encoders = {}
    w._channel_ids = {}
    w._writer.start(profile="ros2", library=_library_identifier())
    w._finished = False
    return w


def test_unchunked_mcap_never_presents_the_head_as_the_tail(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """The review's N2: reverse=True is silently ignored without a chunk index.

    An over-budget topic must then report NO tail (with a summary note), not
    the head under a tail label; a topic within the budget is read forward in
    full, so its step detection still works.
    """
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    with (capture_dir / "run_x_0.mcap").open("wb") as fh:
        w = _unchunked_ros2_writer(fh)
        schema = w.register_msgdef("sensor_msgs/msg/JointState", _JOINT_DEF)
        for name, n, step_ms in (("/dense", 400, 10), ("/small", 100, 40)):
            for i in range(n):
                log = _BASE_NS + i * step_ms * _MS
                off = 5.0 if i < n * 0.8 else 2000.0  # step at 80%
                stamp_ns = int(log - off * _MS)
                w.write_message(
                    topic=name,
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
                        "position": [0.0],
                        "velocity": [0.0],
                    },
                    log_time=log,
                    publish_time=log,
                )
        w.finish()

    summary = run_clock_check(capture_id=capture_id, data_dir=data_dir)["summary"]
    dense = _topic(summary, "/dense")  # 400 > budget: head-only, disclosed
    assert dense["tail_median_ms"] is None
    assert dense["step_suspected"] is False
    assert dense["head_median_ms"] == pytest.approx(5.0, abs=0.1)
    assert "no chunk index" in summary["note"]
    small = _topic(summary, "/small")  # 100 <= budget: full read still works
    assert small["step_suspected"] is True


def test_step_only_topic_is_classified_clock_step(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """A step whose blended median stays under the threshold: the step IS the
    diagnosis — no arbitrary clock/source label from a bimodal median."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(
        capture_dir / "run_x_0.mcap",
        n=40,
        offset_ms=lambda i: 5.0 if i < 20 else 600.0,
    )

    summary = run_clock_check(
        capture_id=capture_id, data_dir=data_dir, max_samples_per_topic=20
    )["summary"]
    topic = _topic(summary, "/arm/joint_states")
    assert topic["offset_suspected"] is False  # blended median ~300 < 500
    assert topic["step_suspected"] is True
    assert topic["offset_kind"] == "clock_step"
    assert summary["result"] == "fail"


def test_zero_budget_direct_call_never_double_counts(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """The registry rejects <10, but a direct call must still not lie."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(capture_dir / "run_x_0.mcap", n=1)

    summary = run_clock_check(
        capture_id=capture_id, data_dir=data_dir, max_samples_per_topic=0
    )["summary"]
    topic = _topic(summary, "/arm/joint_states")
    assert topic["count"] <= topic["message_count"]


# ---- publish cross-check + offset_kind --------------------------------------


def test_publish_time_cross_check_orientation_and_trust(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """log - publish, reported only when the writer's stamp is trustworthy."""
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


def test_replay_signature_is_classified_source_stamping(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """Huge header offset + ~0 publish offset = inherited stamps, not clocks.

    The real-world case that motivated offset_kind: a capture of a bag REPLAY
    carries the original session's header stamps (days old) while the DDS
    stamps prove the recorder and the (replaying) publisher clocks agreed.
    """
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(
        capture_dir / "run_x_0.mcap", offset_ms=86_400_000.0, publish_offset_ms=2.0
    )

    summary = run_clock_check(capture_id=capture_id, data_dir=data_dir)["summary"]
    topic = _topic(summary, "/arm/joint_states")
    assert topic["offset_suspected"] is True
    assert topic["offset_kind"] == "source_stamping"


def test_agreeing_signals_are_classified_clock_disagreement(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """Header and DDS stamps telling the same story = the clock itself."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(
        capture_dir / "run_x_0.mcap", offset_ms=-3000.0, publish_offset_ms=-3000.0
    )

    summary = run_clock_check(capture_id=capture_id, data_dir=data_dir)["summary"]
    topic = _topic(summary, "/arm/joint_states")
    assert topic["offset_suspected"] is True
    assert topic["offset_kind"] == "clock_disagreement"


# ---- cancellation ------------------------------------------------------------


def test_cancel_checkpoint_in_pass_one(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(capture_dir / "run_x_0.mcap")
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(JobCanceled):
        run_clock_check(capture_id=capture_id, data_dir=data_dir, cancel=cancel)


def test_cancel_checkpoint_in_decode_pass(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """A cancel landing after the raw sweep still stops the decode."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_stamped_mcap(capture_dir / "run_x_0.mcap", n=30)
    # Pass 1 observes the event once per message (30); flip just past that so
    # the first True lands inside _sample_topic.
    cancel = _CountingEvent(flip_after=30)
    with pytest.raises(JobCanceled):
        run_clock_check(
            capture_id=capture_id,
            data_dir=data_dir,
            cancel=cancel,  # type: ignore[arg-type]
        )
    assert cancel.calls > 30  # the decode pass really was entered


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
    for bad in (0, -1, "nope", float("inf"), float("nan"), True):
        with pytest.raises(ApiError):
            _threshold_ms_param({"threshold_ms": bad})
    for bad in (5, 10.9, "nope", True, MAX_CLOCK_CHECK_SAMPLES + 1):
        with pytest.raises(ApiError):
            _max_samples_param({"max_samples_per_topic": bad})
    assert _threshold_ms_param({}) == DEFAULT_THRESHOLD_MS
    assert _threshold_ms_param({"threshold_ms": 250}) == 250.0
    assert _max_samples_param({"max_samples_per_topic": 50}) == 50


def test_adapter_threads_params_through(monkeypatch: pytest.MonkeyPatch) -> None:
    """Dropping a kwarg from the adapter call must fail a test, not ship."""
    import dora_runner.registry as reg

    seen: dict = {}

    def fake_run(**kwargs):
        seen.update(kwargs)
        return {"summary": {}, "artifacts": []}

    monkeypatch.setattr(reg, "run_clock_check", fake_run)
    job = SimpleNamespace(
        capture_id="cap",
        params={
            "threshold_ms": 250,
            "max_samples_per_topic": 40,
            "target_topics": ["/a/*"],
        },
        cancel_event=threading.Event(),
    )
    asyncio.run(_run_clock_check(job, None, Path("/data")))  # type: ignore[arg-type]
    assert seen["threshold_ms"] == 250.0
    assert seen["max_samples_per_topic"] == 40
    assert seen["target_topics"] == ["/a/*"]
    assert seen["capture_id"] == "cap"
    assert seen["cancel"] is job.cancel_event


def test_bad_capture_id_is_rejected() -> None:
    with pytest.raises(ValueError):
        run_clock_check(capture_id="../escape", data_dir=Path("/tmp"))


def test_missing_capture_dir(tmp_path: Path) -> None:
    from kairos_common.ids import new_capture_id

    with pytest.raises(FileNotFoundError):
        run_clock_check(capture_id=new_capture_id(), data_dir=tmp_path)
