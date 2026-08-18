# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Pipeline registry proxy endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

router = APIRouter(prefix="/api/v1", tags=["pipelines"])


@router.get("/pipelines")
async def list_pipelines(request: Request) -> dict[str, Any]:
    """Proxy available pipelines from dora_runner."""
    return await request.app.state.dora_runner_client.pipelines()
