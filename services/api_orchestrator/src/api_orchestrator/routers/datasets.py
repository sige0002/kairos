"""Dataset endpoints (``/api/v1/datasets``) — logical sets, no directory tree.

Contract §6. A dataset is rows plus ledger events; adding a capture moves
nothing on disk. The browsable ``<operator>/<task>/<dataset>/NNN`` shape still
exists, but it is *generated* as symlinks under ``views/`` (see
``POST /api/v1/views/refresh``) rather than assembled by an export job.

Everything the v1 router did is gone and is listed in §10's retirement set:
``GET|DELETE /{operator}/{task}/{index}``, ``POST /index/rebuild``, and
``POST /export`` / ``export-all``. There is no compatibility alias — an export
that MOVED recordings is precisely the design v2 replaces, and answering the old
route with a new meaning would be worse than a 404.

``POST /{dataset_id}/archive`` (§6.x) is not that export coming back. The v1
export was a *move inside the store* that the catalog then forgot; the archive
is the capture archive's vocabulary — copy, verify, then remove — lifted to a
dataset, terminal by design, and recorded as ledger events that outlive the
database. What leaves is gone from here and the record of WHERE it went is
the point.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response, status

from kairos_common.archive_paths import parse_archive_roots

from api_orchestrator.dataset_archive import DatasetArchiver
from api_orchestrator.dataset_service import DatasetService
from api_orchestrator.deps import get_dataset_archiver, get_dataset_service
from api_orchestrator.models import (
    Dataset,
    DatasetArchiveProgress,
    DatasetArchiveRequest,
    DatasetCreateRequest,
    DatasetDetail,
    DatasetListResponse,
    DatasetMember,
    DatasetMemberCreateRequest,
    DatasetUpdateRequest,
)

router = APIRouter(prefix="/api/v1/datasets", tags=["datasets"])


@router.get("", response_model=DatasetListResponse)
async def list_datasets(
    service: DatasetService = Depends(get_dataset_service),
) -> DatasetListResponse:
    """Every dataset with its member count."""
    return DatasetListResponse(items=service.list())


@router.post("", response_model=Dataset, status_code=status.HTTP_201_CREATED)
async def create_dataset(
    body: DatasetCreateRequest,
    service: DatasetService = Depends(get_dataset_service),
) -> Dataset:
    """Create a dataset. Nothing is written under ``objects/``."""
    return service.create(name=body.name, operator=body.operator, task=body.task)


@router.get("/{dataset_id}", response_model=DatasetDetail)
async def get_dataset(
    dataset_id: str,
    service: DatasetService = Depends(get_dataset_service),
) -> DatasetDetail:
    """One dataset and its members, ordered by display_index."""
    return service.get(dataset_id)


@router.patch("/{dataset_id}", response_model=Dataset)
async def update_dataset(
    dataset_id: str,
    body: DatasetUpdateRequest,
    service: DatasetService = Depends(get_dataset_service),
) -> Dataset:
    """Edit the three labels (name / operator / task). Identity is dataset_id.

    Patch semantics: omitted keeps, explicit null clears (name cannot be
    cleared). The views/ tree follows, since the labels are its path. Refused
    once the dataset is no longer active — an archived dataset's labels are
    baked into the folder its run wrote.
    """
    return service.update(dataset_id, body)


@router.delete("/{dataset_id}", status_code=204)
async def delete_dataset(
    dataset_id: str,
    service: DatasetService = Depends(get_dataset_service),
) -> Response:
    """Delete a dataset and its memberships. No capture is touched."""
    service.delete(dataset_id)
    return Response(status_code=204)


@router.post(
    "/{dataset_id}/members",
    response_model=DatasetMember,
    status_code=status.HTTP_201_CREATED,
)
async def add_member(
    dataset_id: str,
    body: DatasetMemberCreateRequest,
    service: DatasetService = Depends(get_dataset_service),
) -> DatasetMember:
    """Add a capture, allocating the next never-before-issued display_index."""
    return service.add_member(dataset_id, body.capture_id)


@router.delete("/{dataset_id}/members/{membership_id}", status_code=204)
async def remove_member(
    dataset_id: str,
    membership_id: str,
    service: DatasetService = Depends(get_dataset_service),
) -> Response:
    """Remove one member. Its display_index stays retired forever (§6)."""
    service.remove_member(dataset_id, membership_id)
    return Response(status_code=204)


@router.post(
    "/{dataset_id}/archive",
    response_model=DatasetArchiveProgress,
    status_code=status.HTTP_202_ACCEPTED,
)
async def archive_dataset(
    dataset_id: str,
    body: DatasetArchiveRequest,
    request: Request,
    archiver: DatasetArchiver = Depends(get_dataset_archiver),
) -> DatasetArchiveProgress:
    """Freeze the dataset and start (or resume) copying it out (§6.x).

    202, not 200: a dataset is N captures and the copy runs in the
    background. By the time this returns, the member set is frozen in the
    ledger and the status is ``archiving``; poll the GET below for the rest.
    Destinations pass the same allow-list as a capture archive.
    """
    return await archiver.start(
        dataset_id,
        destination=body.destination,
        reason=body.reason,
        roots=parse_archive_roots(
            getattr(request.app.state.settings, "archive_roots", "")
        ),
    )


@router.get("/{dataset_id}/archive", response_model=DatasetArchiveProgress)
async def dataset_archive_progress(
    dataset_id: str,
    archiver: DatasetArchiver = Depends(get_dataset_archiver),
) -> DatasetArchiveProgress:
    """The run's progress — polled, so separate from ``GET /{dataset_id}``.

    The durable fields survive a restart; ``running``/``current_*``/``error``
    are this process's memory and honestly reset. ``archiving`` with
    ``running: false`` means "resumable" — the UI's Resume button.
    """
    return archiver.progress_for(dataset_id)
