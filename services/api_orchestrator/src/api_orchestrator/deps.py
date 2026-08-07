"""FastAPI dependencies for the capture-store routers.

The services are built once at startup and held on ``app.state``; handlers
resolve them here so they stay thin and easy to test with an injected app.
"""

from __future__ import annotations

from fastapi import Request

from api_orchestrator.captures import CaptureService
from api_orchestrator.dataset_archive import DatasetArchiver
from api_orchestrator.dataset_service import DatasetService
from api_orchestrator.record_service import RecordService
from api_orchestrator.store import CaptureStore


def get_record_service(request: Request) -> RecordService:
    """The recording lifecycle service (prepare/start/stop/status)."""
    return request.app.state.record_service


def get_capture_service(request: Request) -> CaptureService:
    """The capture service (review, delete, archive, retention)."""
    return request.app.state.capture_service


def get_dataset_service(request: Request) -> DatasetService:
    """The logical-dataset service."""
    return request.app.state.dataset_service


def get_dataset_archiver(request: Request) -> DatasetArchiver:
    """The dataset archive runner (§6.x): start, resume, progress."""
    return request.app.state.dataset_archiver


def get_store(request: Request) -> CaptureStore:
    """The v2 catalog itself, for the few routers that read it directly."""
    return request.app.state.capture_store
