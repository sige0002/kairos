# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The plugin CLI boundary: job context, writable workspace and bounded lifetime."""

from __future__ import annotations

import asyncio
import json
import sys
import threading
from pathlib import Path

import pytest
import yaml
from dora_runner import bagflow_runtime, plugin_loader
from dora_runner.bagflow_runtime import DoraEndpoint, run_dora_flow
from dora_runner.models import JobCanceled
from dora_runner.plugin_loader import NodeContext
from dora_runner.store import JobRecord
from kairos_common.ids import new_capture_id


def _cli(tmp_path: Path, body: str, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "dora-test"
    path.write_text(f"#!{sys.executable}\n{body}")
    path.chmod(0o755)
    monkeypatch.setattr(bagflow_runtime, "DORA_BIN", str(path))


def test_plugin_cli_gets_a_writable_graph_with_job_context(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A daemon need not inherit the submitting CLI's per-job environment."""
    source = tmp_path / "plugin"
    source.mkdir()
    node = source / "greet.py"
    node.write_text("# installed plugin node\n")
    graph = source / "dataflow.yml"
    original = yaml.safe_dump(
        {"nodes": [{"id": "greet", "path": "greet.py", "env": {"CUSTOM": "keep"}}]}
    )
    graph.write_text(original)
    source.chmod(0o555)
    monkeypatch.setenv("KAIROS_DORA_CONTROL_PORT", "17112")
    _cli(
        tmp_path,
        """import json, sys
from pathlib import Path
import yaml
args = sys.argv[1:]
assert "--attach" in args
assert args[args.index("--coordinator-port") + 1] == "17112"
flow = Path(args[1])
assert flow.parent == Path.cwd()
Path("out").mkdir()
node = yaml.safe_load(flow.read_text())["nodes"][0]
assert Path(node["path"]).is_file() and Path(node["path"]).is_absolute()
env = node["env"]
assert env["CUSTOM"] == "keep"
assert Path(env["KAIROS_DATA_DIR"]).is_absolute()
summary = {
    "capture_id": env["KAIROS_CAPTURE_ID"],
    "params": json.loads(env["KAIROS_PARAMS_JSON"]),
}
(Path(env["KAIROS_REPORT_DIR"]) / "summary.json").write_text(json.dumps(summary))
""",
        monkeypatch,
    )
    capture_id = new_capture_id()
    try:
        for subject in ("first", "second"):
            report = tmp_path / subject
            report.mkdir()
            ctx = NodeContext(
                "hello_kairos", capture_id, tmp_path, {"subject": subject}, report
            )
            job = JobRecord(
                job_id=subject,
                capture_id=capture_id,
                pipeline=ctx.plugin_id,
                params=ctx.params,
            )
            asyncio.run(plugin_loader._run_via_dora_cli(graph, ctx, job))
            assert json.loads((report / "summary.json").read_text()) == {
                "capture_id": capture_id,
                "params": {"subject": subject},
            }
        assert graph.read_text() == original
        assert not (source / "out").exists()
    finally:
        source.chmod(0o755)


@pytest.mark.parametrize("cancel", [False, True])
def test_plugin_cli_timeout_and_cancel_clean_up_only_its_flow(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, cancel: bool
) -> None:
    _cli(tmp_path, "import time\ntime.sleep(120)\n", monkeypatch)
    monkeypatch.setattr(bagflow_runtime, "_SUBPROCESS_GRACE_S", 0)
    cleaned = []

    async def cleanup(name, endpoint):
        cleaned.append((name, endpoint))

    monkeypatch.setattr(bagflow_runtime, "cleanup_flow", cleanup)
    endpoint = DoraEndpoint(control_port=17112)
    event = threading.Event()

    async def exercise():
        task = asyncio.create_task(
            run_dora_flow(
                tmp_path / "dataflow.yml",
                name="only-this-job",
                endpoint=endpoint,
                timeout_s=5 if cancel else 0.05,
                cancel_event=event,
            )
        )
        if cancel:
            event.set()
            with pytest.raises(JobCanceled):
                await task
        else:
            result = await task
            assert result.timed_out and not result.ok

    asyncio.run(exercise())
    assert cleaned == [("only-this-job", endpoint)]
