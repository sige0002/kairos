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
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status

from api_orchestrator.dataset_service import DatasetService
from api_orchestrator.deps import get_dataset_service
from api_orchestrator.models import (
    Dataset,
    DatasetCreateRequest,
    DatasetDetail,
    DatasetListResponse,
    DatasetMember,
    DatasetMemberCreateRequest,
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
