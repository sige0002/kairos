"""bagflow flow catalog + per-job materialization (spec: docs/specs/ja/dora_runner.md).

kairos does not invent a flow dialect: a file under ``config/<robot>/flows/`` **is**
a bagflow ``flow.yml`` (`services/dora_runner/bagflow/README.md`). What kairos adds
is *materialization* — the per-job step that turns an operator's declarative file
in the read-only ``/config`` mount into a runnable flow in a writable per-run
workdir:

1. **``${KAIROS_*}`` substitution.** A flow declares what it needs from the job
   (the run's required topics, the recording config's expected Hz, …) instead of
   repeating values that already live in kairos config. This is the seam between
   the Config-tab validation template and the flow: the template stays the single
   place required topics are declared, and a flow node reads them through
   ``${KAIROS_REQUIRED_TOPICS}``. An unknown ``${KAIROS_…}`` token is an error —
   never silently passed through.
2. **node ``path`` resolution.** A bare name (``bagflow-blur``) resolves to the
   bundled binary; a relative path resolves against the flow FILE's directory (so
   a node shipped next to the flow keeps working after the copy); an absolute path
   is left alone. Upstream bagflow resolves every relative path against the flow
   file, which would break once kairos copies the flow elsewhere.
3. **``bag`` / ``report`` injection.** kairos owns both (the run's recording dir
   and the report path under ``data/report/``), so whatever the file says is
   overwritten — a flow in ``config/`` normally omits them.

The materialized flow lands in a writable dir because bagflow/dora write next to
the flow file (``.bagflow/dataflow.yml``, ``.bagflow/out/<uuid>/log_<node>.txt``);
running one straight out of ``/config`` would die with ``Read-only file system``.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from kairos_common import resolve_config_path

# Env overrides (in-tree KAIROS_*/BAGFLOW_* convention, see plugin_loader).
FLOWS_DIR_ENV = "BAGFLOW_FLOWS_DIR"
BIN_DIR_ENV = "BAGFLOW_BIN_DIR"

DEFAULT_BIN_DIR = "/usr/local/bin"
DEFAULT_FLOW = "default"
FLOW_SUFFIXES = (".yml", ".yaml")

# A flow name becomes a file name under the flows dir: same guard as run_id.
_FLOW_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_TOKEN_RE = re.compile(r"\$\{(KAIROS_[A-Z0-9_]+)\}")


def default_flows_dir() -> str:
    """Flows dir when ``BAGFLOW_FLOWS_DIR`` is unset: the active robot's dir.

    Mirrors ``loss_report_config._default_loss_report_path`` — deployments set
    the env explicitly (Makefile/compose derive it from ``ROBOT``, resolving the
    gitignored ``config/local/<robot>/`` tree too) and that always wins.
    """
    robot = os.environ.get("ROBOT", "airoa_hsr")
    return f"/config/{robot}/flows"


def flows_dir() -> Path:
    """Resolved flows directory (honours the ``config/local/<robot>/`` twin)."""
    return Path(
        resolve_config_path(os.environ.get(FLOWS_DIR_ENV) or default_flows_dir())
    )


def bin_dir() -> Path:
    """Directory holding the bundled ``bagflow-*`` node binaries."""
    return Path(os.environ.get(BIN_DIR_ENV) or DEFAULT_BIN_DIR)


def list_flows(directory: Path | None = None) -> list[str]:
    """Flow names available to jobs (file stems, sorted). Empty when unconfigured."""
    resolved = directory if directory is not None else flows_dir()
    if not resolved.is_dir():
        return []
    return sorted(
        {
            p.stem
            for p in resolved.iterdir()
            if p.is_file() and p.suffix in FLOW_SUFFIXES and _FLOW_NAME_RE.match(p.stem)
        }
    )


def flow_path(name: str, directory: Path | None = None) -> Path:
    """Resolve a flow name to its file, or raise ``ValueError``/``FileNotFoundError``.

    The name is a single path component by construction (charset guard), so a
    job param can never reach outside the flows dir.
    """
    if not _FLOW_NAME_RE.match(name):
        raise ValueError(f"invalid flow name (must match ^[A-Za-z0-9_-]+$): {name!r}")
    resolved = directory if directory is not None else flows_dir()
    for suffix in FLOW_SUFFIXES:
        candidate = resolved / f"{name}{suffix}"
        if candidate.is_file():
            return candidate
    available = ", ".join(list_flows(resolved)) or "(none)"
    raise FileNotFoundError(
        f"validation flow not found: {name} in {resolved} — available: {available}"
    )


@dataclass(frozen=True)
class FlowBindings:
    """Values a flow may reference through ``${KAIROS_…}``.

    ``required_topics`` comes from the same validation template ``fast_validation``
    uses (job param, else the recording config's ``validation.required_topics``);
    ``expect_hz`` merges those with ``RECORDING_CONFIG``'s ``expected_hz_patterns``
    into the ``{topic: hz}`` map ``bagflow-topic-rate`` consumes (0 = must exist,
    any rate — see ``full_validation.topic_expectations``). A flow therefore never
    restates a topic list or a threshold that already has a home in kairos config.
    """

    run_id: str
    bag_dir: Path
    report_path: Path
    report_dir: Path
    required_topics: list[str]
    expect_hz: dict[str, float]

    def tokens(self) -> dict[str, str]:
        """Token -> replacement text (JSON for the structured ones: a bagflow
        ``env:`` value is a string, and the check nodes parse JSON there)."""
        return {
            "KAIROS_RUN_ID": self.run_id,
            "KAIROS_BAG_DIR": str(self.bag_dir),
            "KAIROS_REPORT": str(self.report_path),
            "KAIROS_REPORT_DIR": str(self.report_dir),
            "KAIROS_REQUIRED_TOPICS": json.dumps(self.required_topics),
            "KAIROS_EXPECT_HZ": json.dumps(self.expect_hz),
        }


def _substitute(value: Any, tokens: dict[str, str]) -> Any:
    """Recursively replace ``${KAIROS_…}`` tokens in every string of *value*."""
    if isinstance(value, dict):
        return {key: _substitute(item, tokens) for key, item in value.items()}
    if isinstance(value, list):
        return [_substitute(item, tokens) for item in value]
    if not isinstance(value, str):
        return value

    def replace(match: re.Match[str]) -> str:
        token = match.group(1)
        if token not in tokens:
            known = ", ".join(sorted(tokens))
            raise ValueError(f"unknown flow placeholder ${{{token}}} (known: {known})")
        return tokens[token]

    return _TOKEN_RE.sub(replace, value)


def resolve_node_path(raw: str, flow_dir: Path, binaries: Path) -> str:
    """Resolve one node ``path`` (see the module docstring's rule 2)."""
    if raw.startswith("/"):
        return raw
    if "/" not in raw:
        bundled = binaries / raw
        if bundled.is_file():
            return str(bundled)
    return str((flow_dir / raw).resolve())


def materialize_flow(
    name: str,
    bindings: FlowBindings,
    workdir: Path,
    *,
    directory: Path | None = None,
    binaries: Path | None = None,
) -> Path:
    """Write the runnable flow for one job into *workdir* and return its path.

    Raises ``ValueError`` (bad name / unknown placeholder / malformed file) or
    ``FileNotFoundError`` (no such flow), which the pipeline turns into a job
    failure with the message intact.
    """
    source = flow_path(name, directory)
    raw = yaml.safe_load(source.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"flow root must be a mapping: {source}")
    spec = _substitute(raw, bindings.tokens())

    nodes = spec.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        raise ValueError(f"flow declares no nodes: {source}")
    resolver_bin = binaries if binaries is not None else bin_dir()
    for node in nodes:
        if isinstance(node, dict) and isinstance(node.get("path"), str):
            node["path"] = resolve_node_path(node["path"], source.parent, resolver_bin)

    # kairos owns the run's inputs/outputs; a flow in config/ omits them.
    spec["bag"] = str(bindings.bag_dir)
    spec["report"] = str(bindings.report_path)

    workdir.mkdir(parents=True, exist_ok=True)
    target = workdir / "flow.yml"
    target.write_text(
        yaml.safe_dump(spec, sort_keys=False, allow_unicode=True), encoding="utf-8"
    )
    return target
