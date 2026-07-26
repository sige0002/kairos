"""Import endpoints (``/api/v1/imports``) — bring an external rosbag into Review.

A recording made outside kairos (plain ``ros2 bag record -s mcap``, an archived
experiment, a colleague's bag) becomes a first-class run: it lands in
``recorded/<run_id>/`` with a synthesized ``session.json`` and gets a ``runs``
row, after which Review, validation and export treat it exactly like a
recording made here.

- ``POST /imports`` validates the source SYNCHRONOUSLY (so a bad path is a
  useful 400 straight away, not a job that fails a minute later) and then
  queues the copy, which may be many GB. Returns 202 with an ``import_id``.
- ``GET /imports`` / ``GET /imports/{id}`` report progress. This is job status
  held in memory — the durable outcome is the run row and the bag on disk.

Ordering guarantee: the run row appears only after the staged copy has been
atomic-renamed into ``recorded/<run_id>``, so a run visible in Review is a run
whose bag is complete. See ``bag_import`` for the reasoning behind that and
behind requiring ``metadata.yaml``.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from kairos_common.errors import ApiError
from kairos_common.time import utc_now_iso8601
from pydantic import BaseModel, Field

from api_orchestrator import bag_import
from api_orchestrator.models import Run, RunState, RunTopic
from api_orchestrator.store import RunExistsError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/imports", tags=["imports"])

# Strong refs to in-flight import tasks: asyncio only holds weak ones, so
# without this the GC may cancel a multi-GB copy mid-flight.
_import_tasks: set[asyncio.Task[None]] = set()


class ImportRequest(BaseModel):
    """Body for ``POST /api/v1/imports``.

    ``source_path`` is a path on the SERVER (these bags are multi-GB; there is
    no browser upload). ``move`` defaults to false — the operator's source data
    is never destroyed unless they ask for it, and even then only after the
    import has fully succeeded.
    """

    source_path: str = Field(min_length=1)
    move: bool = False


def _registry(request: Request) -> bag_import.ImportRegistry:
    return request.app.state.import_registry


@router.post("", status_code=202)
async def start_import(request: Request, body: ImportRequest) -> dict[str, Any]:
    """Validate a bag directory and queue its import; 202 with the import id."""
    service = request.app.state.run_service
    store = request.app.state.run_store
    recorded_dir = Path(service.recorded_dir)

    source = Path(body.source_path).expanduser()
    try:
        source = source.resolve(strict=False)
    except OSError as exc:  # pragma: no cover - exotic FS failure
        raise ApiError(
            status_code=400,
            code="import_source_unresolvable",
            message=f"Could not resolve {body.source_path}: {exc}",
        ) from exc

    # Synchronous validation: cheap (a YAML parse + an MCAP footer read) and it
    # is the difference between "that path has no metadata.yaml, run reindex"
    # now and a mystery failure after a 20-minute copy.
    bag = await asyncio.to_thread(
        bag_import.inspect_source, source, recorded_dir=recorded_dir
    )

    run_id = bag_import.unique_run_id(
        recorded_dir, lambda rid: store.get(rid) is not None
    )
    record = _registry(request).create(
        source_path=str(source), run_id=run_id, move=body.move, bytes_total=bag.bytes
    )

    task = asyncio.create_task(_run_import(request, bag, record, recorded_dir, store))
    _import_tasks.add(task)
    task.add_done_callback(_import_tasks.discard)

    return {
        "queued": True,
        **record.to_dict(),
        "topics": len(bag.topics),
        "message_count": bag.message_count,
    }


async def _run_import(
    request: Request,
    bag: bag_import.SourceBag,
    record: bag_import.ImportRecord,
    recorded_dir: Path,
    store: Any,
) -> None:
    """Copy, finalize, then create the run row. Never destroys the source early."""
    staging = recorded_dir / bag_import.INCOMING_DIRNAME / record.run_id
    final = recorded_dir / record.run_id
    try:
        # 1. Copy into staging. Nothing is visible at the final path yet, so a
        #    crash here leaves no run that looks complete.
        copied = await asyncio.to_thread(bag_import.copy_into_staging, bag, staging)
        record.bytes_copied = copied

        # 2. Synthesize session.json INSIDE staging, so it arrives with the
        #    rename rather than appearing a moment later.
        await asyncio.to_thread(
            bag_import.write_session,
            staging,
            bag_import.session_payload(bag, record.run_id, moved=record.move),
        )

        # 3. The atomic instant: the run becomes real here and not before.
        await asyncio.to_thread(bag_import.finalize, staging, final)

        # 4. Row last — a row without its bag would be a run every other
        #    lifecycle path has to special-case.
        _create_run_row(store, record.run_id, bag)

        # 5. Only now may the source go, and only if asked — and only the
        #    files we actually imported. The copy takes top-level FILES only
        #    (nested dirs are deliberately not smuggled in), so a recursive
        #    delete here would destroy an operator's `notes/` or `videos/`
        #    sitting beside the bag: data that was never imported and now
        #    exists nowhere. Remove the copied files, then rmdir — which
        #    refuses a directory that still holds anything.
        if record.move:
            await asyncio.to_thread(bag_import.remove_moved_source, bag)

        record.state = "succeeded"
        record.finished_at = utc_now_iso8601()
        logger.info(
            "bag imported",
            extra={"run_id": record.run_id, "source": record.source_path},
        )
    except Exception as exc:  # noqa: BLE001 - any failure must land in the record
        record.state = "failed"
        record.finished_at = utc_now_iso8601()
        if isinstance(exc, ApiError):
            record.error_code, record.error_message = exc.code, exc.message
        else:
            record.error_code = "import_failed"
            record.error_message = str(exc) or exc.__class__.__name__
        # Leave nothing half-imported; the source is untouched either way.
        await asyncio.to_thread(shutil.rmtree, staging, True)
        logger.warning(
            "bag import failed",
            extra={
                "run_id": record.run_id,
                "source": record.source_path,
                "error": record.error_code,
            },
        )


def _create_run_row(store: Any, run_id: str, bag: bag_import.SourceBag) -> None:
    """Insert the imported run as a completed run.

    ``completed`` is the honest state: the recording is over and its bag is
    whole. ``operator``/``task`` stay null — the two things an external bag
    cannot tell us, filled in from Review rather than invented here.
    """
    run = Run(
        run_id=run_id,
        state=RunState.completed,
        started_at=bag.started_at,
        ended_at=bag.ended_at,
        topics=[RunTopic(name=name, type=type_) for name, type_ in bag.topics],
        message_count=bag.message_count,
        bytes=bag.bytes,
    )
    try:
        store.create(run)
    except RunExistsError as exc:  # pragma: no cover - id was checked free
        raise ApiError(
            status_code=409,
            code="run_id_unavailable",
            message=f"run_id {run_id} was taken while the import was copying.",
        ) from exc


@router.get("")
async def list_imports(request: Request) -> dict[str, Any]:
    """Every import this process has run (newest last)."""
    return {"imports": [rec.to_dict() for rec in _registry(request).list()]}


@router.get("/{import_id}")
async def get_import(request: Request, import_id: str) -> dict[str, Any]:
    """One import's status."""
    return _registry(request).get(import_id).to_dict()
