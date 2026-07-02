"""topic_probe service entry point (OL-3.3).

Generic numeric-field live plotter. A SEPARATE ROS 2 service from the monitor /
recorder: it subscribes to ONE selected topic at a time, DECODES it, introspects
its numeric fields, and streams throttled samples to the UI. Decoding is isolated
here so a probe crash can never affect recording or the non-intrusive monitor.

The HTTP API (consumed by the frontend Probe tab via the nginx ``/probe/`` proxy):

- ``GET /topics``                          -> subscribable topics
- ``GET /fields?topic=<name>``             -> dotted numeric field paths
- ``GET /sample?topic=<name>&field=<p>``   -> one sample {topic, field, t, value}
- ``GET /stream?topic=<name>&field=<p>``   -> SSE stream of samples (throttled)
- ``GET /healthz`` / ``GET /readyz``       -> from kairos_common.create_app

Like topic_monitor, the rclpy subscriber is constructed eagerly but imports rclpy
lazily (inside ``start``), so this app imports and serves ``/healthz`` without ROS
installed; the live decode path is verified in Docker.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, Response
from fastapi.responses import StreamingResponse
from kairos_common import create_app, get_settings

from topic_probe.models import FieldsResponse, Sample, TopicsResponse
from topic_probe.probe import ProbeService
from topic_probe.subscriber import ProbeSubscriber

logger = logging.getLogger("kairos.topic_probe")

SERVICE_NAME = "topic_probe"

# Sampling cap. The UI never needs more than ~20 Hz on a plot; capping protects
# the event loop and keeps the SSE payload light regardless of publish rate.
_MAX_STREAM_HZ = 20.0
_DEFAULT_STREAM_HZ = 10.0


def _build_subscriber() -> ProbeSubscriber:
    """Build the rclpy-backed subscriber (its rclpy import is deferred to start)."""
    from topic_probe.ros_subscriber import RosProbeSubscriber

    return RosProbeSubscriber()


def create_probe_app(*, subscriber: ProbeSubscriber | None = None) -> FastAPI:
    """Build the topic_probe FastAPI app with the service and routes wired in.

    Args:
        subscriber: Optional injected :class:`ProbeSubscriber` (tests pass a
            ``FakeProbeSubscriber``); defaults to the rclpy-backed implementation.
    """
    settings = get_settings()
    sub = subscriber if subscriber is not None else _build_subscriber()
    service = ProbeService(sub)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        def _start() -> None:
            try:
                service.start()
            except Exception:  # noqa: BLE001 - ROS may be absent; stay live
                logger.exception("failed to start probe subscriber")

        await asyncio.to_thread(_start)
        try:
            yield
        finally:
            await asyncio.to_thread(service.stop)

    app = create_app(SERVICE_NAME, settings=settings)
    app.router.lifespan_context = lifespan
    app.state.probe = service

    # Replace create_app's always-ready /readyz with a subscriber-aware one
    # (Starlette matches the first registered route, so drop the default first).
    app.router.routes = [
        route
        for route in app.router.routes
        if getattr(route, "path", None) != "/readyz"
    ]

    @app.get("/")
    async def root() -> dict[str, str]:
        return {"service": SERVICE_NAME, "stage": "ol-3.3"}

    @app.get("/topics", response_model=TopicsResponse)
    async def topics() -> TopicsResponse:
        return await asyncio.to_thread(service.topics)

    @app.get("/fields", response_model=FieldsResponse)
    async def fields(topic: str = Query(..., min_length=1)) -> FieldsResponse:
        return await asyncio.to_thread(service.fields, topic)

    @app.get("/sample", response_model=Sample)
    async def sample(
        topic: str = Query(..., min_length=1),
        field: str = Query(..., min_length=1),
    ) -> Sample:
        # One-shot: subscribe transiently, wait for a message, sample, release.
        return await asyncio.to_thread(service.sample_blocking, topic, field)

    @app.get("/stream")
    async def stream(
        topic: str = Query(..., min_length=1),
        fields: str | None = Query(None, description="comma-separated field paths"),
        field: str | None = Query(None, min_length=1),
        hz: float = Query(_DEFAULT_STREAM_HZ, gt=0, le=_MAX_STREAM_HZ),
    ) -> StreamingResponse:
        # `fields=a,b,c` overlays several fields of one topic in each SSE frame;
        # `field=` (single) is kept for back-compat. The frontend opens one stream
        # per topic, so cross-topic overlay = several concurrent streams.
        field_list = _parse_fields(fields, field)
        interval = 1.0 / min(hz, _MAX_STREAM_HZ)
        return StreamingResponse(
            _multi_sample_sse(service, topic, field_list, interval),
            media_type="text/event-stream",
        )

    @app.get("/readyz", tags=["health"])
    async def readyz(response: Response) -> dict[str, str]:
        if not service.is_ready():
            response.status_code = 503
            return {"status": "not_ready"}
        return {"status": "ready"}

    return app


def _parse_fields(fields: str | None, field: str | None) -> list[str]:
    """Resolve the field list from `fields=a,b,c` (overlay) or `field=` (single)."""
    if fields:
        return [f.strip() for f in fields.split(",") if f.strip()]
    if field:
        return [field]
    return []


async def _multi_sample_sse(
    service: ProbeService, topic: str, fields: list[str], interval: float
) -> AsyncIterator[str]:
    """Yield throttled ``{topic, t, values}`` SSE frames for *fields* of *topic*.

    Holds a (ref-counted) subscription for the connection's lifetime and samples
    the latest decoded message off the event loop each tick; releases it on
    disconnect. Cross-topic overlay = several of these streams in parallel.

    The subscribe runs INSIDE the try so a disconnect after it bumped the
    ref-count still reaches the finally and releases it — with subscribe outside
    the try, a client that dropped right after subscribing would leak the
    subscription permanently. ``subscribed`` gates the release so an early cancel
    that never took the reference does not decrement another stream's count.
    """
    subscribed = False
    try:
        await asyncio.to_thread(service.subscribe, topic)
        subscribed = True
        while True:
            sample = await asyncio.to_thread(service.sample_many, topic, fields)
            yield f"data: {json.dumps(sample.model_dump())}\n\n"
            await asyncio.sleep(interval)
    finally:
        if subscribed:
            await asyncio.to_thread(service.unsubscribe, topic)


app = create_probe_app()


def main() -> None:
    """Run the service with uvicorn, binding host/port from config."""
    import uvicorn

    settings = get_settings()
    uvicorn.run(app, host=settings.bind_host, port=settings.topic_probe_port)


if __name__ == "__main__":
    main()
