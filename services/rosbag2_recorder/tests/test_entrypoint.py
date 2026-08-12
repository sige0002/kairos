# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Tests for the container entrypoint's custom-message overlay sourcing.

The entrypoint (``docker-entrypoint.sh``) sources the ROS underlay and, when
present, a custom-message colcon overlay so the spawned ``ros2 bag record``
inherits the type-support. These tests run the script directly under bash with
fake setup files (``ROS_ROOT`` relocates the underlay so nothing under /opt is
touched); they are skipped if bash is absent.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[1] / "docker-entrypoint.sh"

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None, reason="bash not available"
)

_DISTRO = "kairostest"


def _fake_underlay(tmp_path: Path) -> Path:
    """Create a fake ``<ROS_ROOT>/<distro>/setup.bash`` and return ROS_ROOT."""
    ros_root = tmp_path / "ros"
    (ros_root / _DISTRO).mkdir(parents=True)
    (ros_root / _DISTRO / "setup.bash").write_text("true\n", encoding="utf-8")
    return ros_root


def _make_overlay(root: Path, marker: str) -> Path:
    """Create a fake colcon overlay whose setup.bash exports OVERLAY_MARKER."""
    install = root / "install"
    install.mkdir(parents=True)
    (install / "setup.bash").write_text(
        f'export OVERLAY_MARKER="{marker}"\n', encoding="utf-8"
    )
    return root


def _run(env: dict[str, str], command: list[str]) -> subprocess.CompletedProcess[str]:
    full_env = os.environ.copy()
    full_env.update({"ROS_DISTRO": _DISTRO, **env})
    return subprocess.run(
        ["bash", str(ENTRYPOINT), *command],
        env=full_env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_overlay_is_sourced_when_present(tmp_path: Path) -> None:
    ros_root = _fake_underlay(tmp_path)
    overlay = _make_overlay(tmp_path / "msgs_overlay", "custom-msgs-here")
    result = _run(
        {"ROS_ROOT": str(ros_root), "MSGS_OVERLAY": str(overlay)},
        ["bash", "-c", 'echo "MARKER=$OVERLAY_MARKER"'],
    )
    assert result.returncode == 0, result.stderr
    # The exec'd command sees the overlay's exported variable -> it was sourced
    # into the same env the app (and its ros2 subprocess) would inherit.
    assert "MARKER=custom-msgs-here" in result.stdout
    assert "sourced custom-message overlay" in result.stderr


def test_no_overlay_is_fine_when_unset(tmp_path: Path) -> None:
    ros_root = _fake_underlay(tmp_path)
    result = _run(
        {"ROS_ROOT": str(ros_root), "MSGS_OVERLAY": ""},
        ["bash", "-c", 'echo "MARKER=${OVERLAY_MARKER:-none}"'],
    )
    assert result.returncode == 0, result.stderr
    assert "MARKER=none" in result.stdout
    assert "sourced custom-message overlay" not in result.stderr


def test_overlay_set_but_missing_warns(tmp_path: Path) -> None:
    ros_root = _fake_underlay(tmp_path)
    missing = tmp_path / "absent_overlay"  # no install/setup.bash
    result = _run(
        {"ROS_ROOT": str(ros_root), "MSGS_OVERLAY": str(missing)},
        ["bash", "-c", "true"],
    )
    assert result.returncode == 0, result.stderr
    assert "not found; custom types unavailable" in result.stderr


def test_exec_passes_through_exit_code(tmp_path: Path) -> None:
    ros_root = _fake_underlay(tmp_path)
    result = _run(
        {"ROS_ROOT": str(ros_root), "MSGS_OVERLAY": ""},
        ["bash", "-c", "exit 7"],
    )
    assert result.returncode == 7
