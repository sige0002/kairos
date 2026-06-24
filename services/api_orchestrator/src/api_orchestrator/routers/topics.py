"""Topic discovery + live metrics proxy (``/api/v1/topics*``).

The orchestrator is the single public API; topic data originates in
topic_monitor. These endpoints proxy it:

- ``GET /api/v1/topics`` -> monitor ``GET /topics`` (discovery: name/type/
  publisher_count/subscriber_count/qos/last_seen).
- ``GET /api/v1/topics/status`` -> monitor ``GET /metrics`` (live snapshot).

Monitor failures surface as a unified ``503`` via the monitor client.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from api_orchestrator.monitor_client import MonitorClient

router = APIRouter(prefix="/api/v1/topics", tags=["topics"])


def _get_monitor(request: Request) -> MonitorClient:
    return request.app.state.monitor_client


@router.get("")
async def list_topics(request: Request) -> dict[str, Any]:
    """Proxy the monitor's ``GET /topics`` ROS 2 graph discovery."""
    return await _get_monitor(request).topics()


@router.get("/status")
async def topics_status(request: Request) -> dict[str, Any]:
    """Proxy the monitor's ``GET /metrics`` live snapshot."""
    return await _get_monitor(request).metrics()
