"""loss_report pipeline tests.

``estimate_topic_loss`` is pure (operates on a list of message times), so the
loss methodology is fully unit-testable without an MCAP. The capture_id guard
is checked directly; the end-to-end MCAP path is gated on a real local sample
recording (skipped otherwise, like test_fast_validation).
The publish_time-vs-log_time clock selection (``mcap_utils.source_times``) is
covered both as a pure function and through a written MCAP.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path

import pytest
from dora_runner.loss_report import (
    estimate_topic_loss,
    gap_exceeded,
    run_loss_report,
)
from dora_runner.loss_report_config import (
    DEFAULT_GAP_THRESHOLD_MULTIPLIER,
    LossReportConfig,
    coerce_target_topics,
    load_loss_report_config,
)
from dora_runner.main import create_dora_app
from dora_runner.mcap_utils import source_times
from dora_runner.registry import build_default_registry, loss_report_schema
from fastapi.testclient import TestClient
from kairos_common import Settings
from kairos_common.ids import new_capture_id

_MS = 1_000_000  # nanoseconds per millisecond


def test_uniform_stream_has_near_zero_loss() -> None:
    # 100 messages at a clean 10 Hz (100 ms spacing) -> no missing samples.
    times = [i * 100 * _MS for i in range(100)]
    out = estimate_topic_loss(times)
    assert out["count"] == 100
    assert out["hz"] == pytest.approx(10.0, rel=0.01)
    assert out["median_interval_ms"] == pytest.approx(100.0, rel=0.01)
    assert out["loss_rate"] is not None and out["loss_rate"] < 0.05


def test_dropped_second_half_shows_clear_loss() -> None:
    # First half at the true 10 Hz cadence (100 ms); the second half is sparse
    # (every other message dropped -> 200 ms spacing). The median interval stays
    # 100 ms, so the missing samples surface as loss.
    first = [i * 100 * _MS for i in range(50)]
    base = first[-1]
    second = [base + (i + 1) * 200 * _MS for i in range(25)]
    out = estimate_topic_loss(first + second)
    assert out["median_interval_ms"] == pytest.approx(100.0, rel=0.05)
    assert out["loss_rate"] is not None and out["loss_rate"] > 0.1
    # The biggest gap reflects the sparse tail (~200 ms), not the dense head.
    assert out["gap_max_ms"] == pytest.approx(200.0, rel=0.05)


def test_too_few_samples_reports_reason() -> None:
    out = estimate_topic_loss([0, 100 * _MS])
    assert out["count"] == 2
    assert out["loss_rate"] is None
    assert out["hz"] is None
    assert out["reason"] == "insufficient samples"


@pytest.mark.parametrize(
    "bad", ["../../etc", "run_20260623_232808", "", "objects/../etc", "not-a-uuid"]
)
def test_loss_report_rejects_non_uuid7_capture_id(tmp_path: Path, bad: str) -> None:
    """Anything that is not a UUIDv7 is refused before any filesystem access.

    A run_id is included deliberately: it is a display name now (§1), and
    accepting one here is what would let ``report/loss_report/<run_id>/``
    reappear.
    """
    data_dir = tmp_path / "data"
    (data_dir / "objects").mkdir(parents=True)
    with pytest.raises(ValueError, match="capture_id must be a UUIDv7"):
        run_loss_report(capture_id=bad, data_dir=data_dir)


def test_loss_report_missing_capture_dir_raises(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    (data_dir / "objects").mkdir(parents=True)
    with pytest.raises(FileNotFoundError, match="No capture found"):
        run_loss_report(capture_id=new_capture_id(), data_dir=data_dir)


# ---- OL-4.3: config-driven thresholds / target topics ---------------------


def test_gap_exceeded_flag_uses_multiplier() -> None:
    # A topic whose worst gap is 10x its median is flagged at mult=5 but not 20.
    est = {"gap_max_ms": 1000.0, "median_interval_ms": 100.0}
    assert gap_exceeded(est, 5.0) is True
    assert gap_exceeded(est, 20.0) is False
    # Missing data is never flagged.
    assert gap_exceeded({"gap_max_ms": None, "median_interval_ms": None}, 1.0) is False


def test_coerce_target_topics_accepts_string_or_list() -> None:
    assert coerce_target_topics("/hsrb/*, /tf") == ["/hsrb/*", "/tf"]
    assert coerce_target_topics(["/a", " ", "/b"]) == ["/a", "/b"]
    assert coerce_target_topics(None) == []


def test_load_loss_report_config_from_yaml(tmp_path: Path) -> None:
    cfg_file = tmp_path / "loss_report.yaml"
    cfg_file.write_text(
        "gap_threshold_multiplier: 3.5\ntarget_topics: [/hsrb/*]\n",
        encoding="utf-8",
    )
    cfg = load_loss_report_config(cfg_file)
    assert cfg.gap_threshold_multiplier == 3.5
    assert cfg.target_topics == ["/hsrb/*"]


def test_load_loss_report_config_missing_file_uses_defaults(tmp_path: Path) -> None:
    cfg = load_loss_report_config(tmp_path / "nope.yaml")
    assert cfg.gap_threshold_multiplier == DEFAULT_GAP_THRESHOLD_MULTIPLIER
    assert cfg.target_topics == []


def test_loss_report_schema_embeds_config_defaults() -> None:
    cfg = LossReportConfig(gap_threshold_multiplier=2.0, target_topics=["/hsrb/*"])
    schema = loss_report_schema(cfg)
    props = schema["properties"]
    assert props["gap_threshold_multiplier"]["default"] == 2.0
    assert props["target_topics"]["default"] == ["/hsrb/*"]
    # Schema must forbid 0/negatives to match coerce_multiplier (no silent
    # substitution): exclusiveMinimum, not minimum.
    assert props["gap_threshold_multiplier"]["exclusiveMinimum"] == 0
    assert "minimum" not in props["gap_threshold_multiplier"]
    # The registry carries the same config-driven loss_report params_schema.
    loss = build_default_registry(cfg).get("loss_report")
    assert loss is not None
    loss_props = loss.params_schema["properties"]
    assert loss_props["gap_threshold_multiplier"]["default"] == 2.0
    assert loss_props["target_topics"]["default"] == ["/hsrb/*"]


def _write_minimal_mcap(path: Path, topics: dict[str, int]) -> None:
    """Write an MCAP with *topics* -> message count (10 Hz spacing, no payload)."""
    from mcap.writer import Writer

    with path.open("wb") as fh:
        writer = Writer(fh)
        writer.start()
        schema_id = writer.register_schema(
            name="std_msgs/msg/Empty", encoding="ros2msg", data=b""
        )
        for topic, count in topics.items():
            channel_id = writer.register_channel(
                topic=topic, message_encoding="cdr", schema_id=schema_id
            )
            for i in range(count):
                ts = i * 100 * _MS
                writer.add_message(
                    channel_id=channel_id,
                    log_time=ts,
                    publish_time=ts,
                    data=b"",
                )
        writer.finish()


def test_run_loss_report_filters_target_topics(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_minimal_mcap(
        capture_dir / "run_x_0.mcap", {"/hsrb/joint_states": 10, "/tf": 10}
    )

    # No filter -> both topics; glob filter -> only the matching one.
    full = run_loss_report(capture_id=capture_id, data_dir=data_dir)
    names_full = {t["name"] for t in full["summary"]["topics"]}
    assert names_full == {"/hsrb/joint_states", "/tf"}

    filtered = run_loss_report(
        capture_id=capture_id, data_dir=data_dir, target_topics=["/hsrb/*"]
    )
    names = {t["name"] for t in filtered["summary"]["topics"]}
    assert names == {"/hsrb/joint_states"}
    assert filtered["summary"]["params"]["target_topics"] == ["/hsrb/*"]
    # gap_exceeded is present on every reported topic (additive field).
    assert all("gap_exceeded" in t for t in filtered["summary"]["topics"])


def test_run_loss_report_stops_at_the_cancellation_checkpoint(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """A set cancel event stops the MCAP scan instead of running it out."""
    import threading

    from dora_runner.models import JobCanceled

    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_minimal_mcap(capture_dir / "run_x_0.mcap", {"/hsrb/joint_states": 10})

    cancel = threading.Event()
    cancel.set()
    with pytest.raises(JobCanceled):
        run_loss_report(capture_id=capture_id, data_dir=data_dir, cancel=cancel)


def _write_mcap_with_times(
    path: Path, topic: str, pairs: list[tuple[int, int]]
) -> None:
    """Write an MCAP whose messages carry explicit (log_time, publish_time)."""
    from mcap.writer import Writer

    with path.open("wb") as fh:
        writer = Writer(fh)
        writer.start()
        schema_id = writer.register_schema(
            name="std_msgs/msg/Empty", encoding="ros2msg", data=b""
        )
        channel_id = writer.register_channel(
            topic=topic, message_encoding="cdr", schema_id=schema_id
        )
        for log_time, publish_time in pairs:
            writer.add_message(
                channel_id=channel_id,
                log_time=log_time,
                publish_time=publish_time,
                data=b"",
            )
        writer.finish()


# ---- publish_time preference (source-side clock, mcap_utils.source_times) --


def test_source_times_prefers_recorded_publish_time() -> None:
    # Distinct publish_time (Jazzy recorder) -> the sender-side series is used.
    pairs = [(100, 90), (200, 190), (300, 290)]
    assert source_times(pairs) == ([90, 190, 290], "publish_time")


def test_source_times_falls_back_when_not_recorded_or_zeroed() -> None:
    # Older writers stamp publish_time == log_time on every message: the field
    # carries no information -> receive-side log_time, said out loud.
    assert source_times([(100, 100), (200, 200)]) == ([100, 200], "log_time")
    # Any publish_time == 0 (MCAP's "unknown") would corrupt interval math ->
    # whole-topic fallback, even though another message has a real value.
    assert source_times([(100, 90), (200, 0)]) == ([100, 200], "log_time")
    assert source_times([]) == ([], "log_time")


def test_source_times_rejects_log_source_mix() -> None:
    """If even ONE message has publish_time == log_time, the series is a
    log/source mix (a writer that filled the receive time where no source stamp
    was available) — untrustworthy, so fall back wholesale to log_time."""
    # Message 2 has publish_time == log_time.
    pairs = [(100 * _MS, 90 * _MS), (200 * _MS, 200 * _MS), (300 * _MS, 290 * _MS)]
    times, source = source_times(pairs)
    assert source == "log_time"
    assert times == [100 * _MS, 200 * _MS, 300 * _MS]


def test_source_times_rejects_offset_clock_span() -> None:
    """Two interleaved publishers with a ~30 s clock offset on one topic pass
    the per-message tests (all non-zero, all differ) but inflate the publish
    span far beyond the receive window — a span mismatch falls back to the
    single recorder clock instead of fabricating a huge gap."""
    pairs = [
        (100 * _MS, 100 * _MS + 1),
        (200 * _MS, 200 * _MS + 30_000 * _MS),
        (300 * _MS, 300 * _MS + 1),
    ]
    _times, source = source_times(pairs)
    assert source == "log_time"


def test_run_loss_report_uses_publish_time_when_recorded(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """Receive-side smoothing must not hide a source-side gap: log_times are
    perfectly regular (the recorder drained a burst evenly) while publish_times
    carry one ~500 ms hole — the report must surface the hole and say which
    clock it used."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    pairs = []
    for i in range(30):
        log = i * 100 * _MS + 3 * _MS  # clean 100 ms receive cadence
        pub = i * 100 * _MS + (400 * _MS if i >= 15 else 0)  # one 500 ms hole
        pairs.append((log, pub))
    # publish_time of message 0 must be non-zero for the series to qualify.
    pairs[0] = (pairs[0][0], 1)
    _write_mcap_with_times(capture_dir / "run_pub_0.mcap", "/hsrb/joint_states", pairs)

    out = run_loss_report(capture_id=capture_id, data_dir=data_dir)
    (topic,) = out["summary"]["topics"]
    assert topic["time_source"] == "publish_time"
    # The 500 ms source-side hole is visible; on log_time it would be ~100 ms.
    assert topic["gap_max_ms"] == pytest.approx(500.0, rel=0.05)
    assert topic["loss_rate"] is not None and topic["loss_rate"] > 0.05


def test_run_loss_report_survives_offset_publisher_clocks(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """Regression: switching to publish_time must never be WORSE than log_time.
    Two publishers with a 30 s clock offset feed one topic; log_time is the
    single clean recorder clock. The report must fall back to log_time and NOT
    fabricate the ~90%+ loss / 30 s gap that trusting the split publish clock
    would produce."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    pairs = []
    for i in range(20):
        log = i * 100 * _MS  # clean 100 ms receive cadence, one clock
        pub = i * 100 * _MS + (30_000 * _MS if i % 2 else 1)  # two offset clocks
        pairs.append((log, pub))
    _write_mcap_with_times(
        capture_dir / "run_offset_0.mcap", "/hsrb/joint_states", pairs
    )

    out = run_loss_report(capture_id=capture_id, data_dir=data_dir)
    (topic,) = out["summary"]["topics"]
    assert topic["time_source"] == "log_time"
    # On the clean recorder clock the cadence is regular -> low loss, small gap.
    assert topic["loss_rate"] is not None and topic["loss_rate"] < 0.1
    assert topic["gap_max_ms"] == pytest.approx(100.0, rel=0.05)


def test_run_loss_report_falls_back_to_log_time_for_legacy_bags(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """A bag whose writer stamped publish_time == log_time (pre-Jazzy) is
    analysed on log_time, with the fallback stated per topic."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_minimal_mcap(capture_dir / "run_legacy_0.mcap", {"/hsrb/joint_states": 10})

    out = run_loss_report(capture_id=capture_id, data_dir=data_dir)
    assert all(t["time_source"] == "log_time" for t in out["summary"]["topics"])


def test_run_loss_report_writes_under_capture_id(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """§2: the report lands at report/loss_report/<capture_id>/summary.json."""
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_minimal_mcap(capture_dir / "run_x_0.mcap", {"/hsrb/joint_states": 10})

    out = run_loss_report(capture_id=capture_id, data_dir=data_dir)
    summary_path = data_dir / "report" / "loss_report" / capture_id / "summary.json"
    assert summary_path.is_file()
    assert out["artifacts"] == [str(summary_path)]
    assert out["summary"]["capture_id"] == capture_id
    assert "run_id" not in out["summary"]


def test_pipelines_endpoint_exposes_loss_report_params() -> None:
    app = create_dora_app(Settings(data_dir="/tmp"))
    with TestClient(app) as client:
        items = client.get("/pipelines").json()["items"]
        loss = next(p for p in items if p["id"] == "loss_report")
        # Serialized under the `schema` alias with the new params present.
        assert "target_topics" in loss["schema"]["properties"]
        assert "gap_threshold_multiplier" in loss["schema"]["properties"]


# ---- Integration (real sample bag, skipped when absent) -------------------

DATA_DIR = Path(__file__).resolve().parents[3] / "data"


def test_loss_report_job_writes_summary_json(
    sample_capture: tuple[str, Path] | None,
) -> None:
    if sample_capture is None:
        pytest.skip("needs a local sample recording under data/objects/")
    capture_id, _ = sample_capture
    app = create_dora_app(Settings(data_dir=str(DATA_DIR)))
    with TestClient(app) as client:
        created = client.post(
            "/jobs",
            json={
                "capture_id": capture_id,
                "pipeline": "loss_report",
                "params": {},
            },
        )
        assert created.status_code == 201
        job_id = created.json()["job_id"]

        status: dict = {}
        for _ in range(100):
            status = client.get(f"/jobs/{job_id}/status").json()
            if status["state"] in {"succeeded", "failed"}:
                break
            time.sleep(0.05)
        assert status["state"] == "succeeded"

        body = client.get(f"/jobs/{job_id}/result").json()
        summary_path = Path(body["artifacts"][0])
        assert summary_path.exists()
        topics = body["summary"]["topics"]
        assert topics and all("loss_rate" in t for t in topics)
