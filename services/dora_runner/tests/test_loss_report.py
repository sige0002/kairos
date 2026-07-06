"""loss_report pipeline tests.

``estimate_topic_loss`` is pure (operates on a list of log_times), so the loss
methodology is fully unit-testable without an MCAP. The job-level traversal
guard is checked directly; the end-to-end MCAP path is gated on a real local
sample recording (skipped otherwise, like test_fast_validation).
"""

from __future__ import annotations

import time
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
from dora_runner.registry import build_default_registry, loss_report_schema
from fastapi.testclient import TestClient
from kairos_common import Settings

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


def test_loss_report_rejects_traversal_run_id(tmp_path: Path) -> None:
    """A path-traversal run_id must be refused before any filesystem access."""
    data_dir = tmp_path / "data"
    (data_dir / "recorded").mkdir(parents=True)
    with pytest.raises(ValueError, match="invalid run_id"):
        run_loss_report(run_id="../../etc", data_dir=data_dir)


def test_loss_report_missing_run_dir_raises(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    (data_dir / "recorded").mkdir(parents=True)
    with pytest.raises(FileNotFoundError):
        run_loss_report(run_id="run_absent", data_dir=data_dir)


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


def test_run_loss_report_filters_target_topics(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    run_dir = data_dir / "recorded" / "run_x"
    run_dir.mkdir(parents=True)
    _write_minimal_mcap(run_dir / "run_x_0.mcap", {"/hsrb/joint_states": 10, "/tf": 10})

    # No filter -> both topics; glob filter -> only the matching one.
    full = run_loss_report(run_id="run_x", data_dir=data_dir)
    names_full = {t["name"] for t in full["summary"]["topics"]}
    assert names_full == {"/hsrb/joint_states", "/tf"}

    filtered = run_loss_report(
        run_id="run_x", data_dir=data_dir, target_topics=["/hsrb/*"]
    )
    names = {t["name"] for t in filtered["summary"]["topics"]}
    assert names == {"/hsrb/joint_states"}
    assert filtered["summary"]["params"]["target_topics"] == ["/hsrb/*"]
    # gap_exceeded is present on every reported topic (additive field).
    assert all("gap_exceeded" in t for t in filtered["summary"]["topics"])


def test_run_loss_report_reads_exported_dataset_dir(tmp_path: Path) -> None:
    """After dataset_export MOVED the recording, dataset_dir points the report
    at data/<operator>/<task>/<NNN>; the summary stays keyed by run_id."""
    data_dir = tmp_path / "data"
    dataset = data_dir / "yuki" / "pick-place" / "001"
    dataset.mkdir(parents=True)
    _write_minimal_mcap(dataset / "run_x_0.mcap", {"/hsrb/joint_states": 10})

    out = run_loss_report(
        run_id="run_x", data_dir=data_dir, dataset_dir="yuki/pick-place/001"
    )
    names = {t["name"] for t in out["summary"]["topics"]}
    assert names == {"/hsrb/joint_states"}
    assert (data_dir / "report" / "loss_report" / "run_x" / "summary.json").exists()


def test_loss_report_rejects_unsafe_dataset_dir(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    (data_dir / "recorded").mkdir(parents=True)
    for bad in ("../x/y", "a/b", "a/b/c/d", "a//b", "recorded/a/b", "/abs/a/b"):
        with pytest.raises(ValueError, match="invalid dataset_dir"):
            run_loss_report(run_id="run_x", data_dir=data_dir, dataset_dir=bad)


def test_loss_report_missing_dataset_dir_raises(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    (data_dir / "recorded").mkdir(parents=True)
    with pytest.raises(FileNotFoundError, match="No dataset directory"):
        run_loss_report(run_id="run_x", data_dir=data_dir, dataset_dir="a/b/001")


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
RUN_ID = "run_20260623_232808"


@pytest.mark.skipif(
    not (DATA_DIR / "recorded" / RUN_ID).is_dir(),
    reason=f"needs a local sample recording at data/recorded/{RUN_ID}",
)
def test_loss_report_job_writes_summary_json() -> None:
    app = create_dora_app(Settings(data_dir=str(DATA_DIR)))
    with TestClient(app) as client:
        created = client.post(
            "/jobs",
            json={"run_id": RUN_ID, "pipeline": "loss_report", "params": {}},
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
