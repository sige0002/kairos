"""Stop-time quick-check: the MCAP summary read, the layer builders, the verdict.

Everything here is pure — no monitor, no recorder, no disk beyond a tiny MCAP
fixture — which is the point of keeping the settlement logic out of the service.
The end-to-end settlement, and the late re-derivation of a review's quality once
the verdict lands, are exercised in ``test_record_lifecycle.py`` where a real
stop drives them.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from api_orchestrator.models import (
    QuickCheckLayer0,
    QuickCheckLayer1,
)
from api_orchestrator.quick_check import (
    McapSummary,
    build_layer0,
    build_layer1,
    compute_verdict,
    incidents_in_window,
    read_mcap_summary,
    resolve_expected_hz,
)
from kairos_common import ExpectedHzPattern, RecordingConfig
from mcap.writer import Writer

# ---- tiny MCAP fixture ----------------------------------------------------


def _write_tiny_mcap(
    path: Path, topic_counts: dict[str, int], *, start_ns: int, step_ns: int
) -> None:
    """Write a minimal valid MCAP (summary section included) at *path*.

    Each topic gets ``count`` messages spaced ``step_ns`` apart from
    ``start_ns``, so the summary's statistics carry real per-channel counts and
    message start/end bounds — enough to exercise the summary-only reader.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as fh:
        writer = Writer(fh)
        writer.start()
        for topic, count in topic_counts.items():
            schema_id = writer.register_schema(
                name="std_msgs/Empty", encoding="", data=b""
            )
            channel_id = writer.register_channel(
                topic=topic, message_encoding="cdr", schema_id=schema_id
            )
            for i in range(count):
                t = start_ns + i * step_ns
                writer.add_message(
                    channel_id=channel_id,
                    log_time=t,
                    data=b"",
                    publish_time=t,
                    sequence=i,
                )
        writer.finish()


# ---- expected_hz resolver -------------------------------------------------


def test_resolve_expected_hz_first_match_wins_skips_none() -> None:
    cfg = RecordingConfig(
        robot_name="t",
        expected_hz_patterns=[
            ExpectedHzPattern(pattern="/cam/*", hz=None),  # dynamic -> skipped
            ExpectedHzPattern(pattern="/cam/rgb", hz=15.0),
            ExpectedHzPattern(pattern="/tf", hz=30.0),
        ],
    )
    # The None-hz pattern matches first but is skipped, so the concrete 15 wins.
    assert resolve_expected_hz(cfg, "/cam/rgb") == 15.0
    assert resolve_expected_hz(cfg, "/tf") == 30.0
    assert resolve_expected_hz(cfg, "/unknown") is None
    assert resolve_expected_hz(None, "/tf") is None


# ---- incident window filter ----------------------------------------------


def test_incidents_in_window_overlap() -> None:
    incs = [
        {"id": "a", "fired_at_ns": 50, "cleared_at_ns": 150},  # overlaps [100,200]
        {"id": "b", "fired_at_ns": 250, "cleared_at_ns": None},  # after window
        {"id": "c", "fired_at_ns": 10, "cleared_at_ns": 40},  # cleared before start
        {"id": "d", "fired_at_ns": 120, "cleared_at_ns": None},  # inside, still active
        # Fired BEFORE the window and still open — the case the monitor's
        # one-sided since_ns filter would drop; the client overlap filter keeps it.
        {"id": "e", "fired_at_ns": 5, "cleared_at_ns": None},
    ]
    kept = {i["id"] for i in incidents_in_window(incs, 100, 200)}
    assert kept == {"a", "d", "e"}


def test_incidents_in_window_passthrough_when_bounds_unknown() -> None:
    incs = [{"id": "a", "fired_at_ns": 1}, {"id": "b", "fired_at_ns": 2}]
    assert len(incidents_in_window(incs, None, None)) == 2


# ---- MCAP summary reader --------------------------------------------------


def test_read_mcap_summary_counts_and_duration(tmp_path: Path) -> None:
    run_dir = tmp_path / "run_x"
    start = 1_000_000_000  # 1s in ns
    step = 100_000_000  # 0.1s -> 10 Hz
    _write_tiny_mcap(
        run_dir / "run_x.mcap", {"/tf": 10, "/joints": 5}, start_ns=start, step_ns=step
    )
    summary = read_mcap_summary(run_dir)
    assert summary is not None
    assert summary.message_counts == {"/tf": 10, "/joints": 5}
    # start/end span the /tf messages (the longer series): 9 steps = 0.9s.
    assert summary.duration_s == pytest.approx(0.9, abs=1e-6)


def test_read_mcap_summary_missing_file_is_none(tmp_path: Path) -> None:
    (tmp_path / "empty").mkdir()
    assert read_mcap_summary(tmp_path / "empty") is None
    assert read_mcap_summary(tmp_path / "does_not_exist") is None


def test_read_mcap_summary_corrupt_bag_degrades(tmp_path: Path) -> None:
    """A truncated bag (summary unreadable) degrades to an empty summary, not a
    crash — the caller then marks summary_available=False."""
    run_dir = tmp_path / "run_t"
    mcap_path = run_dir / "run_t.mcap"
    _write_tiny_mcap(mcap_path, {"/tf": 4}, start_ns=0, step_ns=1)
    # Lop off the tail (footer + summary) so get_summary fails.
    data = mcap_path.read_bytes()
    mcap_path.write_bytes(data[: len(data) // 2])
    summary = read_mcap_summary(run_dir)
    assert summary is not None  # file present -> not None ...
    assert summary.message_counts == {}  # ... but no usable summary section.
    assert summary.start_ns is None


# ---- verdict rules --------------------------------------------------------


def _clean_layer1() -> QuickCheckLayer1:
    return build_layer1(
        summary=McapSummary(
            message_counts={"/tf": 300}, start_ns=0, end_ns=10_000_000_000
        ),
        config=None,
        required_topics=["/tf"],
    )


def test_verdict_good_when_all_clean() -> None:
    layer0 = QuickCheckLayer0(available=True, integrity="ok", incidents=[])
    verdict = compute_verdict(layer0, _clean_layer1())
    assert verdict.quality == "good"
    assert verdict.reasons == []


def test_verdict_needs_review_on_integrity_dropped() -> None:
    layer0 = QuickCheckLayer0(available=True, integrity="dropped")
    verdict = compute_verdict(layer0, _clean_layer1())
    assert verdict.quality == "needs_review"
    assert any("integrity" in r for r in verdict.reasons)


def test_verdict_needs_review_on_unknown_integrity() -> None:
    layer0 = QuickCheckLayer0(available=True, integrity=None)
    verdict = compute_verdict(layer0, _clean_layer1())
    assert verdict.quality == "needs_review"
    assert any("could not be confirmed" in r for r in verdict.reasons)


def test_verdict_needs_review_on_danger_incident() -> None:
    layer0 = QuickCheckLayer0(
        available=True,
        integrity="ok",
        incidents=[
            {"topic": "/hsrb/hand_camera", "metric": "hz", "severity": "danger"}
        ],
    )
    verdict = compute_verdict(layer0, _clean_layer1())
    assert verdict.quality == "needs_review"
    assert any("/hsrb/hand_camera" in r for r in verdict.reasons)


def test_verdict_ignores_warning_incident() -> None:
    layer0 = QuickCheckLayer0(
        available=True,
        integrity="ok",
        incidents=[{"topic": "/tf", "metric": "hz", "severity": "warning"}],
    )
    assert compute_verdict(layer0, _clean_layer1()).quality == "good"


def test_verdict_needs_review_on_hz_shortfall() -> None:
    # 100 messages over 10s = 10 Hz, expected 30 Hz -> below 0.8 x 30 = 24.
    cfg = RecordingConfig(
        robot_name="t",
        expected_hz_patterns=[ExpectedHzPattern(pattern="/hsrb/hand_camera", hz=30.0)],
    )
    layer1 = build_layer1(
        summary=McapSummary(
            message_counts={"/hsrb/hand_camera": 100},
            start_ns=0,
            end_ns=10_000_000_000,
        ),
        config=cfg,
        required_topics=["/hsrb/hand_camera"],
    )
    layer0 = QuickCheckLayer0(available=True, integrity="ok")
    verdict = compute_verdict(layer0, layer1)
    assert verdict.quality == "needs_review"
    assert any(
        "/hsrb/hand_camera" in r and "expected 30Hz" in r for r in verdict.reasons
    )


def test_verdict_needs_review_on_missing_and_empty_topics() -> None:
    layer1 = build_layer1(
        summary=McapSummary(
            message_counts={"/tf": 100, "/empty": 0}, start_ns=0, end_ns=1_000_000_000
        ),
        config=None,
        required_topics=["/tf", "/missing"],
    )
    assert layer1.missing_topics == ["/missing"]
    assert layer1.empty_topics == ["/empty"]
    verdict = compute_verdict(QuickCheckLayer0(integrity="ok"), layer1)
    assert verdict.quality == "needs_review"
    assert any("/missing" in r for r in verdict.reasons)
    assert any("/empty" in r for r in verdict.reasons)


def test_verdict_needs_review_on_missing_summary() -> None:
    # summary section absent (unclean stop) -> strong needs_review signal.
    layer1 = build_layer1(summary=McapSummary(), config=None, required_topics=["/tf"])
    assert layer1.available is True
    assert layer1.summary_available is False
    verdict = compute_verdict(QuickCheckLayer0(integrity="ok"), layer1)
    assert verdict.quality == "needs_review"
    assert any("summary unavailable" in r for r in verdict.reasons)


# ---- layer 0 builder ------------------------------------------------------


def test_build_layer0_baseline_delta_and_scoping() -> None:
    monitor_topics = [
        {
            "name": "/tf",
            "hz": 29.7,
            "rate_shortfall": 0.01,
            "gap_max_ms": 40,
            "dds_samples_lost": 12,
        },
        {"name": "/other", "hz": 10.0, "dds_samples_lost": 5},
    ]
    layer0 = build_layer0(
        integrity="ok",
        backstop=None,
        monitor_topics=monitor_topics,
        baseline_dds={"/tf": 4},  # whole-window: 12 - 4 = 8
        incidents=[],
        topic_names=["/tf"],  # scope to the recorded topic only
        config=None,
    )
    assert layer0.available is True
    assert set(layer0.topics) == {"/tf"}
    assert layer0.topics["/tf"].dds_samples_lost == 8
    assert layer0.topics["/tf"].hz == 29.7


def test_build_layer0_unavailable_when_monitor_absent() -> None:
    layer0 = build_layer0(
        integrity="ok",
        backstop=None,
        monitor_topics=None,
        baseline_dds=None,
        incidents=None,
        topic_names=["/tf"],
        config=None,
    )
    assert layer0.available is False
    assert layer0.topics == {}
    # Integrity is recorder-sourced, so it survives a monitor outage.
    assert layer0.integrity == "ok"
