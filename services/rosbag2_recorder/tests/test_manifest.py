"""run_id validation, path safety, and manifest read/write round-trip."""

from __future__ import annotations

from pathlib import Path

import pytest
from kairos_common import ApiError, Compression
from rosbag2_recorder.manifest import (
    Manifest,
    manifest_path,
    read_manifest,
    run_dir,
    validate_run_id,
    write_manifest,
)
from rosbag2_recorder.models import RunState, SplitConfig, TopicEntry


@pytest.mark.parametrize(
    "run_id",
    ["run_20260624_010203", "abc", "A1-b2_C3", "0", "x" * 200],
)
def test_validate_run_id_accepts_allowed_charset(run_id: str) -> None:
    assert validate_run_id(run_id) == run_id


@pytest.mark.parametrize(
    "run_id",
    ["", "../escape", "a/b", "has space", "dots.here", "uniçode", "semi;colon"],
)
def test_validate_run_id_rejects_bad_charset(run_id: str) -> None:
    with pytest.raises(ApiError) as exc:
        validate_run_id(run_id)
    assert exc.value.status_code == 400
    assert exc.value.code == "invalid_run_id"


def test_run_dir_cannot_escape_recorded_root(data_dir: Path) -> None:
    # A traversal attempt is rejected at validation, never resolved to a path.
    with pytest.raises(ApiError):
        run_dir(data_dir, "../../etc")
    good = run_dir(data_dir, "run_1")
    assert good == data_dir / "recorded" / "run_1"


def test_manifest_round_trip(data_dir: Path) -> None:
    manifest = Manifest(
        run_id="run_1",
        state=RunState.completed,
        topics=[
            TopicEntry(name="/joint_states", type="sensor_msgs/msg/JointState"),
            TopicEntry(name="/tf", type=None),
        ],
        started_at="2026-06-24T01:02:03.000Z",
        ended_at="2026-06-24T01:05:03.000Z",
        compression=Compression.zstd,
        split=SplitConfig(max_size_mb=500, max_duration_s=None),
        error=None,
    )
    path = write_manifest(data_dir, manifest)
    assert path == manifest_path(data_dir, "run_1")

    loaded = read_manifest(data_dir, "run_1")
    assert loaded == manifest
    assert loaded.compression is Compression.zstd
    assert loaded.split is not None and loaded.split.max_size_mb == 500


def test_read_manifest_missing_is_404(data_dir: Path) -> None:
    with pytest.raises(ApiError) as exc:
        read_manifest(data_dir, "nope")
    assert exc.value.status_code == 404


def test_write_manifest_is_atomic_no_tmp_left(data_dir: Path) -> None:
    write_manifest(data_dir, Manifest(run_id="run_1", state=RunState.recording))
    files = {p.name for p in (data_dir / "recorded" / "run_1").iterdir()}
    assert files == {"manifest.json"}
