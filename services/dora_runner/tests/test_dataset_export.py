"""dataset_export pipeline tests (hermetic — no real MCAP decoding needed).

Export only reads session.json and MOVES files, so a synthetic recorded run in
a tmp data_dir fully exercises it.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from dora_runner.dataset_export import _sanitize_component, run_dataset_export
from dora_runner.main import create_dora_app
from fastapi.testclient import TestClient
from kairos_common import Settings


def _make_run(data_dir: Path, run_id: str, *, operator: str, task: str) -> Path:
    run_dir = data_dir / "recorded" / run_id
    run_dir.mkdir(parents=True)
    (run_dir / f"{run_id}_0.mcap").write_bytes(b"\x89MCAP0\r\n" + b"x" * 32)
    (run_dir / "metadata.yaml").write_text("rosbag2: {}\n", encoding="utf-8")
    (run_dir / "session.json").write_text(
        json.dumps(
            {"run_id": run_id, "operator": operator, "task": task, "message_count": 7}
        ),
        encoding="utf-8",
    )
    return run_dir


def test_export_moves_run_into_operator_task_index(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    _make_run(data_dir, "run_a", operator="yuki", task="pick-place")
    # Recorder siblings beside the run dir should be cleaned up by the move.
    (data_dir / "recorded" / "run_a.qos.yaml").write_text("qos: {}\n", encoding="utf-8")

    out = run_dataset_export(run_id="run_a", data_dir=data_dir)

    dataset_dir = Path(out["summary"]["dataset_dir"])
    assert dataset_dir == data_dir / "yuki" / "pick-place" / "001"
    # Files moved into NNN.
    assert (dataset_dir / "run_a_0.mcap").exists()
    assert (dataset_dir / "session.json").exists()
    assert (dataset_dir / "metadata.yaml").exists()
    assert (dataset_dir / "dataset.json").exists()
    assert out["summary"]["index"] == "001"
    assert out["summary"]["message_count"] == 7
    # The recording has LEFT the staging area: run dir + siblings are gone.
    assert not (data_dir / "recorded" / "run_a").exists()
    assert not (data_dir / "recorded" / "run_a.qos.yaml").exists()
    # Report sidecar so the orchestrator can surface dataset_stats.
    report = data_dir / "report" / "dataset_export" / "run_a" / "summary.json"
    assert report.exists()


def test_export_allocates_incrementing_indexes(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    _make_run(data_dir, "run_a", operator="yuki", task="pick")
    _make_run(data_dir, "run_b", operator="yuki", task="pick")

    first = run_dataset_export(run_id="run_a", data_dir=data_dir)
    second = run_dataset_export(run_id="run_b", data_dir=data_dir)

    assert first["summary"]["index"] == "001"
    assert second["summary"]["index"] == "002"
    assert (data_dir / "yuki" / "pick" / "002" / "run_b_0.mcap").exists()
    # Both source runs have been moved out of recorded/.
    assert not (data_dir / "recorded" / "run_a").exists()
    assert not (data_dir / "recorded" / "run_b").exists()


def test_export_defaults_and_sanitizes_unsafe_metadata(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    # Blank operator -> default; task with separators/traversal -> sanitized slug.
    _make_run(data_dir, "run_a", operator="  ", task="../etc/passwd")

    out = run_dataset_export(run_id="run_a", data_dir=data_dir)

    dataset_dir = Path(out["summary"]["dataset_dir"])
    assert out["summary"]["operator"] == "unknown_operator"
    # No traversal escapes data_dir; the slug is a single component.
    assert dataset_dir.parent.parent == data_dir / "unknown_operator"
    assert dataset_dir.parent.name not in {"..", "etc"}
    assert data_dir in dataset_dir.parents


def test_sanitize_component_rules() -> None:
    assert _sanitize_component("a/b c", "d") == "a_b_c"
    assert _sanitize_component("", "fallback") == "fallback"
    assert _sanitize_component("..", "fallback") == "fallback"
    assert _sanitize_component("recorded", "d") == "recorded_"  # reserved


def test_export_rejects_traversal_run_id(tmp_path: Path) -> None:
    """A path-traversal run_id must be refused before any filesystem access."""
    import pytest

    data_dir = tmp_path / "data"
    (data_dir / "recorded").mkdir(parents=True)
    with pytest.raises(ValueError, match="invalid run_id"):
        run_dataset_export(run_id="../../etc", data_dir=data_dir)


def test_dataset_export_job_end_to_end(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    _make_run(data_dir, "run_a", operator="yuki", task="pick")
    app = create_dora_app(Settings(data_dir=str(data_dir)))
    with TestClient(app) as client:
        # The pipeline is advertised as enabled now.
        pipelines = client.get("/pipelines").json()["items"]
        export = next(p for p in pipelines if p["id"] == "dataset_export")
        assert export["enabled"] is True

        created = client.post(
            "/jobs",
            json={"run_id": "run_a", "pipeline": "dataset_export", "params": {}},
        )
        assert created.status_code == 201
        job_id = created.json()["job_id"]

        status: dict = {}
        for _ in range(50):
            status = client.get(f"/jobs/{job_id}/status").json()
            if status["state"] in {"succeeded", "failed"}:
                break
            time.sleep(0.05)
        assert status["state"] == "succeeded"

        result = client.get(f"/jobs/{job_id}/result").json()
        assert result["summary"]["index"] == "001"
        # MOVED into NNN, and gone from recorded/.
        assert (data_dir / "yuki" / "pick" / "001" / "run_a_0.mcap").exists()
        assert not (data_dir / "recorded" / "run_a").exists()
