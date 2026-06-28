"""The kairos ``manifest.json`` written alongside each recorded run.

rosbag2 already writes a standard ``metadata.yaml``; the manifest is the kairos
audit record that captures the recorder's view of the run (state, the frozen
topic selection with types/QoS, timestamps, compression/split, and any error).
The source of truth for *runs* is ``api_orchestrator``'s SQLite — this file is
for audit and crash recovery (an ``interrupted`` run can be detected from it).

See ``docs/specs/ja/rosbag2_recorder.md`` (Outputs).
"""

from __future__ import annotations

import json
from pathlib import Path

from kairos_common import ApiError, Compression
from pydantic import BaseModel, Field

from rosbag2_recorder.models import RUN_ID_PATTERN, RunState, SplitConfig, TopicEntry

MANIFEST_FILENAME = "manifest.json"
# rosbag2 writes this standard metadata file inside the run output directory.
ROSBAG2_METADATA_FILENAME = "metadata.yaml"
# Session sidecar (who recorded / what task + lifecycle), beside the MCAP.
SESSION_FILENAME = "session.json"


class Manifest(BaseModel):
    """kairos per-run audit record persisted as ``manifest.json``."""

    run_id: str
    state: RunState
    topics: list[TopicEntry] = Field(default_factory=list)
    started_at: str | None = None
    ended_at: str | None = None
    compression: Compression = Compression.none
    split: SplitConfig | None = None
    # Finalised counters from the stop-time verification (OL-①.5): total recorded
    # messages (from rosbag2 metadata) and on-disk MCAP bytes. None until known.
    message_count: int | None = None
    bytes: int | None = None
    error: str | None = None
    # Recording integrity from rosbag2's in-recorder cache: messages dropped on
    # cache overflow ("Total lost"; None = unknown) + a coarse classification
    # ("ok" | "dropped" | "failed" | "unknown"). Surfaces silent in-recorder loss.
    dropped_messages: int | None = None
    integrity: str = "unknown"


def validate_run_id(run_id: str) -> str:
    """Return *run_id* if it matches ``^[A-Za-z0-9_-]+$``, else raise 400.

    The charset guard prevents path traversal: the run_id becomes a directory
    name under ``/data/recorded``. The orchestrator allocates the id, but the
    recorder still validates it (defence in depth).
    """
    if not RUN_ID_PATTERN.match(run_id):
        raise ApiError(
            status_code=400,
            code="invalid_run_id",
            message="run_id must match ^[A-Za-z0-9_-]+$.",
            details={"run_id": run_id},
        )
    return run_id


def run_dir(data_dir: str | Path, run_id: str) -> Path:
    """Return the output directory for *run_id*: ``<data_dir>/recorded/<run_id>``.

    *run_id* is validated first, so the result cannot escape ``recorded/``.
    """
    validate_run_id(run_id)
    return Path(data_dir) / "recorded" / run_id


def manifest_path(data_dir: str | Path, run_id: str) -> Path:
    """Return the manifest path for *run_id*."""
    return run_dir(data_dir, run_id) / MANIFEST_FILENAME


def failed_start_path(data_dir: str | Path, run_id: str) -> Path:
    """Path of the failed-start record (a *sibling* of the run dir).

    A start that never produced a bag must NOT create a ``recorded/<run_id>/``
    directory (that would look like a real recording artifact to Stage 2 scans).
    The failure is recorded as ``recorded/<run_id>.failed.json`` instead, so the
    invariant "a run dir exists only when ros2 wrote a bag" holds.
    """
    validate_run_id(run_id)
    return Path(data_dir) / "recorded" / f"{run_id}.failed.json"


def write_failed_start_record(data_dir: str | Path, manifest: Manifest) -> Path:
    """Write a failed-start *manifest* to the sibling record (no run dir created).

    Only the ``recorded/`` root is created (not the per-run dir), so a failed
    start leaves no spurious recording directory behind.
    """
    path = failed_start_path(data_dir, manifest.run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(manifest.model_dump(mode="json"), indent=2) + "\n",
        encoding="utf-8",
    )
    tmp.replace(path)
    return path


def write_manifest(data_dir: str | Path, manifest: Manifest) -> Path:
    """Write *manifest* atomically to the run's ``manifest.json``.

    The directory is created if needed. Writes to a temp file then renames so a
    concurrent reader never sees a half-written file.
    """
    path = manifest_path(data_dir, manifest.run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(manifest.model_dump(mode="json"), indent=2) + "\n",
        encoding="utf-8",
    )
    tmp.replace(path)
    return path


def session_path(data_dir: str | Path, run_id: str) -> Path:
    """Path of the run's ``session.json`` (inside the run output directory)."""
    return run_dir(data_dir, run_id) / SESSION_FILENAME


def write_session(data_dir: str | Path, run_id: str, payload: dict) -> Path:
    """Write the run's ``session.json`` sidecar atomically (beside the MCAP).

    Captures the operator / task plus lifecycle info so the recording is
    self-describing on disk. The run directory must already exist (rosbag2
    creates it on start); writes to a temp file then renames.
    """
    path = session_path(data_dir, run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    tmp.replace(path)
    return path


def read_manifest(data_dir: str | Path, run_id: str) -> Manifest:
    """Read and validate the run's ``manifest.json``.

    Raises:
        ApiError: 404 if the manifest does not exist.
    """
    path = manifest_path(data_dir, run_id)
    if not path.exists():
        raise ApiError(
            status_code=404,
            code="manifest_not_found",
            message="No manifest for the requested run.",
            details={"run_id": run_id},
        )
    return Manifest.model_validate_json(path.read_text(encoding="utf-8"))


def read_failed_start_record(data_dir: str | Path, run_id: str) -> Manifest:
    """Read the failed-start record for *run_id* (the sibling ``.failed.json``).

    Raises:
        ApiError: 404 if no failed-start record exists.
    """
    path = failed_start_path(data_dir, run_id)
    if not path.exists():
        raise ApiError(
            status_code=404,
            code="failed_start_not_found",
            message="No failed-start record for the requested run.",
            details={"run_id": run_id},
        )
    return Manifest.model_validate_json(path.read_text(encoding="utf-8"))
