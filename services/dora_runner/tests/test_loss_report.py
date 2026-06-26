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
from dora_runner.loss_report import estimate_topic_loss, run_loss_report
from dora_runner.main import create_dora_app
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
