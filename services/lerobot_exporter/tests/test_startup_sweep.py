"""Startup removes leftover staging, and removal never reaches recorded bytes."""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path

import pytest
from kairos_common import Settings
from kairos_common.ids import new_capture_id
from lerobot_exporter.main import create_exporter_app
from lerobot_exporter.models import ExportEpisode
from lerobot_exporter.staging import (
    StagingError,
    build_staging,
    remove_export_staging,
    remove_output_dir,
    sweep_staging,
)


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


def test_a_symlinked_staging_root_is_refused_not_followed(
    data_dir: Path, make_capture: Callable[..., str]
) -> None:
    """The F1 case: `exports/.staging` itself is a symlink to `objects/`.

    A relocated or attacker-writable EXPORTS_DIR could make the staging root a
    link at the store's captures. Following it would iterate every capture and
    rmtree it — destroying authoritative recordings. The sweep must refuse a
    symlinked root outright and touch nothing behind it.
    """
    capture = make_capture()
    exports = data_dir / "exports"
    exports.mkdir(parents=True, exist_ok=True)
    os.symlink(data_dir / "objects", exports / ".staging")

    assert sweep_staging(data_dir) == []
    # The capture the link pointed at is untouched.
    assert (data_dir / "objects" / capture / "metadata.yaml").is_file()


def test_a_symlinked_entry_inside_staging_is_not_followed_into_objects(
    data_dir: Path, make_capture: Callable[..., str]
) -> None:
    """A real staging root holding a symlink that points at a capture dir must
    not have that capture rmtree'd through it — only the link is removed."""
    capture = make_capture()
    staging = data_dir / "exports" / ".staging"
    staging.mkdir(parents=True)
    os.symlink(data_dir / "objects" / capture, staging / "escape")

    sweep_staging(data_dir)

    assert not (staging / "escape").exists()
    assert (data_dir / "objects" / capture / "metadata.yaml").is_file()


def test_build_staging_refuses_a_symlinked_staging_root(
    data_dir: Path, make_capture: Callable[..., str]
) -> None:
    """The F1 residual: build_staging rmtree's exports/.staging/<export_id> on
    every submit, and export_id is caller-controlled. If .staging is a symlink
    at objects/, that rmtree would delete the capture named by export_id — so a
    symlinked root must be refused before anything is removed."""
    victim = make_capture()
    exports = data_dir / "exports"
    exports.mkdir(parents=True, exist_ok=True)
    os.symlink(data_dir / "objects", exports / ".staging")

    # export_id is a real UUIDv7 (the API validates it) that also names the
    # victim capture — the exact shape the review demonstrated over HTTP.
    episode = ExportEpisode(capture_id=new_capture_id(), dir="001", task=None)
    with pytest.raises(StagingError):
        build_staging(data_dir, victim, [episode])

    assert (data_dir / "objects" / victim / "metadata.yaml").is_file()


def test_remove_export_staging_does_not_follow_a_root_symlinked_after_the_guard(
    data_dir: Path, make_capture: Callable[..., str]
) -> None:
    """The TOCTOU variant: .staging is a real dir at guard time and is swapped
    to a symlink at objects/ before the removal runs (mid-export). The fd-pinned
    removal must not follow it — the build-time path check is not enough because
    the removal re-resolves the path minutes later."""
    victim = make_capture()
    staging = data_dir / "exports" / ".staging"
    staging.mkdir(parents=True)
    # It was a real directory when the guard ran; now it is swapped.
    staging.rmdir()
    os.symlink(data_dir / "objects", staging)

    # Would delete objects/<victim> if the removal followed the symlink.
    remove_export_staging(data_dir, victim)

    assert (data_dir / "objects" / victim / "metadata.yaml").is_file()


def test_remove_output_dir_does_not_follow_a_symlinked_exports(
    data_dir: Path, make_capture: Callable[..., str]
) -> None:
    """The partial-output twin: exports/ swapped to a symlink at objects/ before
    the failure-path removal runs must not have a capture deleted through it."""
    victim = make_capture()
    exports = data_dir / "exports"
    exports.rmdir()
    os.symlink(data_dir / "objects", exports)

    remove_output_dir(data_dir, victim)

    assert (data_dir / "objects" / victim / "metadata.yaml").is_file()
