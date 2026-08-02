"""run_id validation and the path safety that rests on capture_id being a UUIDv7."""

from __future__ import annotations

from pathlib import Path

import pytest
from kairos_common import ApiError
from kairos_common.capture_sidecars import capture_dir, failed_start_path, objects_dir
from kairos_common.ids import new_capture_id
from rosbag2_recorder.models import validate_run_id


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


def test_capture_paths_stay_inside_objects(data_dir: Path) -> None:
    """The path helpers refuse anything that is not a UUIDv7.

    That refusal is what makes ``objects/<capture_id>`` safe: an id that passes
    cannot contain ``/`` or ``..``, so no capture path can escape the store.
    """
    capture_id = new_capture_id()
    assert capture_dir(data_dir, capture_id) == objects_dir(data_dir) / capture_id
    assert failed_start_path(data_dir, capture_id).parent == objects_dir(data_dir)

    for bad in ("../../etc", "run_1", ""):
        with pytest.raises(ValueError):
            capture_dir(data_dir, bad)
        with pytest.raises(ValueError):
            failed_start_path(data_dir, bad)
