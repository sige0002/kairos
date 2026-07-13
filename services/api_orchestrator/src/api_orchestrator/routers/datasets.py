"""Dataset endpoints (``/api/v1/datasets``).

The dataset tree lives under ``data_dir`` as ``<operator>/<task>/<NNN>/`` with a
``dataset.json`` provenance sidecar (written by dora_runner's ``dataset_export``
pipeline). These endpoints:

- ``GET  /api/v1/datasets`` — browse the exported datasets (scan the tree).
- ``GET  /api/v1/datasets/{operator}/{task}/{index}`` — inspect ONE exported
  dataset (sidecars + surviving run-keyed reports), the post-export
  counterpart of ``GET /runs/{id}``.
- ``POST /api/v1/datasets/export`` — export ONE completed run: run the
  ``dataset_export`` pipeline (a MOVE) to completion, then delete the run row.
- ``POST /api/v1/datasets/export-all`` — export EVERY completed run with files,
  collecting per-run successes/failures (one failure never aborts the batch).

Export MOVES the recording out of ``recorded/`` and the run row is deleted only
AFTER a confirmed successful export, so a recording is never lost: on failure
the run stays in ``recorded/`` and in the Recordings list. The run's report
sidecars (validation / loss / video_check artifacts) are deliberately KEPT on
export so the dataset detail view can keep showing them.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Request
from kairos_common import ApiError, JobState
from pydantic import BaseModel

from api_orchestrator.deps import get_run_service
from api_orchestrator.models import DatasetDetail, RunState, RunTopic, TopicQos
from api_orchestrator.runs import RunService

router = APIRouter(prefix="/api/v1/datasets", tags=["datasets"])

# Top-level dirs under data_dir that are NOT operators (they hold staging /
# reports), so the dataset scan must skip them.
_RESERVED_TOP = {"recorded", "report", "datasets"}

# A dataset path component (operator / task / index) must be a plain single
# directory name: no separators, no traversal, no NUL. Mirrors dora_runner's
# _sanitize_component output charset guard.
_COMPONENT_RE = re.compile(r"^[^/\\\x00]+$")

# A run_id read from dataset.json is joined into data/report/<pipeline>/<run_id>;
# guard its charset (mirrors the recorder's RUN_ID_PATTERN) before any join.
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


class DatasetExportRequest(BaseModel):
    """Body of ``POST /api/v1/datasets/export`` — one run to export."""

    run_id: str


def _job_failure_reason(res: dict[str, Any]) -> str | None:
    """Best-effort human cause from a failed ``run_job_to_completion`` result.

    dora_runner nests its ApiError under ``result.summary.error`` (sometimes
    double-wrapped as ``error.error``); fall back to a plain string error or a
    ``note``/``message`` on the summary. ``None`` when nothing usable is found.
    """
    result = res.get("result")
    if not isinstance(result, dict):
        return None
    summary = result.get("summary")
    if not isinstance(summary, dict):
        return None
    err = summary.get("error")
    if isinstance(err, dict):
        inner = err.get("error") if isinstance(err.get("error"), dict) else err
        message = inner.get("message") or err.get("message")
        code = inner.get("code") or err.get("code")
        if message:
            return f"{message} ({code})" if code else str(message)
    elif isinstance(err, str) and err.strip():
        return err
    note = summary.get("note") or summary.get("message")
    return note if isinstance(note, str) and note.strip() else None


def _read_json(path: Path) -> dict[str, Any] | None:
    """Best-effort read of a JSON sidecar (``None`` on any failure)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _validate_component(value: str, field: str) -> str:
    """Ensure a dataset path segment is a plain directory name, else 400.

    ``operator``/``task``/``index`` are joined under ``data_dir``; this guard
    (plus the reserved-top check at the call site) keeps a crafted URL from
    escaping the dataset tree.
    """
    if not value or value in {".", ".."} or not _COMPONENT_RE.match(value):
        raise ApiError(
            status_code=400,
            code="invalid_dataset_path",
            message=f"Invalid dataset path component: {field}",
            details={field: value},
        )
    return value


def _dataset_topics(
    manifest: dict[str, Any] | None,
    session: dict[str, Any] | None,
    meta: dict[str, Any],
) -> list[RunTopic]:
    """Topic list for the dataset detail view.

    Prefers ``manifest.json`` (name + resolved type + QoS, same source the run
    row was synced from); falls back to the name-only lists in ``session.json``
    / ``dataset.json`` (type ``""``), so a dataset with a lost manifest still
    shows its topics.
    """
    raw = (manifest or {}).get("topics")
    if isinstance(raw, list):
        topics: list[RunTopic] = []
        for entry in raw:
            if not (isinstance(entry, dict) and entry.get("name")):
                continue
            qos = entry.get("qos")
            try:
                parsed_qos = TopicQos.model_validate(qos) if qos else None
            except ValueError:
                parsed_qos = None
            topics.append(
                RunTopic(
                    name=str(entry["name"]),
                    type=str(entry.get("type") or ""),
                    qos=parsed_qos,
                )
            )
        if topics:
            return topics
    names = (session or {}).get("topics") or meta.get("topics") or []
    if not isinstance(names, list):
        return []
    return [RunTopic(name=n, type="") for n in names if isinstance(n, str) and n]


def _opt_str(value: Any) -> str | None:
    """Coerce a best-effort sidecar field to ``str | None`` (never 500)."""
    return value if isinstance(value, str) else None


def _run_report(data_dir: Path, run_id: str | None, pipeline: str) -> dict | None:
    """Best-effort read of a run-keyed report summary that survived export."""
    if not (isinstance(run_id, str) and _RUN_ID_RE.match(run_id)):
        return None
    return _read_json(data_dir / "report" / pipeline / run_id / "summary.json")


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
                meta = _read_json(index_dir / "dataset.json")
                if meta is None:
                    continue
                row = {
                    "operator": operator_dir.name,
                    "task": task_dir.name,
                    "index": index_dir.name,
                    "dataset_dir": str(index_dir),
                    "run_id": meta.get("run_id"),
                    "bytes": meta.get("bytes"),
                    "message_count": meta.get("message_count"),
                    "exported_at": meta.get("exported_at"),
                }
                # Cheap episode-label subset for cards (mirrors the per-row
                # dataset.json read). Absent episode.json -> keys stay null.
                episode = _read_json(index_dir / "episode.json") or {}
                for key in (
                    "task_result",
                    "quality",
                    "review_status",
                    "batch_seq",
                    "index_in_batch",
                ):
                    row[key] = episode.get(key)
                out.append(row)
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
        reason = _job_failure_reason(res)
        details: dict[str, Any] = {"run_id": run_id, "job_state": res.get("state")}
        if reason:
            details["reason"] = reason
        raise ApiError(
            status_code=502,
            code="export_failed",
            message=(
                f"The dataset_export job did not succeed: {reason}"
                if reason
                else "The dataset_export job did not succeed."
            ),
            details=details,
        )
    result = res.get("result") or {}
    summary = result.get("summary", {})
    # Persist the run's episode labels next to dataset.json BEFORE deleting the
    # run row (delete cascades the episode). No episode -> no sidecar written.
    dataset_dir = summary.get("dataset_dir")
    if isinstance(dataset_dir, str) and dataset_dir:
        service.write_episode_sidecar(run_id, dataset_dir)
    # Success confirmed: the recording has been MOVED out of recorded/, so
    # delete the now-orphaned run row (its dir + siblings). The report
    # sidecars (validation / loss / video_check mp4 cache) are KEPT: they stay
    # keyed by run_id and back the dataset detail view after export.
    service.delete(run_id, keep_reports=True)
    return summary


@router.get("")
async def list_datasets(request: Request) -> dict[str, Any]:
    """List exported datasets under ``data_dir`` (grouped client-side)."""
    data_dir = Path(request.app.state.settings.data_dir)
    return {"datasets": _scan_datasets(data_dir)}


@router.get("/{operator}/{task}/{index}", response_model=DatasetDetail)
async def dataset_detail(
    request: Request, operator: str, task: str, index: str
) -> DatasetDetail:
    """Inspect one exported dataset — the post-export ``GET /runs/{id}``.

    Reads the ``<operator>/<task>/<index>`` directory's sidecars
    (``dataset.json`` required — same rule as the list scan — plus
    ``session.json`` / ``manifest.json`` best-effort) and the run-keyed report
    summaries that survived export (validation / loss). 404 when the directory
    or its ``dataset.json`` is missing, 400 on an unsafe path component.
    """
    data_dir = Path(request.app.state.settings.data_dir)
    _validate_component(operator, "operator")
    _validate_component(task, "task")
    _validate_component(index, "index")
    if operator in _RESERVED_TOP:
        raise ApiError(
            status_code=400,
            code="invalid_dataset_path",
            message=f"Not a dataset operator directory: {operator}",
            details={"operator": operator},
        )
    dataset_dir = data_dir / operator / task / index
    meta = _read_json(dataset_dir / "dataset.json")
    if not dataset_dir.is_dir() or meta is None:
        raise ApiError(
            status_code=404,
            code="dataset_not_found",
            message=f"No exported dataset at {operator}/{task}/{index}.",
            details={"operator": operator, "task": task, "index": index},
        )
    session = _read_json(dataset_dir / "session.json")
    manifest = _read_json(dataset_dir / "manifest.json")
    run_id = meta.get("run_id")
    files = meta.get("files")
    return DatasetDetail(
        operator=operator,
        task=task,
        index=index,
        path=f"{operator}/{task}/{index}",
        dataset_dir=str(dataset_dir),
        run_id=_opt_str(run_id),
        state=_opt_str((session or {}).get("state")),
        started_at=_opt_str((session or {}).get("started_at")),
        ended_at=_opt_str((session or {}).get("ended_at")),
        exported_at=_opt_str(meta.get("exported_at")),
        bytes=meta.get("bytes"),
        message_count=meta.get("message_count"),
        files=[f for f in files if isinstance(f, str)]
        if isinstance(files, list)
        else [],
        topics=_dataset_topics(manifest, session, meta),
        manifest=manifest,
        dataset=meta,
        # Episode labels persisted at export (task_result / quality /
        # review_status + batch context); null when the run had no episode.
        episode=_read_json(dataset_dir / "episode.json"),
        validation=_run_report(data_dir, run_id, "fast_validation"),
        loss=_run_report(data_dir, run_id, "loss_report"),
    )


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
