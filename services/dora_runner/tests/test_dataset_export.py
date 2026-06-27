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
            {
                "run_id": run_id,
                "operator": operator,
                "task": task,
                "message_count": 7,
                "topics": ["/hsrb/joint_states", "/hsrb/odom"],
            }
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
    # Provenance: dataset.json carries the recorded topics (self-contained, not
    # only in the sibling session.json).
    assert out["summary"]["topics"] == ["/hsrb/joint_states", "/hsrb/odom"]
    written = json.loads((dataset_dir / "dataset.json").read_text())
    assert written["topics"] == ["/hsrb/joint_states", "/hsrb/odom"]
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


def test_sanitize_component_keeps_unicode_but_stays_safe() -> None:
    # Non-ASCII (e.g. Japanese) operator/task survive as a single component
    # instead of being flattened to the fallback (regression for O-03).
    assert _sanitize_component("田中テスト", "unknown_operator") == "田中テスト"
    assert _sanitize_component("ピッキング作業", "unknown_task") == "ピッキング作業"
    # ...but path-dangerous input still cannot escape: separators/traversal/abs
    # paths collapse to a single safe component (no "/", no "..").
    assert _sanitize_component("../evil", "d") == "evil"
    assert _sanitize_component("a/b/c", "d") == "a_b_c"
    assert _sanitize_component("/etc/passwd", "d") == "etc_passwd"
    assert "/" not in _sanitize_component("../../x", "d")
    # Emoji (a symbol, not a word char) is still stripped to a safe slug.
    assert _sanitize_component("🤖robot", "d") == "robot"


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
