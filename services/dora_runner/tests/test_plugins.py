# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Plugin discovery + the bundled hello_dora example dataflow.

These run the in-process interpreter path (no dora daemon), which is what makes
the plugin testable on a CPU-only host. ``KAIROS_DORA_INPROCESS`` forces that
path even if a developer happens to have the ``dora`` CLI on PATH.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path

import pytest
from dora_runner.main import create_dora_app
from dora_runner.plugin_loader import (
    PluginManifest,
    discover_plugins,
)
from dora_runner.registry import PipelineRegistry, build_default_registry
from dora_runner.store import JobRecord, RunnerStore
from fastapi.testclient import TestClient
from kairos_common import Settings
from kairos_common.ids import new_capture_id
from pydantic import ValidationError

_MS = 1_000_000  # nanoseconds per millisecond

# The in-tree plugins dir: tests/ -> <service root>/plugins.
REAL_PLUGINS = Path(__file__).resolve().parents[1] / "plugins"


@pytest.fixture(autouse=True)
def _force_inprocess(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KAIROS_DORA_INPROCESS", "1")


def _write_minimal_mcap(path: Path, topics: dict[str, int]) -> None:
    """Write an MCAP with *topics* -> message count (10 Hz spacing, no payload)."""
    from mcap.writer import Writer

    path.parent.mkdir(parents=True, exist_ok=True)
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
                    channel_id=channel_id, log_time=ts, publish_time=ts, data=b""
                )
        writer.finish()


def _valid_manifest_dict() -> dict:
    return {
        "apiVersion": "kairos.plugin/v1",
        "id": "hello_dora",
        "name": "Hello dora",
        "executor": "dora",
        "entrypoint": {"dataflow": "dataflow.yml"},
    }


# ---- manifest validation ------------------------------------------------------


def test_manifest_accepts_valid() -> None:
    manifest = PluginManifest.model_validate(_valid_manifest_dict())
    assert manifest.id == "hello_dora"
    assert manifest.api_version == "kairos.plugin/v1"
    assert manifest.required_inputs == ["capture_id"]  # default


def test_manifest_rejects_bad_id() -> None:
    bad = _valid_manifest_dict() | {"id": "Bad-Id"}
    with pytest.raises(ValidationError):
        PluginManifest.model_validate(bad)


def test_manifest_rejects_unknown_key() -> None:
    bad = _valid_manifest_dict() | {"typpo": 1}
    with pytest.raises(ValidationError):
        PluginManifest.model_validate(bad)


# ---- discovery ----------------------------------------------------------------


def _make_plugin(dir_: Path, manifest_yaml: str, *, dataflow: bool = True) -> Path:
    plugin = dir_
    plugin.mkdir(parents=True, exist_ok=True)
    (plugin / "kairos_plugin.yaml").write_text(manifest_yaml, encoding="utf-8")
    if dataflow:
        (plugin / "dataflow.yml").write_text("nodes: []\n", encoding="utf-8")
    return plugin


def test_discover_isolates_a_broken_plugin(tmp_path: Path) -> None:
    plugins_dir = tmp_path / "plugins"
    # One healthy plugin...
    _make_plugin(
        plugins_dir / "good",
        "apiVersion: kairos.plugin/v1\n"
        "id: good_one\n"
        "name: Good\n"
        "entrypoint: {dataflow: dataflow.yml}\n",
    )
    # ...and one with an invalid id (must not take the healthy one down).
    _make_plugin(
        plugins_dir / "broken",
        "apiVersion: kairos.plugin/v1\nid: BROKEN\nname: Broken\n",
    )

    registry = PipelineRegistry()
    errors = discover_plugins(registry, plugins_dir)

    assert registry.get("good_one") is not None
    assert registry.runnable("good_one")
    assert len(errors) == 1
    assert "broken" in errors[0].source


def test_discover_rejects_duplicate_id(tmp_path: Path) -> None:
    plugins_dir = tmp_path / "plugins"
    _make_plugin(
        plugins_dir / "p",
        "apiVersion: kairos.plugin/v1\n"
        "id: clash\n"
        "name: P\n"
        "entrypoint: {dataflow: dataflow.yml}\n",
    )
    registry = PipelineRegistry()
    # Pre-register the same id; discovery must refuse to overwrite it.
    from dora_runner.registry import RegisteredPipeline

    registry.register(
        RegisteredPipeline(id="clash", name="builtin", description="", params_schema={})
    )
    errors = discover_plugins(registry, plugins_dir)
    assert registry.get("clash").name == "builtin"
    assert any("duplicate" in e.error for e in errors)


def test_discover_missing_dir_is_noop(tmp_path: Path) -> None:
    registry = PipelineRegistry()
    assert discover_plugins(registry, tmp_path / "nope") == []


# ---- bundled hello_dora plugin ------------------------------------------------


def test_hello_dora_is_registered_with_metadata() -> None:
    registry = build_default_registry(plugins_dir=REAL_PLUGINS)
    pipe = registry.get("hello_dora")
    assert pipe is not None
    assert pipe.enabled  # has a runner
    assert pipe.executor == "dora"
    assert "min_messages" in pipe.params_schema["properties"]
    assert pipe.outputs  # advertises an output contract


def test_hello_dora_runs_in_process(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_minimal_mcap(capture_dir / "run_x_0.mcap", {"/a": 3, "/b": 2})
    registry = build_default_registry(plugins_dir=REAL_PLUGINS)
    pipe = registry.get("hello_dora")
    assert pipe is not None and pipe.runner is not None

    job = JobRecord(
        job_id="j1",
        capture_id=capture_id,
        pipeline="hello_dora",
        params={"min_messages": 1},
    )
    result = asyncio.run(pipe.runner(job, RunnerStore(), data_dir))

    summary = result["summary"]
    assert summary["pipeline"] == "hello_dora"
    assert summary["result"] == "pass"
    metrics = summary["metrics"]
    assert metrics["message_count"] == 5
    assert metrics["topic_count"] == 2
    assert metrics["duration_s"] == pytest.approx(0.2)
    assert {t["name"]: t["count"] for t in metrics["topics"]} == {"/a": 3, "/b": 2}

    summary_path = data_dir / "report" / "hello_dora" / capture_id / "summary.json"
    assert summary_path.exists()
    assert json.loads(summary_path.read_text())["result"] == "pass"
    assert any(a.endswith("summary.json") for a in result["artifacts"])


def test_hello_dora_min_messages_threshold_can_fail(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_minimal_mcap(capture_dir / "run_y_0.mcap", {"/a": 2})
    registry = build_default_registry(plugins_dir=REAL_PLUGINS)
    pipe = registry.get("hello_dora")
    assert pipe is not None and pipe.runner is not None

    job = JobRecord(
        job_id="j2",
        capture_id=capture_id,
        pipeline="hello_dora",
        params={"min_messages": 100},
    )
    result = asyncio.run(pipe.runner(job, RunnerStore(), data_dir))
    assert result["summary"]["result"] == "fail"


def test_hello_dora_job_via_api(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, capture_dir = make_capture(data_dir)
    _write_minimal_mcap(capture_dir / "run_api_0.mcap", {"/hsrb/x": 4})
    # The service builds DEFAULT_REGISTRY at import from the in-tree plugins dir,
    # so hello_dora is already registered here.
    app = create_dora_app(Settings(data_dir=str(data_dir)))
    with TestClient(app) as client:
        items = client.get("/pipelines").json()["items"]
        assert any(p["id"] == "hello_dora" for p in items)

        created = client.post(
            "/jobs",
            json={
                "capture_id": capture_id,
                "pipeline": "hello_dora",
                "params": {},
            },
        )
        assert created.status_code == 201, created.text
        job_id = created.json()["job_id"]

        for _ in range(200):
            status = client.get(f"/jobs/{job_id}/status").json()
            if status["state"] in {"succeeded", "failed"}:
                break
        assert status["state"] == "succeeded", status

        body = client.get(f"/jobs/{job_id}/result").json()
        assert body["summary"]["metrics"]["message_count"] == 4


# ---- bundled hello_kairos template plugin -------------------------------------


def test_hello_kairos_is_registered_with_metadata() -> None:
    registry = build_default_registry(plugins_dir=REAL_PLUGINS)
    pipe = registry.get("hello_kairos")
    assert pipe is not None
    assert pipe.enabled  # has a runner
    assert pipe.executor == "dora"
    assert "subject" in pipe.params_schema["properties"]
    assert pipe.outputs  # advertises an output contract


def test_hello_kairos_greets_from_the_subject_param(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    # No MCAP is read — this template plugin ignores the recording and only
    # echoes its input param — but the capture still has to exist: a job names a
    # capture, and one that is not there cannot be reported on.
    data_dir = tmp_path / "data"
    capture_id, _ = make_capture(data_dir)
    registry = build_default_registry(plugins_dir=REAL_PLUGINS)
    pipe = registry.get("hello_kairos")
    assert pipe is not None and pipe.runner is not None

    job = JobRecord(
        job_id="j1",
        capture_id=capture_id,
        pipeline="hello_kairos",
        params={"subject": "kairos"},
    )
    result = asyncio.run(pipe.runner(job, RunnerStore(), data_dir))

    summary = result["summary"]
    assert summary["pipeline"] == "hello_kairos"
    assert summary["result"] == "pass"
    assert summary["message"] == "hello kairos!"
    assert summary["metrics"]["subject"] == "kairos"

    summary_path = data_dir / "report" / "hello_kairos" / capture_id / "summary.json"
    assert summary_path.exists()
    assert json.loads(summary_path.read_text())["message"] == "hello kairos!"


def test_hello_kairos_shout_and_default_subject(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    data_dir = tmp_path / "data"
    capture_id, _ = make_capture(data_dir)
    registry = build_default_registry(plugins_dir=REAL_PLUGINS)
    pipe = registry.get("hello_kairos")
    assert pipe is not None and pipe.runner is not None

    # Empty params -> default subject "kairos"; shout upper-cases the greeting.
    job = JobRecord(
        job_id="j2",
        capture_id=capture_id,
        pipeline="hello_kairos",
        params={"shout": True},
    )
    result = asyncio.run(pipe.runner(job, RunnerStore(), data_dir))
    assert result["summary"]["message"] == "HELLO KAIROS!"


def test_a_plugin_job_on_a_vanished_capture_leaves_no_report_debris(
    tmp_path: Path,
) -> None:
    """The capture is verified BEFORE the report directory is created.

    A capture can be deleted between the moment a job is submitted and the
    moment it runs. Creating ``report/<plugin>/<capture_id>/`` first left an
    empty directory that a later reader cannot tell apart from a pipeline that
    ran and produced nothing — so the check comes first and the job fails clean.
    """
    data_dir = tmp_path / "data"
    (data_dir / "objects").mkdir(parents=True)
    capture_id = new_capture_id()
    registry = build_default_registry(plugins_dir=REAL_PLUGINS)

    for plugin_id in ("hello_dora", "hello_kairos"):
        pipe = registry.get(plugin_id)
        assert pipe is not None and pipe.runner is not None
        job = JobRecord(
            job_id=f"j_{plugin_id}",
            capture_id=capture_id,
            pipeline=plugin_id,
            params={},
        )
        with pytest.raises(FileNotFoundError, match="No capture found"):
            asyncio.run(pipe.runner(job, RunnerStore(), data_dir))
        assert not (data_dir / "report" / plugin_id / capture_id).exists()
    # Nothing was created under report/ at all.
    assert not (data_dir / "report").exists()


def test_a_plugin_job_with_a_bad_capture_id_never_touches_the_report_tree(
    tmp_path: Path,
) -> None:
    """A non-UUIDv7 id is refused by the same gate, before any path is joined."""
    data_dir = tmp_path / "data"
    (data_dir / "objects").mkdir(parents=True)
    registry = build_default_registry(plugins_dir=REAL_PLUGINS)
    pipe = registry.get("hello_dora")
    assert pipe is not None and pipe.runner is not None

    job = JobRecord(
        job_id="j_bad", capture_id="../../etc", pipeline="hello_dora", params={}
    )
    with pytest.raises(ValueError, match="capture_id must be a UUIDv7"):
        asyncio.run(pipe.runner(job, RunnerStore(), data_dir))
    assert not (data_dir / "report").exists()
