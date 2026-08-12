"""Startup removes leftover staging, and removal never reaches recorded bytes."""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path

from kairos_common import Settings
from lerobot_exporter.main import create_exporter_app
from lerobot_exporter.staging import sweep_staging


def test_leftover_staging_is_swept_at_startup(
    data_dir: Path, make_capture: Callable[..., str]
) -> None:
    """No conversion survives a restart, so every staging tree is debris."""
    capture = make_capture()
    stale = data_dir / "exports" / ".staging" / "0197c0de-dead-7000-8000-000000000001"
    (stale / "001").mkdir(parents=True)
    os.symlink(
        data_dir / "objects" / capture / "metadata.yaml",
        stale / "001" / "metadata.yaml",
    )

    create_exporter_app(Settings(data_dir=str(data_dir)))

    assert not stale.exists()
    # The links were removed; what they pointed at was not.
    assert (data_dir / "objects" / capture / "metadata.yaml").is_file()


def test_sweeping_an_absent_staging_root_is_a_no_op(data_dir: Path) -> None:
    assert sweep_staging(data_dir) == []


def test_sweep_reports_what_it_removed(data_dir: Path) -> None:
    for name in ("export-a", "export-b"):
        (data_dir / "exports" / ".staging" / name).mkdir(parents=True)

    assert sweep_staging(data_dir) == ["export-a", "export-b"]
