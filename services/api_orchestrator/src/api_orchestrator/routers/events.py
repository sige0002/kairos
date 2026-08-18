# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Aggregated SSE endpoint (``GET /api/v1/events``).

Streams the multiplexed event feed from the :class:`~api_orchestrator.events.
EventHub`. Honors ``Last-Event-ID`` (header, or ``?last_event_id`` query
fallback) for replay/resync, and emits periodic heartbeat comments so idle
connections and proxies stay open.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import StreamingResponse

from api_orchestrator.events import EventHub, encode_comment

router = APIRouter(prefix="/api/v1", tags=["events"])

# How often to emit an SSE keep-alive comment when idle (seconds).
HEARTBEAT_S = 15.0


def _get_hub(request: Request) -> EventHub:
    return request.app.state.event_hub


def _parse_last_event_id(header: str | None, query: int | None) -> int | None:
    """Resolve the resume position from the header (preferred) or query."""
    if header is not None:
        try:
            return int(header)
        except ValueError:
            return None
    return query


@router.get("/events")
async def events(
    request: Request,
    last_event_id_header: str | None = Header(default=None, alias="Last-Event-ID"),
    last_event_id: int | None = Query(default=None),
) -> StreamingResponse:
    """Open the aggregated SSE stream (record_status / metrics / alert / job)."""
    hub = _get_hub(request)
    resume_from = _parse_last_event_id(last_event_id_header, last_event_id)

    async def stream() -> AsyncIterator[str]:
        # Tell a fresh subscriber the CURRENT monitor-bridge state up front —
        # transitions are only published when they happen, so a client that
        # connects while the robot is already off would otherwise never learn.
        # No ``id:`` line: this is per-connection state, not a ring event.
        status = hub.monitor_status
        if status is not None:
            payload = json.dumps({"monitor": status}, separators=(",", ":"))
            yield f"event: bridge\ndata: {payload}\n\n"
        subscription = hub.subscribe(resume_from)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(
                        subscription.__anext__(), timeout=HEARTBEAT_S
                    )
                except TimeoutError:
                    # No event within the heartbeat window: keep the line open.
                    if await request.is_disconnected():
                        break
                    yield encode_comment("keep-alive")
                    continue
                except StopAsyncIteration:
                    break
                if await request.is_disconnected():
                    break
                yield event.encode()
        finally:
            with contextlib.suppress(Exception):
                await subscription.aclose()

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",  # disable proxy buffering for SSE
    }
    return StreamingResponse(stream(), media_type="text/event-stream", headers=headers)
