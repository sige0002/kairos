# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""fast_validation pipeline tests using a real sample MCAP.

These are integration tests against a local recording under ``data/objects/``
(which is gitignored — see CLAUDE.md). They are skipped automatically when no
such recording is present (fresh clone / after cleaning ``data/``); record the
sample bag first to exercise them (see the integration recipes in CLAUDE.md).

The capture is discovered rather than named: under v2 a recording lives at
``objects/<capture_id>`` with a minted UUIDv7, so there is no fixed id a test
could hard-code. The ``sample_capture`` fixture picks the first capture that
actually holds an MCAP.
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

# fast_validation runs on dora, so this needs the bundled bagflow/dora binaries
# (the dora_runner image; see bagflow/VENDOR.md). The sample recording is checked
# per test through the fixture, which reports the reason when it is absent.
pytestmark = pytest.mark.skipif(
    not bagflow_available(),
    reason="needs the bagflow + dora binaries (dora_runner image)",
)


def _require_sample(sample_capture: tuple[str, Path] | None) -> str:
    if sample_capture is None:
        pytest.skip("needs a local sample recording under data/objects/")
    return sample_capture[0]


def test_generate_template_reads_real_mcap(
    sample_capture: tuple[str, Path] | None,
) -> None:
    capture_id = _require_sample(sample_capture)
    template = generate_template(capture_id, DATA_DIR)
    names = {topic.name for topic in template.required_topics}
    # Robot-agnostic on purpose: the fixture picks whatever capture exists under
    # objects/, so pinning a specific robot's topic would fail (not skip) on any
    # other robot's sample. The template must simply reflect the bag's topics.
    assert names


def test_fast_validation_job_writes_summary_json(
    sample_capture: tuple[str, Path] | None,
) -> None:
    capture_id = _require_sample(sample_capture)
    app = create_dora_app(Settings(data_dir=str(DATA_DIR)))
    with TestClient(app) as client:
        draft = client.post(
            "/validation/templates/generate", json={"capture_id": capture_id}
        ).json()
        created = client.post(
            "/jobs",
            json={
                "capture_id": capture_id,
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
        # §2: the verdict lands under the capture, not a run_id.
        assert summary_path.parent.name == capture_id
