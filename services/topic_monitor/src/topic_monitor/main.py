"""topic_monitor service entry point (Stage 2).

Lightweight, non-destructive ROS 2 topic monitoring. This module wires the
monitoring service (:mod:`topic_monitor.monitor`) — which owns the rclpy
subscriber, the windowed-metric registry, and the alert engine — to the HTTP API
the spec defines (``/topics``, ``/metrics`` + SSE, pause/resume, ``/alerts``).
Cross-cutting plumbing (health, error shape, CORS, logging) comes from
``kairos_common.create_app``. See ``docs/specs/ja/topic_monitor.md``.

The rclpy subscriber is constructed eagerly but imports rclpy lazily (inside its
``start``), so this app imports and serves ``/healthz`` without ROS installed;
the live subscribe path is verified in Docker. The subscriber is started on app
startup and stopped on shutdown.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, Response
from fastapi.responses import StreamingResponse
from kairos_common import (
    RecordingConfig,
    create_app,
    get_settings,
    load_recording_config,
    resolve_config_path,
    utc_now_iso8601,
)
from pydantic import BaseModel

from topic_monitor.alert_config import load_alert_rules, load_derived_config
from topic_monitor.models import (
    AlertsResponse,
    IncidentsResponse,
    MetricsSnapshot,
    PauseResponse,
    TopicsResponse,
)
from topic_monitor.monitor import MonitorService
from topic_monitor.ros_subscriber import RosTopicSubscriber
from topic_monitor.subscriber import TopicSubscriber

logger = logging.getLogger("kairos.topic_monitor")

SERVICE_NAME = "topic_monitor"

# Interval between snapshot pushes on the SSE streams (periodic, not diff).
_STREAM_INTERVAL_S = 1.0


def _load_config(recording_config_path: str) -> RecordingConfig | None:
    """Load the RECORDING_CONFIG, tolerating its absence.

    The allowlist (``default_topics``), ``expected_hz`` and QoS overrides come
    from this file. If it is missing or invalid the monitor still boots (with no
    topics seeded), so we log and continue rather than refusing to start.
    """
    try:
        return load_recording_config(recording_config_path)
    except (FileNotFoundError, ValueError) as exc:
        logger.warning("recording config unavailable: %s", exc)
        return None


def _build_subscriber(config: RecordingConfig | None) -> TopicSubscriber:
    """Build the rclpy-backed subscriber over the config allowlist."""
    allowlist = list(config.default_topics) if config is not None else []
    return RosTopicSubscriber(allowlist, config=config)


def create_monitor_app(*, subscriber: TopicSubscriber | None = None) -> FastAPI:
    """Build the topic_monitor FastAPI app with the service and routes wired in.

    Args:
        subscriber: Optional injected :class:`TopicSubscriber` (tests pass a
            ``FakeSubscriber``); defaults to the rclpy-backed implementation.
    """
    settings = get_settings()
    config = _load_config(resolve_config_path(settings.recording_config))
    sub = subscriber if subscriber is not None else _build_subscriber(config)
    # Wire the alert engine (MON-C1): without this the /alerts route is always
    # empty because nothing ever builds the AlertRules the engine evaluates. The
    # loader tolerates an unset/missing path (no rules) but fails loudly on a
    # malformed file so a config typo is never silently ignored.
    alert_config_path = resolve_config_path(settings.alert_config_path)
    alert_rules = load_alert_rules(alert_config_path)
    # Auto-derived per-topic hz rules (from expected_hz shortfall). The optional
    # `derived_rules:` block in the same file tunes ratios/hysteresis; absent, the
    # feature is on with its defaults (see DerivedRulesConfig).
    derived_config = load_derived_config(alert_config_path)
    service = MonitorService(
        sub, config=config, alert_rules=alert_rules, derived_config=derived_config
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        # Bring the subscriber up off the event loop: its rclpy import + node
        # creation are blocking, and absent ROS this raises — which must not
        # crash the app (health stays up), so we log and carry on.
        def _start() -> None:
            try:
                service.start()
            except Exception:  # noqa: BLE001 - ROS may be absent; stay live
                logger.exception("failed to start monitor subscriber")

        await asyncio.to_thread(_start)
        try:
            yield
        finally:
            await asyncio.to_thread(service.stop)

    app = create_app(SERVICE_NAME, settings=settings)
    app.router.lifespan_context = lifespan
    app.state.monitor = service

    # create_app registers a default always-ready /readyz; drop it so our
    # subscriber-aware probe below serves the path (Starlette matches the first
    # registered route, so the default would otherwise win).
    app.router.routes = [
        route
        for route in app.router.routes
        if getattr(route, "path", None) != "/readyz"
    ]

    @app.get("/")
    async def root() -> dict[str, str]:
        """Root identifying the service and stage."""
        return {"service": SERVICE_NAME, "stage": "stage2"}

    @app.get("/topics", response_model=TopicsResponse)
    async def topics() -> TopicsResponse:
        return service.topics()

    @app.get("/metrics", response_model=MetricsSnapshot)
    async def metrics() -> MetricsSnapshot:
        return service.metrics_snapshot()

    @app.get("/metrics/stream")
    async def metrics_stream() -> StreamingResponse:
        return StreamingResponse(
            _sse(service.metrics_snapshot),
            media_type="text/event-stream",
        )

    @app.post("/metrics/pause", response_model=PauseResponse)
    async def metrics_pause() -> PauseResponse:
        return PauseResponse(paused=service.pause())

    @app.post("/metrics/resume", response_model=PauseResponse)
    async def metrics_resume() -> PauseResponse:
        return PauseResponse(paused=service.resume())

    def _alerts_payload() -> AlertsResponse:
        return AlertsResponse(ts=utc_now_iso8601(), alerts=service.alerts())

    @app.get("/alerts", response_model=AlertsResponse)
    async def alerts() -> AlertsResponse:
        return _alerts_payload()

    @app.get("/alerts/stream")
    async def alerts_stream() -> StreamingResponse:
        return StreamingResponse(_sse(_alerts_payload), media_type="text/event-stream")

    @app.get("/incidents", response_model=IncidentsResponse)
    async def incidents(
        since_ns: int = Query(
            0,
            ge=0,
            description=(
                "Return incidents that fired OR cleared at/after this wall-clock "
                "UNIX-nanosecond timestamp (0 = all retained history)."
            ),
        ),
    ) -> IncidentsResponse:
        return IncidentsResponse(incidents=service.incidents(since_ns))

    # Readiness reflects that the subscriber node is up; live but not ready
    # until then (e.g. ROS not reachable yet).
    @app.get("/readyz", tags=["health"])
    async def readyz(response: Response) -> dict[str, str]:
        if not service.is_ready():
            response.status_code = 503
            return {"status": "not_ready"}
        return {"status": "ready"}

    return app


async def _sse(payload: Callable[[], BaseModel]) -> AsyncIterator[str]:
    """Yield ``payload()`` as periodic SSE ``data:`` frames (full snapshots).

    The spec streams a full snapshot each tick (not a diff) so the UI stays
    simple. ``payload`` is a zero-arg callable returning a pydantic model.
    """
    while True:
        model = payload()
        data = json.dumps(model.model_dump())
        yield f"data: {data}\n\n"
        await asyncio.sleep(_STREAM_INTERVAL_S)


app = create_monitor_app()


def main() -> None:
    """Run the service with uvicorn, binding host/port from config."""
    import uvicorn

    settings = get_settings()
    uvicorn.run(app, host=settings.bind_host, port=settings.topic_monitor_port)


if __name__ == "__main__":
    main()
