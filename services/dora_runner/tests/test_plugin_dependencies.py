# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Dependency declarations fail before a plugin can be advertised as usable."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml
from dora_runner.plugin_dependencies import (
    PluginRequirements,
    environment_python,
    manifests,
)
from dora_runner.plugin_loader import discover_plugins
from dora_runner.registry import PipelineRegistry
from pydantic import ValidationError


def _plugin(root: Path, name: str, **overrides) -> Path:
    directory = root / name
    directory.mkdir(parents=True)
    spec = {
        "apiVersion": "kairos.plugin/v1",
        "id": name,
        "name": name,
        "entrypoint": {"dataflow": "dataflow.yml"},
        **overrides,
    }
    (directory / "kairos_plugin.yaml").write_text(yaml.safe_dump(spec))
    (directory / "dataflow.yml").write_text("nodes: []\n")
    return directory


@pytest.mark.parametrize(
    "package", ["--allow-unauthenticated", "curl;echo", "bad package", ""]
)
def test_rejects_invalid_system_dependencies(package: str) -> None:
    with pytest.raises(ValidationError):
        PluginRequirements(apt=[package])


def test_unknown_requirement_is_not_silently_ignored() -> None:
    with pytest.raises(ValidationError):
        PluginRequirements.model_validate({"gup": True})
    assert PluginRequirements(apt=["libmagic1", "libfoo:arm64=1.2-3"]).apt


def test_missing_environment_does_not_advertise_a_dependency_plugin(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("KAIROS_PLUGIN_ENVS_DIR", str(tmp_path / "envs"))
    directory = _plugin(tmp_path / "plugins", "needs_dependencies")
    (directory / "requirements.txt").write_text("humanize==4.10.0\n")
    _plugin(tmp_path / "plugins", "plain")
    registry = PipelineRegistry()
    errors = discover_plugins(registry, tmp_path / "plugins")
    assert registry.get("needs_dependencies") is None
    assert registry.get("plain") is not None
    assert len(errors) == 1 and "rebuild dora_runner" in errors[0].error


def test_venv_python_symlink_keeps_its_environment_prefix(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("KAIROS_PLUGIN_ENVS_DIR", str(tmp_path / "envs"))
    python = tmp_path / "envs" / "sample" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.symlink_to(sys.executable)
    assert environment_python(tmp_path, "sample") == python
    assert environment_python(tmp_path, "plain") is None


def test_gpu_is_explicit_at_build_and_discovery(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("KAIROS_PLUGIN_GPU_ENABLED", raising=False)
    _plugin(tmp_path, "gpu_plugin", requires={"gpu": True})
    with pytest.raises(ValueError, match="PLUGIN_GPU=1"):
        list(manifests(tmp_path))
    registry = PipelineRegistry()
    assert discover_plugins(registry, tmp_path)
    assert registry.get("gpu_plugin") is None
    monkeypatch.setenv("KAIROS_PLUGIN_GPU_ENABLED", "1")
    assert len(list(manifests(tmp_path))) == 1
    assert discover_plugins(registry, tmp_path) == []
    assert registry.get("gpu_plugin") is not None


def test_duplicate_ids_stop_the_build(tmp_path: Path) -> None:
    _plugin(tmp_path, "first", id="duplicate")
    _plugin(tmp_path, "second", id="duplicate")
    with pytest.raises(ValueError, match="duplicate plugin id"):
        list(manifests(tmp_path))


@pytest.mark.parametrize(
    "node",
    [
        {"id": "remote", "path": "https://example.com/node.py"},
        {"id": "operator", "operators": []},
    ],
)
def test_nonlocal_or_operator_graph_fails_before_build(
    tmp_path: Path, node: dict
) -> None:
    directory = _plugin(tmp_path, "unsupported")
    (directory / "dataflow.yml").write_text(yaml.safe_dump({"nodes": [node]}))
    with pytest.raises(ValueError, match="local 'path'"):
        list(manifests(tmp_path))
