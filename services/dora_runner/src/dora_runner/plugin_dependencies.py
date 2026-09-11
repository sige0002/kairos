# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Build-time plugin dependencies; runtime only selects already-built environments."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict, Field, field_validator

if TYPE_CHECKING:
    from dora_runner.plugin_loader import PluginManifest


class PluginRequirements(BaseModel):
    model_config = ConfigDict(extra="forbid")

    gpu: bool = False
    apt: list[str] = Field(default_factory=list)
    build_apt: list[str] = Field(default_factory=list)

    @field_validator("apt", "build_apt")
    @classmethod
    def package_names(cls, values: list[str]) -> list[str]:
        pattern = r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?(?:=[A-Za-z0-9.+:~_-]+)?"
        for value in values:
            if not re.fullmatch(pattern, value):
                raise ValueError(f"invalid Debian package specification: {value!r}")
        return values


def has_python_dependencies(plugin_dir: Path) -> bool:
    return any(
        (plugin_dir / name).is_file() for name in ("requirements.txt", "pyproject.toml")
    )


def environment_python(plugin_dir: Path, plugin_id: str) -> Path | None:
    root = os.environ.get("KAIROS_PLUGIN_ENVS_DIR")
    env_dir = Path(root) / plugin_id if root else plugin_dir / ".venv"
    python = env_dir / "bin" / "python"
    if python.is_file():
        # Do not resolve the venv's Python symlink: its location selects sys.prefix.
        return python.absolute()
    if has_python_dependencies(plugin_dir):
        raise ValueError(
            f"plugin '{plugin_id}' has Python dependencies but no built environment; "
            "rebuild dora_runner with this plugin included"
        )
    return None


def _run(argv: list[str], *, cwd: Path | None = None) -> None:
    subprocess.run(argv, cwd=cwd, check=True)


def validate_dataflow(plugin_dir: Path, manifest: PluginManifest) -> None:
    """Only local custom-node graphs are part of the image plugin contract."""
    import yaml

    flow = manifest.entrypoint.get("dataflow")
    if not flow:
        return
    flow_file = plugin_dir / flow
    graph = yaml.safe_load(flow_file.read_text())
    for node in graph["nodes"]:
        path = node.get("path")
        if not isinstance(path, str) or not path or "://" in path:
            raise ValueError(
                f"plugin '{manifest.id}': nodes must use local 'path' entries; "
                "remote sources and operator nodes are not supported"
            )
        if path.endswith(".py") and not (flow_file.parent / path).is_file():
            raise ValueError(
                f"plugin '{manifest.id}': Python node does not exist: {path}"
            )


def manifests(plugins_dir: Path) -> Iterator[tuple[Path, PluginManifest]]:
    # Deferred to keep the runtime selector importable from plugin_loader.
    from dora_runner.plugin_loader import _load_manifest

    seen: set[str] = set()
    for path in sorted(plugins_dir.glob("*/kairos_plugin.yaml")):
        manifest = _load_manifest(path)
        if manifest.id in seen:
            raise ValueError(f"duplicate plugin id: {manifest.id}")
        seen.add(manifest.id)
        validate_dataflow(path.parent, manifest)
        if manifest.requires.gpu and os.environ.get("KAIROS_PLUGIN_GPU_ENABLED") != "1":
            raise ValueError(
                f"plugin '{manifest.id}' requires a GPU; use PLUGIN_GPU=1 with "
                "a GPU-capable Docker host, or exclude this plugin from the build"
            )
        yield path.parent, manifest


def install(plugins_dir: Path, envs_dir: Path) -> None:
    """Install each plugin into its own environment without modifying the service."""
    envs_dir.mkdir(parents=True, exist_ok=True)
    base_site = next((Path(sys.prefix) / "lib").glob("python*/site-packages"))
    # The node wire protocol and common contract must match the daemon/service.
    import importlib.metadata

    constraints = envs_dir / "runtime-constraints.txt"
    constraints.write_text(
        "\n".join(
            f"{name}=={importlib.metadata.version(name)}"
            for name in ("dora-rs", "pyarrow", "kairos-common")
        )
        + "\n"
    )
    for plugin_dir, manifest in manifests(plugins_dir):
        if not has_python_dependencies(plugin_dir):
            continue
        print(f"Installing plugin dependencies: {manifest.id}", flush=True)
        env = envs_dir / manifest.id
        _run(["uv", "venv", "--python", sys.executable, str(env)])
        site = next((env / "lib").glob("python*/site-packages"))
        # Share immutable runtime packages; plugin overrides live only in this venv.
        (site / "kairos-runtime.pth").write_text(str(base_site) + "\n")
        python = env / "bin" / "python"
        requirements = plugin_dir / "requirements.txt"
        project = plugin_dir / "pyproject.toml"
        args = [
            "uv",
            "pip",
            "install",
            "--python",
            str(python),
            "--constraint",
            str(constraints),
        ]
        if requirements.is_file():
            args += ["-r", str(requirements)]
        if project.is_file():
            if (plugin_dir / "uv.lock").is_file():
                locked = env / "requirements.lock.txt"
                _run(
                    [
                        "uv",
                        "export",
                        "--locked",
                        "--no-dev",
                        "--no-emit-project",
                        "--project",
                        str(plugin_dir),
                        "--output-file",
                        str(locked),
                    ]
                )
                args += ["-r", str(locked)]
            args.append(str(plugin_dir))
        try:
            _run(args, cwd=plugin_dir)
            _run(["uv", "pip", "check", "--python", str(python)])
        except subprocess.CalledProcessError as exc:
            raise RuntimeError(
                f"dependency installation failed for plugin '{manifest.id}'"
            ) from exc
        installed = subprocess.check_output(
            ["uv", "pip", "freeze", "--python", str(python)], text=True
        )
        (env / "requirements.resolved.txt").write_text(installed)
        (env / "plugin.json").write_text(
            json.dumps({"id": manifest.id, "source": str(plugin_dir)})
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "system-packages"])
    parser.add_argument("--plugins-dir", type=Path, default=Path("/app/plugins"))
    parser.add_argument("--envs-dir", type=Path, default=Path("/opt/plugin-envs"))
    parser.add_argument("--kind", choices=["build", "runtime"], default="runtime")
    args = parser.parse_args()
    if args.action == "install":
        install(args.plugins_dir, args.envs_dir)
    else:
        packages = set()
        for _, manifest in manifests(args.plugins_dir):
            packages.update(manifest.requires.apt)
            if args.kind == "build":
                packages.update(manifest.requires.build_apt)
        print("\n".join(sorted(packages)))


if __name__ == "__main__":
    main()
