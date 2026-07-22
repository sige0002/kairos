"""Live extension-event proxy (``/api/v1/live/events``).

The dora_live control sidecar keeps a ring of freeform analysis events that
extension sidecars POST (``/internal/analysis/events`` -> ``/live/events``).
This route makes them reachable through the single public API so the frontend
renders them with ZERO extension-author work — the same UI-independence
contract the validation lane's ``params_schema``/SummaryResult already follows.

Graceful absence: the legacy monitor (LIVE=0) has no ``/live/events``, so a
404 — or the monitor being down entirely — degrades to
``{"available": false, "events": []}`` instead of an error; the UI hides the
section. ``available: true`` means the live backend answered (even with an
empty ring).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request
from kairos_common import ApiError

from api_orchestrator.monitor_client import MonitorClient

router = APIRouter(prefix="/api/v1/live", tags=["live"])


def _get_monitor(request: Request) -> MonitorClient:
    return request.app.state.monitor_client


@router.get("/events")
async def live_events(
    request: Request, since: float = Query(0.0, ge=0.0)
) -> dict[str, Any]:
    """Proxy the live backend's extension-event ring (absent -> available=false).

    ONLY a 404 means "the surface does not exist" (legacy monitor). Anything
    else — a genuine dora_live 5xx, the monitor unreachable — re-raises so a
    BROKEN live backend surfaces as an error instead of masquerading as
    "no surface" (adversarial-review finding).
    """
    try:
        data = await _get_monitor(request).live_events(since)
    except ApiError as exc:
        if exc.status_code == 404:
            return {"available": False, "events": []}
        raise
    return {"available": True, **data}
