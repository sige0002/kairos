# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Plugin discovery + a generic dataflow runner (see docs/specs/ja/dora_plugins.md).

A plugin is a directory under ``KAIROS_PLUGINS_DIR`` (default
``services/dora_runner/plugins``) holding a ``kairos_plugin.yaml`` manifest, a
dora ``dataflow.yml``, and ``nodes/`` modules. At startup ``discover_plugins()``
scans the manifests and registers each as a ``RegisteredPipeline`` — so adding a
pipeline is *dropping in a folder*, with no core edit and no UI change (the
frontend renders the form from the manifest's ``params_schema``).

Execution is the same dataflow either way:

* If the ``dora`` CLI/daemon is installed, the runner shells out to
  ``dora start dataflow.yml`` (the canonical path in the spec).
* Otherwise it runs a tiny in-process interpreter over the *same* ``dataflow.yml``
  — topologically ordering the nodes and calling each node's pure ``process()``.
  This is what lets the example run (and be unit-tested) on a CPU-only host
  without the Rust ``dora`` binary. Each node module is dual-mode: a pure
  ``process(inputs, ctx)`` for in-process use and a ``main()`` dora event loop for
  ``dora start`` — the "node contract -> registry -> dora-ready" idea.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import yaml
from kairos_common import ApiError
from pydantic import BaseModel, ConfigDict, Field

from dora_runner.mcap_utils import resolve_source_dir
from dora_runner.store import JobRecord, RunnerStore

if TYPE_CHECKING:
    from dora_runner.registry import PipelineRegistry, Runner

logger = logging.getLogger(__name__)

# Only the v1 manifest contract is understood; a newer major is skipped (not run).
PLUGIN_API_MAJOR = "kairos.plugin/v1"

# Escape hatch for tests / hosts that have the `dora` CLI but no running daemon:
# force the in-process interpreter regardless of `which("dora")`.
_FORCE_INPROCESS_ENV = "KAIROS_DORA_INPROCESS"


def default_plugins_dir() -> Path:
    """Resolve the plugins directory: ``KAIROS_PLUGINS_DIR`` or the in-tree dir.

    In Docker the package is installed outside the source tree, so the image
    sets ``KAIROS_PLUGINS_DIR=/app/plugins`` (see the Dockerfile). For local /
    editable runs the source-relative default points at
    ``services/dora_runner/plugins``.
    """
    env = os.environ.get("KAIROS_PLUGINS_DIR")
    if env:
        return Path(env)
    # plugin_loader.py -> dora_runner -> src -> <service root>/plugins
    return Path(__file__).resolve().parents[2] / "plugins"


class PluginManifest(BaseModel):
    """Validated ``kairos_plugin.yaml``. Unknown keys are rejected (typo guard)."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    api_version: str = Field(alias="apiVersion")
    id: str = Field(pattern=r"^[a-z0-9_]+$")
    name: str
    description: str = ""
    executor: str = "dora"
    version: str = "0.0.0"
    required_inputs: list[str] = Field(default_factory=lambda: ["capture_id"])
    params_schema: dict[str, Any] = Field(default_factory=dict)
    outputs: list[str] = Field(default_factory=list)
    # entrypoint.dataflow (relative path) for executor=dora; entrypoint.callable
    # ("module:function") for a pure-python in_process plugin.
    entrypoint: dict[str, str] = Field(default_factory=dict)
    requires: dict[str, Any] = Field(default_factory=dict)


@dataclass(frozen=True)
class PluginLoadError:
    """A plugin that failed to load — surfaced in logs (and optionally the API)."""

    source: str
    error: str


@dataclass(frozen=True)
class NodeContext:
    """The KAIROS_* job context handed to each in-process node (env equivalent)."""

    plugin_id: str
    capture_id: str
    data_dir: Path
    params: dict[str, Any]
    report_dir: Path


def discover_plugins(
    registry: PipelineRegistry, plugins_dir: Path
) -> list[PluginLoadError]:
    """Scan ``plugins_dir/*/kairos_plugin.yaml`` and register each plugin.

    Failure-isolated: a single broken plugin is skipped with a warning; healthy
    plugins and the bundled pipelines keep working. A plugin whose ``id`` clashes
    with an already-registered pipeline is rejected (first registration wins).
    """
    # Deferred: registry imports this module at its own import time (in
    # build_default_registry), so a module-level import here would be
    # circular. RegisteredPipeline is defined before registry calls back in,
    # so this always resolves.
    from dora_runner.registry import RegisteredPipeline

    errors: list[PluginLoadError] = []
    if not plugins_dir.is_dir():
        return errors
    for manifest_path in sorted(plugins_dir.glob("*/kairos_plugin.yaml")):
        try:
            manifest = _load_manifest(manifest_path)
            if registry.get(manifest.id) is not None:
                raise ValueError(f"duplicate pipeline id: {manifest.id}")
            runner = _build_runner(manifest, manifest_path.parent)
            registry.register(
                RegisteredPipeline(
                    id=manifest.id,
                    name=manifest.name,
                    description=manifest.description,
                    params_schema=manifest.params_schema,
                    required_inputs=manifest.required_inputs,
                    outputs=manifest.outputs,
                    executor=manifest.executor,
                    runner=runner,
                )
            )
            logger.info("loaded plugin '%s' from %s", manifest.id, manifest_path.parent)
        except Exception as exc:  # noqa: BLE001 - one bad plugin must not crash boot.
            errors.append(PluginLoadError(str(manifest_path), str(exc)))
            logger.warning("plugin load failed: %s (%s)", manifest_path, exc)
    return errors


def _load_manifest(manifest_path: Path) -> PluginManifest:
    data = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
    manifest = PluginManifest.model_validate(data)
    if manifest.api_version != PLUGIN_API_MAJOR:
        raise ValueError(
            f"unsupported apiVersion {manifest.api_version!r} "
            f"(this runner understands {PLUGIN_API_MAJOR})"
        )
    return manifest


def _build_runner(manifest: PluginManifest, plugin_dir: Path) -> Runner:
    """Pick a runner from the manifest entrypoint (dataflow or pure callable)."""
    if manifest.entrypoint.get("dataflow"):
        return _make_dataflow_runner(manifest, plugin_dir)
    if manifest.entrypoint.get("callable"):
        return _make_callable_runner(manifest, plugin_dir)
    raise ValueError("entrypoint must set 'dataflow' or 'callable'")


# ---- dataflow runner (dora CLI when present, else in-process interpreter) ------


def _prepare_report_dir(
    manifest: PluginManifest, job: JobRecord, data_dir: Path
) -> Path:
    """Verify the capture is really there, THEN create the report directory.

    The order is the whole point. ``resolve_source_dir`` is both the
    defense-in-depth id check (``/jobs`` already refused a non-UUIDv7, and this
    is the last gate before the id becomes a path segment) and the existence
    check — so a job aimed at a capture that was deleted, or never arrived,
    fails before anything is written. Creating the directory first left
    ``report/<plugin>/<capture_id>/`` behind for a job that could never run,
    which is indistinguishable on disk from a pipeline that ran and produced
    nothing.
    """
    resolve_source_dir(data_dir, job.capture_id)
    report_dir = data_dir / "report" / manifest.id / job.capture_id
    report_dir.mkdir(parents=True, exist_ok=True)
    return report_dir


def _make_dataflow_runner(manifest: PluginManifest, plugin_dir: Path) -> Runner:
    dataflow_yml = plugin_dir / manifest.entrypoint["dataflow"]

    async def _run(job: JobRecord, store: RunnerStore, data_dir: Path) -> dict:
        report_dir = _prepare_report_dir(manifest, job, data_dir)
        ctx = NodeContext(
            plugin_id=manifest.id,
            capture_id=job.capture_id,
            data_dir=data_dir,
            params=job.params,
            report_dir=report_dir,
        )
        job.progress = 0.4
        if dora_cli_available():
            await _run_via_dora_cli(dataflow_yml, ctx, job)
        else:
            await asyncio.to_thread(
                run_dataflow_in_process, dataflow_yml, plugin_dir, ctx
            )
        return _collect_result(manifest.id, report_dir)

    return _run


def _make_callable_runner(manifest: PluginManifest, plugin_dir: Path) -> Runner:
    """Runner for ``executor: in_process`` plugins exposing ``module:function``.

    The callable signature is ``(capture_id, data_dir, params, report_dir) -> None``;
    it must write ``summary.json`` (and any artifacts) under ``report_dir``.
    """
    fn = _load_attr(plugin_dir, manifest.entrypoint["callable"], manifest.id)

    async def _run(job: JobRecord, store: RunnerStore, data_dir: Path) -> dict:
        report_dir = _prepare_report_dir(manifest, job, data_dir)
        job.progress = 0.4
        await asyncio.to_thread(fn, job.capture_id, data_dir, job.params, report_dir)
        return _collect_result(manifest.id, report_dir)

    return _run


def dora_cli_available() -> bool:
    """Whether the ``dora`` CLI/daemon path is actually usable in this process.

    ``False`` when the Rust ``dora`` binary is absent (the CPU-only host case,
    where dataflows run through the in-process interpreter) or when
    ``KAIROS_DORA_INPROCESS`` forces the in-process path. Used both to pick the
    execution path and to report an honest executor in ``/pipelines`` /
    ``/readyz`` (dora is a deliberate future bet, not bundled yet).
    """
    if os.environ.get(_FORCE_INPROCESS_ENV):
        return False
    return shutil.which("dora") is not None


def effective_executor(declared: str) -> str:
    """Map a pipeline's *declared* executor to how it will ACTUALLY run.

    A pipeline may declare ``executor: dora``, but with no ``dora`` CLI present
    it transparently runs through the in-process dataflow interpreter. Everything
    that isn't genuinely dispatched to the dora daemon reports ``in-process`` so
    the UI/operator isn't misled into thinking dora is bundled.
    """
    if declared == "dora" and dora_cli_available():
        return "dora"
    return "in-process"


def _collect_result(plugin_id: str, report_dir: Path) -> dict:
    """Read the dataflow's ``summary.json`` and gather artifacts (uniform output)."""
    summary_path = report_dir / "summary.json"
    if not summary_path.exists():
        raise ApiError(
            status_code=500,
            code="plugin_no_summary",
            message=f"plugin '{plugin_id}' produced no summary.json",
            details={"report_dir": str(report_dir)},
        )
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    artifacts = [str(p) for p in sorted(report_dir.glob("**/*")) if p.is_file()]
    return {"summary": summary, "artifacts": artifacts}


async def _run_via_dora_cli(
    dataflow_yml: Path, ctx: NodeContext, job: JobRecord
) -> None:
    """Run the dataflow under the dora daemon: ``dora start dataflow.yml``.

    The nodes read their job context from ``KAIROS_*`` env (their ``main()``).
    This path needs the Rust ``dora`` CLI + a running daemon (``dora up``); it is
    unexercised on hosts that only have the dora Python bindings.
    """
    env = {
        **os.environ,
        "KAIROS_CAPTURE_ID": ctx.capture_id,
        "KAIROS_DATA_DIR": str(ctx.data_dir),
        "KAIROS_REPORT_DIR": str(ctx.report_dir),
        "KAIROS_PARAMS_JSON": json.dumps(ctx.params),
    }
    proc = await asyncio.create_subprocess_exec(
        "dora",
        "start",
        str(dataflow_yml),
        "--name",
        job.job_id,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await proc.communicate()
    if out:
        job.logs_tail.extend(out.decode(errors="replace").splitlines()[-20:])
    if proc.returncode != 0:
        raise ApiError(
            status_code=500,
            code="pipeline_failed",
            message=f"dora dataflow exited {proc.returncode}",
            details={"plugin": ctx.plugin_id},
        )


# ---- in-process dataflow interpreter ------------------------------------------


def run_dataflow_in_process(
    dataflow_yml: Path, plugin_dir: Path, ctx: NodeContext
) -> None:
    """Execute ``dataflow_yml`` without the dora daemon.

    Topologically order the nodes by their ``inputs`` edges (``node/output``),
    then call each node module's ``process(inputs, ctx) -> {output_name: value}``,
    routing one node's outputs into the next node's inputs. Builtin sources such
    as ``dora/timer/...`` are not nodes, so they are ignored when building edges.
    """
    spec = yaml.safe_load(dataflow_yml.read_text(encoding="utf-8")) or {}
    nodes = spec.get("nodes", [])
    by_id = {n["id"]: n for n in nodes}

    deps: dict[str, set[str]] = {n["id"]: set() for n in nodes}
    for node in nodes:
        for source in (node.get("inputs") or {}).values():
            producer = str(source).split("/", 1)[0]
            if producer in by_id:
                deps[node["id"]].add(producer)

    outputs_by_node: dict[str, dict[str, Any]] = {}
    for node_id in _toposort(deps):
        node = by_id[node_id]
        inputs: dict[str, Any] = {}
        for input_name, source in (node.get("inputs") or {}).items():
            producer, _, output_name = str(source).partition("/")
            if producer in by_id:
                inputs[input_name] = outputs_by_node[producer].get(output_name)
        module = _load_node_module(plugin_dir / node["path"], ctx.plugin_id, node_id)
        result = module.process(inputs, ctx)
        outputs_by_node[node_id] = result or {}


def _toposort(deps: dict[str, set[str]]) -> list[str]:
    """Kahn's algorithm; raises on a cycle (a malformed dataflow)."""
    remaining = {n: set(d) for n, d in deps.items()}
    order: list[str] = []
    while remaining:
        ready = sorted(n for n, d in remaining.items() if not d)
        if not ready:
            raise ValueError(f"cycle in dataflow nodes: {sorted(remaining)}")
        for node_id in ready:
            order.append(node_id)
            del remaining[node_id]
        for d in remaining.values():
            d.difference_update(ready)
    return order


def _load_node_module(path: Path, plugin_id: str, node_id: str) -> Any:
    """Import a node file by path under a unique module name (no sys.path leak)."""
    module_name = f"kairos_plugin.{plugin_id}.{node_id}"
    return _import_isolated(path, module_name)


def _load_attr(plugin_dir: Path, spec: str, plugin_id: str) -> Any:
    """Load ``module:function`` from a plugin's directory."""
    module_file, _, attr = spec.partition(":")
    if not attr:
        raise ValueError(f"callable must be 'module:function', got {spec!r}")
    module = _import_isolated(
        plugin_dir / f"{module_file}.py", f"kairos_plugin.{plugin_id}.{module_file}"
    )
    return getattr(module, attr)


def _import_isolated(path: Path, module_name: str) -> Any:
    if not path.is_file():
        raise FileNotFoundError(f"plugin module not found: {path}")
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot import plugin module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module
