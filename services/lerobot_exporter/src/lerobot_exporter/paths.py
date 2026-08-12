"""Where an export reads from and writes to, and the guards on those names.

The store root is fixed (``<data_dir>/exports/``): the only place guaranteed to
be mounted into every container, so a relative key resolves from the host and
from inside a container alike. Nothing here ever addresses ``objects/`` for
writing — the exporter reads captures through symlinks only.
"""

from __future__ import annotations

from pathlib import Path

from kairos_common import ApiError
from kairos_common.export_names import (
    EXPORT_SEGMENT_MAX_LEN,
    is_valid_export_segment,
)

EXPORTS_DIRNAME = "exports"
STAGING_DIRNAME = ".staging"
MANIFEST_EXTRA_FILENAME = "kairos_extra.json"


def exports_dir(data_dir: str | Path) -> Path:
    """``<data_dir>/exports`` — the one export destination root."""
    return Path(data_dir) / EXPORTS_DIRNAME


def staging_root(data_dir: str | Path) -> Path:
    """``<data_dir>/exports/.staging`` — transient per-export input trees."""
    return exports_dir(data_dir) / STAGING_DIRNAME


def export_staging_dir(data_dir: str | Path, export_id: str) -> Path:
    """``<data_dir>/exports/.staging/<export_id>``."""
    return staging_root(data_dir) / export_id


def output_dir(data_dir: str | Path, output_name: str) -> Path:
    """``<data_dir>/exports/<output_name>`` — the LeRobot dataset written."""
    return exports_dir(data_dir) / output_name


def relative_output_path(output_name: str) -> str:
    """The data-root RELATIVE path recorded and returned by the API.

    Absolute paths are never baked into a response: ``/data`` inside the
    container and ``$DATA_DIR`` on the host name the same bytes, and only the
    relative key resolves from both viewpoints.
    """
    return f"{EXPORTS_DIRNAME}/{output_name}"


def validate_segment(value: str, *, field: str, code: str) -> str:
    """Return *value* if it is a safe single path segment, else raise 400.

    The contract lives in ``kairos_common.export_names`` so this refusal and the
    orchestrator's name composition cannot drift — a name the orchestrator shows
    in preflight is exactly one this accepts.
    """
    if not is_valid_export_segment(value):
        raise ApiError(
            status_code=400,
            code=code,
            message=(
                f"{field} must be a single path segment starting with a letter or "
                f"digit (letters, digits, '.', '_', '-'; max "
                f"{EXPORT_SEGMENT_MAX_LEN} characters)."
            ),
            details={field: value},
        )
    return value


def is_non_empty_dir(path: Path) -> bool:
    """Whether *path* is a directory that already holds something.

    An EMPTY directory is not a refusal: a previous run that died between
    claiming the destination and writing its first file would otherwise block
    every retry, and the debris it leaves behind is nothing.
    """
    if not path.is_dir():
        return False
    return any(path.iterdir())
