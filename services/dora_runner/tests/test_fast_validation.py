"""fast_validation pipeline tests using a real sample MCAP."""

from __future__ import annotations

import time
from pathlib import Path

from dora_runner.main import create_dora_app
from dora_runner.validation import generate_template
from fastapi.testclient import TestClient
from kairos_common import Settings

DATA_DIR = Path(__file__).resolve().parents[3] / "data"
RUN_ID = "run_20260623_232808"


def test_generate_template_reads_real_mcap() -> None:
    template = generate_template(RUN_ID, DATA_DIR)
    names = {topic.name for topic in template.required_topics}
    assert "/hsrb/joint_states" in names


def test_fast_validation_job_writes_summary_json() -> None:
    app = create_dora_app(Settings(data_dir=str(DATA_DIR)))
    with TestClient(app) as client:
        draft = client.post(
            "/validation/templates/generate", json={"run_id": RUN_ID}
        ).json()
        created = client.post(
            "/jobs",
            json={
                "run_id": RUN_ID,
                "pipeline": "fast_validation",
                "params": {"template": draft},
            },
        )
        assert created.status_code == 201
        job_id = created.json()["job_id"]

        status = {}
        for _ in range(50):
            status = client.get(f"/jobs/{job_id}/status").json()
            if status["state"] == "succeeded":
                break
            time.sleep(0.05)

        assert status["state"] == "succeeded"
        result = client.get(f"/jobs/{job_id}/result")
        assert result.status_code == 200
        body = result.json()
        summary_path = Path(body["artifacts"][0])
        assert summary_path.exists()
        assert body["summary"]["result"] == "pass"
