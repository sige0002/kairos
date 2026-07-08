"""One-click validation presets (GET /api/v1/validation/presets).

Presets come from the active robot's ``validation_presets.yaml``; per request
the endpoint computes, for each preset's pipeline, how many completed recordings
still lack that pipeline's report (the "not yet validated" target set).
"""

from __future__ import annotations

from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.models import Run, RunState
from api_orchestrator.store import RunStore
from fastapi.testclient import TestClient
from kairos_common import Settings


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _build_config(root: Path) -> None:
    # A valid robot dir needs at least one aspect subdir; give it validation +
    # recording, plus the robot-level presets file.
    _write(
        root / "airoa/recording/default.yaml",
        "robot_name: airoa\ndefault_topics: [/a]\n",
    )
    _write(
        root / "airoa/validation/default.yaml",
        "name: airoa\nversion: 1\nrequired_topics:\n  - { name: /a }\n",
    )
    _write(
        root / "airoa/validation_presets.yaml",
        "presets:\n"
        "  - id: required_topics\n"
        "    name: Required topics\n"
        "    pipeline: fast_validation\n"
        "    params: { template: airoa }\n"
        "  - id: loss_scan\n"
        "    name: Loss scan\n"
        "    pipeline: loss_report\n"
        # A malformed entry (bad id) must be skipped, not fatal.
        "  - id: BAD ID\n"
        "    name: Broken\n"
        "    pipeline: fast_validation\n",
    )


def _client(tmp_path: Path, fake_recorder, store: RunStore) -> tuple[TestClient, Path]:
    config_root = tmp_path / "config"
    _build_config(config_root)
    data_dir = tmp_path / "data"
    settings = Settings(
        config_dir=str(config_root),
        config_local_dir=str(config_root / "local"),
        robot="airoa",
        recording_config=str(config_root / "airoa/recording/default.yaml"),
        stream_config="/nonexistent/stream.yaml",
        data_dir=str(data_dir),
        recorded_dir=str(data_dir / "recorded"),
    )
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_recorder.handler)
    )
    app = create_orchestrator_app(settings, store=store, http_client=http_client)
    return TestClient(app), data_dir


def _completed_run(store: RunStore, data_dir: Path, run_id: str) -> None:
    """Insert a completed run and materialize its recorded dir on disk."""
    store.create(Run(run_id=run_id, state=RunState.completed))
    (data_dir / "recorded" / run_id).mkdir(parents=True, exist_ok=True)
    (data_dir / "recorded" / run_id / f"{run_id}_0.mcap").write_bytes(b"")


def _write_report(data_dir: Path, pipeline: str, run_id: str) -> None:
    path = data_dir / "report" / pipeline / run_id / "summary.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"result": "pass"}', encoding="utf-8")


def test_presets_expose_pending_targets(tmp_path: Path, fake_recorder) -> None:
    store = RunStore(":memory:")
    client, data_dir = _client(tmp_path, fake_recorder, store)
    with client:
        # Two completed recordings; run_a already validated by fast_validation.
        _completed_run(store, data_dir, "run_a")
        _completed_run(store, data_dir, "run_b")
        _write_report(data_dir, "fast_validation", "run_a")

        body = client.get("/api/v1/validation/presets").json()
        presets = {p["id"]: p for p in body["items"]}

        # The malformed third entry is dropped; two valid presets remain.
        assert set(presets) == {"required_topics", "loss_scan"}

        fv = presets["required_topics"]
        assert fv["pipeline"] == "fast_validation"
        assert fv["params"] == {"template": "airoa"}
        assert fv["total"] == 2
        assert fv["pending"] == 1
        assert fv["pending_run_ids"] == ["run_b"]  # run_a has a report

        loss = presets["loss_scan"]
        assert loss["total"] == 2
        assert loss["pending"] == 2  # neither run has a loss_report yet
        assert set(loss["pending_run_ids"]) == {"run_a", "run_b"}
    store.close()


def test_presets_empty_without_file(tmp_path: Path, fake_recorder) -> None:
    store = RunStore(":memory:")
    config_root = tmp_path / "config"
    # A robot dir with an aspect but NO validation_presets.yaml.
    _write(
        config_root / "airoa/recording/default.yaml",
        "robot_name: airoa\ndefault_topics: [/a]\n",
    )
    settings = Settings(
        config_dir=str(config_root),
        config_local_dir=str(config_root / "local"),
        robot="airoa",
        recording_config="/nonexistent/recording.yaml",
        stream_config="/nonexistent/stream.yaml",
        data_dir=str(tmp_path / "data"),
        recorded_dir=str(tmp_path / "data" / "recorded"),
    )
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_recorder.handler)
    )
    app = create_orchestrator_app(settings, store=store, http_client=http_client)
    with TestClient(app) as client:
        body = client.get("/api/v1/validation/presets").json()
        assert body["items"] == []
    store.close()
