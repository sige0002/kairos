"""Control sidecar: topic_monitor-compatible HTTP surface fed by the dora bus.

Route-for-route compatible with topic_monitor (``/topics``, ``/metrics`` +
SSE, pause/resume, ``/alerts`` + SSE, ``/incidents``, subscriber-aware
``/readyz``), so the orchestrator switches backends by pointing
``TOPIC_MONITOR_HOST/PORT`` here — no orchestrator or frontend code change.

Additions beyond the monitor contract:
- ``POST /internal/samples`` — feed endpoint for the metrics dataflow node.
- ``GET /live/status`` — dora_live introspection (manifest, bridged state,
  dataflow liveness, pinned dora commit); also carries the honesty marker
  ``metrics_source: dora_bridge`` (Hz is measured after the bridge, and DDS
  ``message_lost`` counters are not available on this path).
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import deque
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

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
from kairos_common.monitoring import (
    AlertsResponse,
    IncidentsResponse,
    MetricsSnapshot,
    MonitorService,
    PauseResponse,
    TopicsResponse,
    load_alert_rules,
    load_derived_config,
)
from pydantic import BaseModel

from dora_live.feed_subscriber import DoraFeedSubscriber
from dora_live.probe_state import ProbeHub

logger = logging.getLogger("kairos.dora_live")

SERVICE_NAME = "dora_live"
METRICS_SOURCE = "dora_bridge"

_STREAM_INTERVAL_S = 1.0


class FeedBatch(BaseModel):
    """Body of ``POST /internal/samples`` (metrics node contract)."""

    rows: list[dict[str, Any]]


def load_config(recording_config_path: str) -> RecordingConfig | None:
    """Load RECORDING_CONFIG, tolerating absence (same policy as monitor)."""
    try:
        return load_recording_config(recording_config_path)
    except (FileNotFoundError, ValueError) as exc:
        logger.warning("recording config unavailable: %s", exc)
        return None


def create_control_app(
    *,
    subscriber: DoraFeedSubscriber | None = None,
    config: RecordingConfig | None = None,
    live_status: Callable[[], dict[str, Any]] | None = None,
    reload_manifest: Callable[[], dict[str, Any]] | None = None,
    probe_hub: ProbeHub | None = None,
) -> FastAPI:
    """Build the control app; tests inject subscriber/config/live_status."""
    settings = get_settings()
    if config is None:
        config = load_config(resolve_config_path(settings.recording_config))
    sub = subscriber if subscriber is not None else DoraFeedSubscriber()

    alert_config_path = resolve_config_path(settings.alert_config_path)
    alert_rules = load_alert_rules(alert_config_path)
    derived_config = load_derived_config(alert_config_path)
    service = MonitorService(
        sub, config=config, alert_rules=alert_rules, derived_config=derived_config
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        def _start() -> None:
            try:
                service.start()
            except Exception:  # noqa: BLE001 - ROS may be absent; stay live
                logger.exception("failed to start dora_live subscriber")

        await asyncio.to_thread(_start)
        try:
            yield
        finally:
            await asyncio.to_thread(service.stop)

    app = create_app(SERVICE_NAME, settings=settings)
    app.router.lifespan_context = lifespan
    app.state.monitor = service
    app.state.feed = sub

    app.router.routes = [
        route
        for route in app.router.routes
        if getattr(route, "path", None) != "/readyz"
    ]

    @app.get("/")
    async def root() -> dict[str, str]:
        return {
            "service": SERVICE_NAME,
            "stage": "live",
            "metrics_source": METRICS_SOURCE,
        }

    # ---- topic_monitor-compatible surface --------------------------------

    @app.get("/topics", response_model=TopicsResponse)
    async def topics() -> TopicsResponse:
        return service.topics()

    @app.get("/metrics", response_model=MetricsSnapshot)
    async def metrics() -> MetricsSnapshot:
        return service.metrics_snapshot()

    @app.get("/metrics/stream")
    async def metrics_stream() -> StreamingResponse:
        return StreamingResponse(
            _sse(service.metrics_snapshot), media_type="text/event-stream"
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
    async def incidents(since_ns: int = Query(0, ge=0)) -> IncidentsResponse:
        return IncidentsResponse(incidents=service.incidents(since_ns))

    @app.get("/readyz", tags=["health"])
    async def readyz(response: Response) -> dict[str, str]:
        if not service.is_ready():
            response.status_code = 503
            return {"status": "not_ready"}
        return {"status": "ready"}

    # ---- dora_live additions ----------------------------------------------

    @app.post("/internal/samples")
    async def internal_samples(batch: FeedBatch) -> dict[str, int]:
        return {"delivered": sub.ingest_batch(batch.rows)}

    @app.get("/live/status")
    async def live_status_route() -> dict[str, Any]:
        status = live_status() if live_status is not None else {}
        return {
            "ts": utc_now_iso8601(),
            "metrics_source": METRICS_SOURCE,
            "dds_samples_lost_available": False,
            **status,
        }

    if reload_manifest is not None:

        @app.post("/live/reload")
        async def live_reload() -> dict[str, Any]:
            return await asyncio.to_thread(reload_manifest)

    # Realtime-analysis event ring (Phase 2 lane). Demo-grade detectors push
    # here; the ring is queryable but intentionally not persisted (parity with
    # the monitor's live-only alerts; durable incidents stay a TBD).
    ai_events: deque[dict[str, Any]] = deque(maxlen=500)
    app.state.ai_events = ai_events

    @app.post("/internal/ai/events")
    async def ai_events_push(event: dict[str, Any]) -> dict[str, bool]:
        ai_events.append(event)
        return {"ok": True}

    @app.get("/live/events")
    async def live_events(since: float = Query(0.0, ge=0.0)) -> dict[str, Any]:
        rows = [e for e in ai_events if float(e.get("t", 0.0)) >= since]
        return {"ts": utc_now_iso8601(), "events": rows}

    if probe_hub is not None:
        hub = probe_hub

        @app.get("/internal/probe/active")
        async def probe_active() -> dict[str, Any]:
            return hub.active()

        @app.post("/internal/probe/values")
        async def probe_values(body: dict[str, Any]) -> dict[str, bool]:
            hub.push_values(body["topic"], float(body["t"]), body.get("values", {}))
            return {"ok": True}

        @app.post("/internal/probe/fields")
        async def probe_fields(body: dict[str, Any]) -> dict[str, bool]:
            hub.push_fields(
                body["topic"], list(body.get("fields", [])), body.get("reason")
            )
            return {"ok": True}

    return app


async def _sse(payload: Callable[[], BaseModel]) -> AsyncIterator[str]:
    """Full-snapshot periodic SSE ``data:`` frames (same shape as monitor)."""
    while True:
        model = payload()
        yield f"data: {json.dumps(model.model_dump())}\n\n"
        await asyncio.sleep(_STREAM_INTERVAL_S)
