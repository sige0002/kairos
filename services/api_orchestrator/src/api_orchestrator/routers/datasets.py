"""Dataset endpoints (``/api/v1/datasets``).

The dataset tree lives under ``data_dir`` as ``<operator>/<task>/<NNN>/`` with a
``dataset.json`` provenance sidecar (written by dora_runner's ``dataset_export``
pipeline). These endpoints:

- ``GET  /api/v1/datasets`` — browse the exported datasets (scan the tree).
- ``POST /api/v1/datasets/export`` — export ONE completed run: run the
  ``dataset_export`` pipeline (a MOVE) to completion, then delete the run row.
- ``POST /api/v1/datasets/export-all`` — export EVERY completed run with files,
  collecting per-run successes/failures (one failure never aborts the batch).

Export MOVES the recording out of ``recorded/`` and the run row is deleted only
AFTER a confirmed successful export, so a recording is never lost: on failure
the run stays in ``recorded/`` and in the Recordings list.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Request
from kairos_common import ApiError, JobState
from pydantic import BaseModel

from api_orchestrator.deps import get_run_service
from api_orchestrator.models import RunState
from api_orchestrator.runs import RunService

router = APIRouter(prefix="/api/v1/datasets", tags=["datasets"])

# Top-level dirs under data_dir that are NOT operators (they hold staging /
# reports), so the dataset scan must skip them.
_RESERVED_TOP = {"recorded", "report", "datasets"}


class DatasetExportRequest(BaseModel):
    """Body of ``POST /api/v1/datasets/export`` — one run to export."""

    run_id: str


def _read_dataset_json(path: Path) -> dict[str, Any] | None:
    """Best-effort read of a ``dataset.json`` sidecar (``None`` on any failure)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _scan_datasets(data_dir: Path) -> list[dict[str, Any]]:
    """Scan ``data_dir`` for ``<operator>/<task>/<NNN>/dataset.json`` entries.

    Reads ONLY under ``data_dir`` (no request-supplied path is ever joined in),
    skipping the reserved top-level dirs. Each ``dataset.json`` is read
    best-effort; missing/unreadable ones still surface a minimal entry from the
    path itself, so an operator never loses sight of an exported directory.
    """
    out: list[dict[str, Any]] = []
    if not data_dir.is_dir():
        return out
    for operator_dir in data_dir.iterdir():
        if not operator_dir.is_dir() or operator_dir.name in _RESERVED_TOP:
            continue
        for task_dir in operator_dir.iterdir():
            if not task_dir.is_dir():
                continue
            for index_dir in task_dir.iterdir():
                if not index_dir.is_dir():
                    continue
                meta = _read_dataset_json(index_dir / "dataset.json")
                if meta is None:
                    continue
                out.append(
                    {
                        "operator": operator_dir.name,
                        "task": task_dir.name,
                        "index": index_dir.name,
                        "dataset_dir": str(index_dir),
                        "run_id": meta.get("run_id"),
                        "bytes": meta.get("bytes"),
                        "message_count": meta.get("message_count"),
                        "exported_at": meta.get("exported_at"),
                    }
                )
    out.sort(key=lambda d: (d["operator"], d["task"], d["index"]))
    return out


async def _export_one(
    service: RunService, dora_client: Any, run_id: str
) -> dict[str, Any]:
    """Export one completed run (MOVE) then delete its row; return the summary.

    Validates the run is completed and has recorded files, runs the
    ``dataset_export`` pipeline to completion, and deletes the run row ONLY on a
    confirmed success. Raises :class:`ApiError` on any precondition or export
    failure (the run is left untouched in ``recorded/`` and in the list).
    """
    run = service.get(run_id)  # 404 if absent
    if run.state != RunState.completed:
        raise ApiError(
            status_code=409,
            code="run_not_completed",
            message="Only a completed recording can be exported to a dataset.",
            details={"run_id": run_id, "state": run.state.value},
        )
    if not (service.recorded_dir / run_id).is_dir():
        raise ApiError(
            status_code=409,
            code="no_recorded_files",
            message="The run has no recorded files to export (already exported?).",
            details={"run_id": run_id},
        )

    res = await dora_client.run_job_to_completion(
        {"pipeline": "dataset_export", "run_id": run_id, "params": {}}
    )
    if res.get("state") != JobState.succeeded.value:
        raise ApiError(
            status_code=502,
            code="export_failed",
            message="The dataset_export job did not succeed.",
            details={"run_id": run_id, "job_state": res.get("state")},
        )
    # Success confirmed: the recording has been MOVED out of recorded/, so
    # delete the now-orphaned run row (its dir + siblings + report sidecars).
    service.delete(run_id)
    result = res.get("result") or {}
    return result.get("summary", {})


@router.get("")
async def list_datasets(request: Request) -> dict[str, Any]:
    """List exported datasets under ``data_dir`` (grouped client-side)."""
    data_dir = Path(request.app.state.settings.data_dir)
    return {"datasets": _scan_datasets(data_dir)}


@router.post("/export")
async def export_dataset(
    request: Request,
    body: DatasetExportRequest,
    service: RunService = Depends(get_run_service),
) -> dict[str, Any]:
    """Export ONE completed run into the dataset tree, then delete its row.

    Returns the export summary. 409 if the run is not completed / has no files,
    404 if unknown, 502 if the export job failed, 504 if it timed out (the run
    stays in ``recorded/`` and in the list in every failure case).
    """
    dora_client = request.app.state.dora_runner_client
    return await _export_one(service, dora_client, body.run_id)


@router.post("/export-all")
async def export_all_datasets(
    request: Request,
    service: RunService = Depends(get_run_service),
) -> dict[str, Any]:
    """Export every completed run that still has recorded files.

    Each run is exported (MOVE) and its row deleted only on success; one
    failure never aborts the batch. Returns
    ``{"exported": [summaries], "failed": [{run_id, error}], "total": N}``.
    """
    dora_client = request.app.state.dora_runner_client
    targets = service.list_completed_with_files()
    exported: list[dict[str, Any]] = []
    failed: list[dict[str, str]] = []
    for run in targets:
        try:
            summary = await _export_one(service, dora_client, run.run_id)
            exported.append(summary)
        except ApiError as exc:
            failed.append({"run_id": run.run_id, "error": exc.message})
        except Exception as exc:  # noqa: BLE001 - one bad run must not abort all.
            failed.append({"run_id": run.run_id, "error": str(exc)})
    return {"exported": exported, "failed": failed, "total": len(targets)}
