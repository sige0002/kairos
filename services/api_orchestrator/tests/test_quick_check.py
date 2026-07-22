"""Stop-time quick-check settlement: pure verdict rules, MCAP summary read,
end-to-end settlement through ``RunService.stop()`` with a mocked monitor, and
the episode-quality derivation seam.

The pure builders/verdict are exercised without any I/O; the integration tests
drive the real settlement (scheduled off the stop path) and drain it
deterministically before asserting the persisted ``quick_check``.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest
from api_orchestrator.models import (
    Batch,
    Episode,
    QuickCheck,
    QuickCheckLayer0,
    QuickCheckLayer1,
    QuickCheckVerdict,
    RecordStartRequest,
    Run,
    RunState,
)
from api_orchestrator.monitor_client import MonitorClient
from api_orchestrator.quick_check import (
    McapSummary,
    assemble_quick_check,
    build_layer0,
    build_layer1,
    compute_verdict,
    incidents_in_window,
    read_mcap_summary,
    resolve_expected_hz,
)
from api_orchestrator.recorder_client import RecorderClient
from api_orchestrator.runs import RunService
from api_orchestrator.store import RunStore
from conftest import FakeRecorder
from fastapi.testclient import TestClient
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


def test_extension_events_in_window() -> None:
    from api_orchestrator.quick_check import (
        EXTENSION_EVENTS_CAP,
        extension_events_in_window,
    )

    s = 1_000_000_000  # ns per second
    events = [
        {"kind": "before", "t": 0.5},
        {"kind": "inside", "t": 1.5},
        {"kind": "after", "t": 3.5},
        {"kind": "no_t"},  # unplaceable -> dropped
        {"kind": "bad_t", "t": "x"},
        "not-a-dict",
    ]
    kept = extension_events_in_window(events, 1 * s, 2 * s)
    assert [e["kind"] for e in kept] == ["inside"]
    # unknown bounds pass placeable events through
    kept_all = extension_events_in_window(events, None, None)
    assert [e["kind"] for e in kept_all] == ["before", "inside", "after"]
    # cap keeps the NEWEST entries
    many = [{"kind": f"e{i}", "t": float(i)} for i in range(100)]
    capped = extension_events_in_window(many, None, None)
    assert len(capped) == EXTENSION_EVENTS_CAP
    assert capped[-1]["kind"] == "e99"


def test_assemble_quick_check_carries_extension_events() -> None:
    quick = assemble_quick_check(
        layer0=build_layer0(
            integrity="ok",
            backstop=None,
            monitor_topics=None,
            baseline_dds=None,
            incidents=None,
            topic_names=[],
            config=None,
        ),
        layer1=build_layer1(summary=None, config=None, required_topics=[]),
        elapsed_ms=1,
        extension_events=[{"kind": "dark_frame", "t": 1.0}],
    )
    assert quick.extension_events == [{"kind": "dark_frame", "t": 1.0}]
    # informational only: the verdict must not mention extension events
    assert all("extension" not in r for r in quick.verdict.reasons)


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


# ---- integration: settlement through RunService.stop() --------------------


class _MonitorFakes:
    """Transport that serves recorder paths via FakeRecorder plus monitor
    ``/metrics`` and ``/incidents`` bodies (configurable per test)."""

    def __init__(self, recorder: FakeRecorder) -> None:
        self._recorder = recorder
        self.metrics_body: dict | None = {
            "topics": [
                {
                    "name": "/tf",
                    "hz": 30.0,
                    "rate_shortfall": 0.0,
                    "gap_max_ms": 10,
                    "dds_samples_lost": 0,
                },
            ]
        }
        self.incidents_body: dict | None = {"incidents": []}

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/metrics":
            if self.metrics_body is None:
                return httpx.Response(
                    503, json={"error": {"code": "x", "message": "down"}}
                )
            return httpx.Response(200, json=self.metrics_body)
        if path == "/incidents":
            if self.incidents_body is None:
                return httpx.Response(
                    404, json={"error": {"code": "x", "message": "no"}}
                )
            return httpx.Response(200, json=self.incidents_body)
        return self._recorder.handler(request)


async def _drive_stop(
    store: RunStore,
    fakes: _MonitorFakes,
    *,
    config: RecordingConfig | None,
    recorded_dir: Path,
    mcap_topics: dict[str, int] | None,
) -> Run:
    """start -> (optionally write a bag) -> stop -> drain settlement; return run."""
    client = httpx.AsyncClient(transport=httpx.MockTransport(fakes.handler))
    recorder = RecorderClient("http://recorder", client)
    monitor = MonitorClient("http://monitor", client)
    svc = RunService(
        store,
        recorder,
        recording_config=config,
        recorded_dir=recorded_dir,
        monitor=monitor,
    )
    run = await svc.start(RecordStartRequest(topics=["/tf"]))
    if mcap_topics is not None:
        start_ns = 1_000_000_000
        _write_tiny_mcap(
            recorded_dir / run.run_id / f"{run.run_id}.mcap",
            mcap_topics,
            start_ns=start_ns,
            step_ns=100_000_000,
        )
    await svc.stop()
    await svc.drain_settlements()
    await client.aclose()
    return store.get(run.run_id)


def test_settlement_good_verdict_end_to_end(tmp_path: Path) -> None:
    store = RunStore(":memory:")
    try:
        fakes = _MonitorFakes(FakeRecorder())
        run = asyncio.run(
            _drive_stop(
                store,
                fakes,
                config=None,
                recorded_dir=tmp_path,
                mcap_topics={"/tf": 300},
            )
        )
        qc = run.quick_check
        assert qc is not None
        assert qc.layer0.available is True
        assert qc.layer0.integrity == "ok"
        assert qc.layer1.available is True and qc.layer1.summary_available is True
        assert qc.layer1.topics["/tf"].message_count == 300
        assert qc.verdict.quality == "good"
        assert qc.verdict.reasons == []
    finally:
        store.close()


def test_settlement_hz_shortfall_end_to_end(tmp_path: Path) -> None:
    store = RunStore(":memory:")
    try:
        cfg = RecordingConfig(
            robot_name="t",
            expected_hz_patterns=[ExpectedHzPattern(pattern="/tf", hz=30.0)],
        )
        fakes = _MonitorFakes(FakeRecorder())
        # 30 messages over ~2.9s -> ~10 Hz, well under 0.8 x 30.
        run = asyncio.run(
            _drive_stop(
                store, fakes, config=cfg, recorded_dir=tmp_path, mcap_topics={"/tf": 30}
            )
        )
        qc = run.quick_check
        assert qc.verdict.quality == "needs_review"
        assert any("/tf avg" in r and "expected 30Hz" in r for r in qc.verdict.reasons)
    finally:
        store.close()


def test_settlement_monitor_unreachable_degrades(tmp_path: Path) -> None:
    store = RunStore(":memory:")
    try:
        fakes = _MonitorFakes(FakeRecorder())
        fakes.metrics_body = None  # monitor /metrics 503
        fakes.incidents_body = None  # monitor /incidents 404
        run = asyncio.run(
            _drive_stop(
                store,
                fakes,
                config=None,
                recorded_dir=tmp_path,
                mcap_topics={"/tf": 300},
            )
        )
        qc = run.quick_check
        assert qc is not None
        # Layer 0 monitor part is honestly unavailable ...
        assert qc.layer0.available is False
        assert qc.layer0.topics == {}
        # ... but recorder integrity + Layer 1 still land, so the verdict is good.
        assert qc.layer0.integrity == "ok"
        assert qc.layer1.summary_available is True
        assert qc.verdict.quality == "good"
    finally:
        store.close()


def test_settlement_missing_summary_degrades(tmp_path: Path) -> None:
    store = RunStore(":memory:")
    try:
        fakes = _MonitorFakes(FakeRecorder())
        # No bag written -> Layer 1 unavailable -> needs_review (honest).
        run = asyncio.run(
            _drive_stop(
                store, fakes, config=None, recorded_dir=tmp_path, mcap_topics=None
            )
        )
        qc = run.quick_check
        assert qc.layer1.available is False
        assert qc.layer1.summary_available is False
        assert qc.verdict.quality == "needs_review"
        assert any("summary unavailable" in r for r in qc.verdict.reasons)
    finally:
        store.close()


def test_settlement_captures_start_baseline_for_dds_delta(tmp_path: Path) -> None:
    """The record-start baseline makes dds_samples_lost whole-window (stop-start)."""
    store = RunStore(":memory:")
    try:
        fakes = _MonitorFakes(FakeRecorder())
        # Baseline (at start) and stop snapshots share the same client body, so
        # set a non-zero cumulative value: with an equal baseline the delta is 0.
        fakes.metrics_body = {
            "topics": [{"name": "/tf", "hz": 30.0, "dds_samples_lost": 7}]
        }
        run = asyncio.run(
            _drive_stop(
                store,
                fakes,
                config=None,
                recorded_dir=tmp_path,
                mcap_topics={"/tf": 300},
            )
        )
        # start baseline 7, stop 7 -> whole-window delta 0 (not the raw 7).
        assert run.quick_check.layer0.topics["/tf"].dds_samples_lost == 0
    finally:
        store.close()


# ---- assemble + persistence round-trip ------------------------------------


def test_quick_check_store_roundtrip() -> None:
    store = RunStore(":memory:")
    try:
        store.create(Run(run_id="run_qc", state=RunState.completed))
        qc = assemble_quick_check(
            layer0=QuickCheckLayer0(available=True, integrity="ok"),
            layer1=build_layer1(
                summary=McapSummary(
                    message_counts={"/tf": 10}, start_ns=0, end_ns=1_000_000_000
                ),
                config=None,
                required_topics=["/tf"],
            ),
            elapsed_ms=42,
        )
        store.update("run_qc", quick_check=qc)
        loaded = store.get("run_qc").quick_check
        assert isinstance(loaded, QuickCheck)
        assert loaded.elapsed_ms == 42
        assert loaded.verdict.quality == "good"
        assert loaded.layer1.topics["/tf"].message_count == 10
    finally:
        store.close()


# ---- late-settlement episode re-derive (F1) -------------------------------


async def _drive_stop_with_episode(
    store: RunStore,
    fakes: _MonitorFakes,
    *,
    config: RecordingConfig | None,
    recorded_dir: Path,
    mcap_topics: dict[str, int] | None,
    seed_quality: str | None,
    seed_source: str,
) -> Episode | None:
    """start -> save an episode BEFORE settlement -> stop -> drain settlement.

    Seeds an episode on the run while the quick_check is still unsettled (the
    save-before-settle race), with the given quality + source, then returns the
    episode after settlement so a test can assert whether it was re-derived.
    ``seed_quality=None`` seeds no episode (the no-op case).
    """
    client = httpx.AsyncClient(transport=httpx.MockTransport(fakes.handler))
    recorder = RecorderClient("http://recorder", client)
    monitor = MonitorClient("http://monitor", client)
    svc = RunService(
        store,
        recorder,
        recording_config=config,
        recorded_dir=recorded_dir,
        monitor=monitor,
    )
    run = await svc.start(RecordStartRequest(topics=["/tf"]))
    if mcap_topics is not None:
        _write_tiny_mcap(
            recorded_dir / run.run_id / f"{run.run_id}.mcap",
            mcap_topics,
            start_ns=1_000_000_000,
            step_ns=100_000_000,
        )
    if seed_quality is not None:
        store.create_batch(
            Batch(batch_id="b_seed", project="p", task="t", status="active")
        )
        store.create_episode(
            Episode(
                episode_id="ep_seed",
                batch_id="b_seed",
                run_id=run.run_id,
                index_in_batch=1,
                task_result="success",
                quality=seed_quality,
                quality_source=seed_source,
            )
        )
    await svc.stop()
    await svc.drain_settlements()
    await client.aclose()
    return store.get_episode_by_run_id(run.run_id)


def test_late_settlement_corrects_quick_check_sourced_episode(tmp_path: Path) -> None:
    """An episode saved with the conservative needs_review fallback (source
    quick_check) is corrected to the settled 'good' verdict; source stays."""
    store = RunStore(":memory:")
    try:
        fakes = _MonitorFakes(FakeRecorder())
        episode = asyncio.run(
            _drive_stop_with_episode(
                store,
                fakes,
                config=None,
                recorded_dir=tmp_path,
                mcap_topics={"/tf": 300},  # clean bag -> good verdict
                seed_quality="needs_review",
                seed_source="quick_check",
            )
        )
        assert episode is not None
        assert episode.quality == "good"
        assert episode.quality_source == "quick_check"
    finally:
        store.close()


def test_late_settlement_skips_operator_sourced_episode(tmp_path: Path) -> None:
    """An operator's quality call is never overwritten by the settled verdict,
    even when the verdict disagrees."""
    store = RunStore(":memory:")
    try:
        cfg = RecordingConfig(
            robot_name="t",
            expected_hz_patterns=[ExpectedHzPattern(pattern="/tf", hz=30.0)],
        )
        fakes = _MonitorFakes(FakeRecorder())
        episode = asyncio.run(
            _drive_stop_with_episode(
                store,
                fakes,
                config=cfg,
                recorded_dir=tmp_path,
                mcap_topics={"/tf": 30},  # ~10Hz -> needs_review verdict
                seed_quality="good",  # operator said good
                seed_source="operator",
            )
        )
        assert episode is not None
        # Operator call preserved despite the needs_review verdict.
        assert episode.quality == "good"
        assert episode.quality_source == "operator"
    finally:
        store.close()


def test_late_settlement_no_episode_is_noop(tmp_path: Path) -> None:
    """Settlement still persists the quick_check when the run has no episode."""
    store = RunStore(":memory:")
    try:
        fakes = _MonitorFakes(FakeRecorder())
        episode = asyncio.run(
            _drive_stop_with_episode(
                store,
                fakes,
                config=None,
                recorded_dir=tmp_path,
                mcap_topics={"/tf": 300},
                seed_quality=None,  # no episode seeded
                seed_source="quick_check",
            )
        )
        assert episode is None
        # The run itself still settled cleanly.
        run = next(iter(store.list_by_states([RunState.completed])), None)
        assert run is not None and run.quick_check is not None
        assert run.quick_check.verdict.quality == "good"
    finally:
        store.close()


# ---- run detail / list API surface (frontend reads quick_check here) ------


def test_run_detail_endpoint_serializes_quick_check(
    client: TestClient, store: RunStore
) -> None:
    """GET /api/v1/runs/{id} must include the persisted quick_check object.

    This is the exact surface the frontend reads in the 'quickcheck' phase, so
    assert the HTTP JSON (not just the store round-trip) carries the full shape.
    """
    run_id = "run_20260715_010000"
    store.create(Run(run_id=run_id, state=RunState.completed))
    qc = assemble_quick_check(
        layer0=QuickCheckLayer0(available=True, integrity="dropped"),
        layer1=build_layer1(
            summary=McapSummary(
                message_counts={"/tf": 100}, start_ns=0, end_ns=10_000_000_000
            ),
            config=None,
            required_topics=["/tf"],
        ),
        elapsed_ms=17,
    )
    store.update(run_id, quick_check=qc)

    body = client.get(f"/api/v1/runs/{run_id}").json()
    assert body["quick_check"] is not None
    assert body["quick_check"]["verdict"]["quality"] == "needs_review"
    assert body["quick_check"]["layer0"]["integrity"] == "dropped"
    assert body["quick_check"]["layer1"]["topics"]["/tf"]["message_count"] == 100
    assert body["quick_check"]["elapsed_ms"] == 17

    # And the list surface carries it too (base Run field).
    listed = client.get("/api/v1/runs").json()["items"]
    row = next(r for r in listed if r["run_id"] == run_id)
    assert row["quick_check"]["verdict"]["quality"] == "needs_review"


def test_run_detail_quick_check_null_when_unsettled(
    client: TestClient, store: RunStore
) -> None:
    """A run with no settled quick_check exposes it as null (not missing)."""
    run_id = "run_20260715_010001"
    store.create(Run(run_id=run_id, state=RunState.completed))
    body = client.get(f"/api/v1/runs/{run_id}").json()
    assert "quick_check" in body
    assert body["quick_check"] is None


# ---- episode quality derivation (D-2 seam extension) ----------------------


def _make_batch_and_run(client: TestClient, store: RunStore, run_id: str) -> str:
    store.create(Run(run_id=run_id, state=RunState.completed))
    batch = client.post(
        "/api/v1/batches", json={"project": "P", "task": "grasp"}
    ).json()
    return batch["batch_id"]


def _seed_quick_check(store: RunStore, run_id: str, quality: str) -> None:
    qc = QuickCheck(
        computed_at="2026-07-15T00:00:00.000Z",
        layer0=QuickCheckLayer0(available=True, integrity="ok"),
        layer1=QuickCheckLayer1(available=True, summary_available=True),
        verdict=QuickCheckVerdict(quality=quality, reasons=[]),
    )
    store.update(run_id, quick_check=qc)


def test_episode_quality_derives_from_quick_check(
    client: TestClient, store: RunStore
) -> None:
    """Omitting quality derives it from the run's quick_check verdict."""
    run_id = "run_20260715_000001"
    batch_id = _make_batch_and_run(client, store, run_id)
    _seed_quick_check(store, run_id, "needs_review")

    resp = client.post(
        "/api/v1/episodes",
        json={
            "batch_id": batch_id,
            "run_id": run_id,
            "index_in_batch": 0,
            "task_result": "success",
        },
    )
    assert resp.status_code == 201
    ep = resp.json()
    assert ep["quality"] == "needs_review"
    assert ep["quality_source"] == "quick_check"


def test_episode_explicit_quality_is_operator_override(
    client: TestClient, store: RunStore
) -> None:
    """An explicit quality is stored as-is (operator override), not derived."""
    run_id = "run_20260715_000002"
    batch_id = _make_batch_and_run(client, store, run_id)
    _seed_quick_check(store, run_id, "needs_review")  # would derive needs_review

    resp = client.post(
        "/api/v1/episodes",
        json={
            "batch_id": batch_id,
            "run_id": run_id,
            "index_in_batch": 0,
            "task_result": "success",
            "quality": "good",
        },
    )
    assert resp.status_code == 201
    ep = resp.json()
    assert ep["quality"] == "good"
    assert ep["quality_source"] == "operator"


def test_episode_quality_default_without_quick_check(
    client: TestClient, store: RunStore
) -> None:
    """With no quick_check to derive from, omitted quality falls back to
    needs_review (honest: an unsettled run is not vouched as good)."""
    run_id = "run_20260715_000003"
    batch_id = _make_batch_and_run(client, store, run_id)  # no quick_check seeded

    resp = client.post(
        "/api/v1/episodes",
        json={
            "batch_id": batch_id,
            "run_id": run_id,
            "index_in_batch": 0,
            "task_result": "success",
        },
    )
    assert resp.status_code == 201
    ep = resp.json()
    assert ep["quality"] == "needs_review"
    assert ep["quality_source"] == "quick_check"
