"""topic_probe-compatible HTTP app served by dora_live (second port).

Same public contract as topic_probe (``/topics``, ``/fields``, ``/sample``,
``/stream`` SSE, ``/readyz``), so the nginx ``/probe/`` proxy switches
backends via env — no frontend change. Data comes from the probe dataflow
node through :class:`ProbeHub` instead of an rclpy subscription.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, Response
from fastapi.responses import StreamingResponse
from kairos_common import create_app, get_settings, utc_now_iso8601
from pydantic import BaseModel, Field

from dora_live.feed_subscriber import DoraFeedSubscriber
from dora_live.probe_state import ProbeHub

logger = logging.getLogger("kairos.dora_live.probe")

SERVICE_NAME = "dora_live_probe"

_MAX_STREAM_HZ = 20.0
_DEFAULT_STREAM_HZ = 10.0
_FIELDS_TIMEOUT_S = 5.0
_SAMPLE_TIMEOUT_S = 5.0


class TopicInfo(BaseModel):
    name: str
    type: str | None = None


class TopicsResponse(BaseModel):
    ts: str
    topics: list[TopicInfo] = Field(default_factory=list)


class FieldsResponse(BaseModel):
    ts: str
    topic: str
    type: str | None = None
    fields: list[str] = Field(default_factory=list)
    reason: str | None = None


class Sample(BaseModel):
    topic: str
    field: str
    t: float
    value: float | None = None


def create_probe_compat_app(
    *,
    hub: ProbeHub,
    feed: DoraFeedSubscriber,
    dataflow_alive: Callable[[], bool] = lambda: True,
) -> FastAPI:
    settings = get_settings()
    app = create_app(SERVICE_NAME, settings=settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield

    app.router.lifespan_context = lifespan
    app.router.routes = [
        route
        for route in app.router.routes
        if getattr(route, "path", None) != "/readyz"
    ]

    def _topic_type(topic: str) -> str | None:
        for entry in feed.discover_topics():
            if entry.name == topic:
                return entry.type
        return None

    @app.get("/")
    async def root() -> dict[str, str]:
        return {"service": SERVICE_NAME, "stage": "live"}

    @app.get("/topics", response_model=TopicsResponse)
    async def topics() -> TopicsResponse:
        entries = feed.discover_topics()
        return TopicsResponse(
            ts=utc_now_iso8601(),
            topics=[TopicInfo(name=e.name, type=e.type) for e in entries],
        )

    @app.get("/fields", response_model=FieldsResponse)
    async def fields(topic: str = Query(..., min_length=1)) -> FieldsResponse:
        hub.request_introspect(topic)
        got = await asyncio.to_thread(hub.wait_for_fields, topic, _FIELDS_TIMEOUT_S)
        if got is None:
            return FieldsResponse(
                ts=utc_now_iso8601(),
                topic=topic,
                type=_topic_type(topic),
                reason="no message received in time (topic silent or not bridged)",
            )
        field_list, reason = got
        return FieldsResponse(
            ts=utc_now_iso8601(),
            topic=topic,
            type=_topic_type(topic),
            fields=field_list,
            reason=reason,
        )

    @app.get("/sample", response_model=Sample)
    async def sample(
        topic: str = Query(..., min_length=1),
        field: str = Query(..., min_length=1),
    ) -> Sample:
        hub.acquire(topic, [field])
        try:
            latest = await asyncio.to_thread(hub.wait_for, topic, _SAMPLE_TIMEOUT_S)
        finally:
            hub.release(topic, [field])
        if latest is None:
            return Sample(topic=topic, field=field, t=0.0, value=None)
        return Sample(
            topic=topic,
            field=field,
            t=latest["t"],
            value=latest["values"].get(field),
        )

    @app.get("/stream")
    async def stream(
        topic: str = Query(..., min_length=1),
        fields: str | None = Query(None),
        field: str | None = Query(None, min_length=1),
        hz: float = Query(_DEFAULT_STREAM_HZ, gt=0, le=_MAX_STREAM_HZ),
    ) -> StreamingResponse:
        field_list = _parse_fields(fields, field)
        interval = 1.0 / min(hz, _MAX_STREAM_HZ)
        return StreamingResponse(
            _stream_sse(hub, topic, field_list, interval),
            media_type="text/event-stream",
        )

    @app.get("/readyz", tags=["health"])
    async def readyz(response: Response) -> dict[str, str]:
        if not (feed.is_up() and dataflow_alive()):
            response.status_code = 503
            return {"status": "not_ready"}
        return {"status": "ready"}

    return app


def _parse_fields(fields: str | None, field: str | None) -> list[str]:
    if fields:
        return [f.strip() for f in fields.split(",") if f.strip()]
    if field:
        return [field]
    return []


async def _stream_sse(
    hub: ProbeHub, topic: str, field_list: list[str], interval: float
) -> AsyncIterator[str]:
    hub.acquire(topic, field_list)
    try:
        while True:
            latest = hub.latest(topic)
            if latest is not None:
                values = {f: latest["values"].get(f) for f in field_list}
                frame = {"topic": topic, "t": latest["t"], "values": values}
                yield f"data: {json.dumps(frame)}\n\n"
            await asyncio.sleep(interval)
    finally:
        hub.release(topic, field_list)
