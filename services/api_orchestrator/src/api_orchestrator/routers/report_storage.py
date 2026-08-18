# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Preview and clear generated reports without accepting filesystem paths."""

from __future__ import annotations

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from api_orchestrator.report_storage import (
    ReportCleanupCriteria,
    ReportCleanupResult,
    ReportStoragePreview,
)

router = APIRouter(prefix="/api/v1/report-storage", tags=["report-storage"])


@router.post("/preview", response_model=ReportStoragePreview)
async def preview_report_cleanup(
    request: Request, criteria: ReportCleanupCriteria
) -> ReportStoragePreview:
    """Measure the currently matching report units and their visible impact."""
    return await run_in_threadpool(
        request.app.state.report_storage_service.preview, criteria
    )


@router.post("/cleanup", response_model=ReportCleanupResult)
async def cleanup_reports(
    request: Request, criteria: ReportCleanupCriteria
) -> ReportCleanupResult:
    """Re-scan and remove matching units under per-capture writer leases."""
    return await run_in_threadpool(
        request.app.state.report_storage_service.cleanup, criteria
    )
