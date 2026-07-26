"""fast_validation pipeline tests using a real sample MCAP.

These are integration tests against a local recording under ``data/`` (which is
gitignored — see CLAUDE.md). They are skipped automatically when that recording
is not present (fresh clone / after cleaning ``data/``); record the sample bag
first to exercise them (see the integration recipes in CLAUDE.md).
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from dora_runner.bagflow_runtime import bagflow_available
from dora_runner.main import create_dora_app
from dora_runner.validation import generate_template
from fastapi.testclient import TestClient
from kairos_common import Settings

DATA_DIR = Path(__file__).resolve().parents[3] / "data"
RUN_ID = "run_20260623_232808"

# fast_validation now runs on dora, so this needs both the sample recording AND
# the bundled bagflow/dora binaries (the dora_runner image; see bagflow/VENDOR.md).
pytestmark = [
    pytest.mark.skipif(
        not (DATA_DIR / "recorded" / RUN_ID).is_dir(),
        reason=f"needs a local sample recording at data/recorded/{RUN_ID}",
    ),
    pytest.mark.skipif(
        not bagflow_available(),
        reason="needs the bagflow + dora binaries (dora_runner image)",
    ),
]


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
