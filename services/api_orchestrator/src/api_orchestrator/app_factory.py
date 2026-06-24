"""Application factory for api_orchestrator (Stage 1: run lifecycle).

Builds the FastAPI app on the shared ``kairos_common.create_app`` plumbing and
wires the run-lifecycle stack:

- a :class:`~api_orchestrator.store.RunStore` (SQLite, source of truth),
- a :class:`~api_orchestrator.recorder_client.RecorderClient` (httpx, 3s + retry),
- a :class:`~api_orchestrator.runs.RunService` on ``app.state.run_service``,
- the ``record`` and ``runs`` routers,
- an extended ``/readyz`` that pings the recorder, and
- startup reconciliation of interrupted runs.

The factory accepts injected ``store`` / ``http_client`` so tests can supply an
in-memory DB and an ``httpx.MockTransport`` without a live recorder.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.routing import APIRoute
from kairos_common import Settings, create_app, get_settings, load_recording_config
from kairos_common.recording_config import RecordingConfig

from api_orchestrator.dora_runner_client import DoraRunnerClient
from api_orchestrator.events import EventHub
from api_orchestrator.monitor_client import MonitorClient
from api_orchestrator.recorder_client import RecorderClient
from api_orchestrator.routers import events as events_router
from api_orchestrator.routers import jobs as jobs_router
from api_orchestrator.routers import pipelines as pipelines_router
from api_orchestrator.routers import record as record_router
from api_orchestrator.routers import runs as runs_router
from api_orchestrator.routers import topics as topics_router
from api_orchestrator.routers import validation as validation_router
from api_orchestrator.runs import RunService
from api_orchestrator.store import RunStore
from api_orchestrator.streamer_client import StreamerClient

logger = logging.getLogger("kairos")

SERVICE_NAME = "api_orchestrator"
DEFAULT_DB_PATH = "/data/kairos.db"


def _load_recording_config(settings: Settings) -> RecordingConfig | None:
    """Load RECORDING_CONFIG if present; tolerate its absence in dev/tests.

    ``default_topics`` is only needed when a start request omits ``topics``;
    if the file is missing or invalid we log and continue with ``None`` so the
    service still boots (an omitted-topics start then returns a clear 400).
    """
    path = Path(settings.recording_config)
    if not path.exists():
        logger.warning("RECORDING_CONFIG not found", extra={"path": str(path)})
        return None
    try:
        return load_recording_config(path)
    except (ValueError, OSError) as exc:
        logger.warning("RECORDING_CONFIG invalid", extra={"error": str(exc)})
        return None


def _component_state(ok: bool) -> str:
    """Render component readiness as the spec's string vocabulary."""
    return "ok" if ok else "unreachable"


def _override_readyz(
    app: FastAPI,
    recorder: RecorderClient,
    monitor: MonitorClient,
    streamer: StreamerClient,
) -> None:
    """Replace the skeleton ``/readyz`` with one that checks the recorder.

    ``create_app`` installs a stub ``/readyz``; we drop it and register the
    orchestrator's version, which reports per-component reachability
    (``components: {recorder, monitor, streamer}``) per
    ``api_orchestrator.md``. The recorder gates readiness; monitor/streamer
    outages are degraded dependencies.
    """
    app.router.routes = [
        r
        for r in app.router.routes
        if not (isinstance(r, APIRoute) and r.path == "/readyz")
    ]

    @app.get("/readyz", tags=["health"])
    async def readyz() -> dict[str, object]:
        recorder_ok = await recorder.healthz()
        monitor_ok = await monitor.healthz()
        streamer_ok = await streamer.healthz()
        any_unreachable = not (recorder_ok and monitor_ok and streamer_ok)
        status = "ready" if recorder_ok and not any_unreachable else "degraded"
        return {
            "status": status,
            "components": {
                "recorder": _component_state(recorder_ok),
                "monitor": _component_state(monitor_ok),
                "streamer": _component_state(streamer_ok),
            },
        }


def create_orchestrator_app(
    settings: Settings | None = None,
    *,
    store: RunStore | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> FastAPI:
    """Build the wired api_orchestrator FastAPI app.

    Args:
        settings: Shared settings (defaults to the cached instance).
        store: Injected runs store (defaults to SQLite at ``/data/kairos.db``).
        http_client: Injected httpx client for the recorder (defaults to a real
            ``AsyncClient``; tests pass one backed by a ``MockTransport``).
    """
    settings = settings or get_settings()
    recording_config = _load_recording_config(settings)

    run_store = store or RunStore(DEFAULT_DB_PATH)
    owns_client = http_client is None
    client = http_client or httpx.AsyncClient()
    recorder = RecorderClient(f"http://localhost:{settings.recorder_port}", client)
    monitor = MonitorClient(f"http://localhost:{settings.topic_monitor_port}", client)
    streamer = StreamerClient(f"http://localhost:{settings.webrtc_port}", client)
    dora_runner = DoraRunnerClient(
        f"http://localhost:{settings.dora_runner_port}", client
    )
    event_hub = EventHub(monitor)
    service = RunService(
        run_store,
        recorder,
        recording_config,
        event_hub,
        recorded_dir=settings.recorded_dir,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Startup: reconcile any runs left mid-recording by a previous process.
        await event_hub.start()
        try:
            await service.reconcile_on_startup()
        except Exception:  # noqa: BLE001 - never block startup on reconcile.
            logger.exception("startup reconciliation failed")
        yield
        await event_hub.stop()
        # Shutdown: close the client only if we created it here.
        if owns_client:
            await client.aclose()

    app = create_app(SERVICE_NAME, settings=settings)
    app.router.lifespan_context = lifespan
    app.state.run_service = service
    app.state.run_store = run_store
    app.state.recorder_client = recorder
    app.state.monitor_client = monitor
    app.state.streamer_client = streamer
    app.state.dora_runner_client = dora_runner
    app.state.event_hub = event_hub

    app.include_router(record_router.router)
    app.include_router(runs_router.router)
    app.include_router(topics_router.router)
    app.include_router(events_router.router)
    app.include_router(pipelines_router.router)
    app.include_router(jobs_router.router)
    app.include_router(validation_router.router)
    _override_readyz(app, recorder, monitor, streamer)

    _register_root_and_config(app, settings, recording_config)
    return app


def _config_defaults(recording_config: RecordingConfig | None) -> dict[str, object]:
    """Build the ``defaults`` block of ``GET /api/v1/config`` from the loaded
    RECORDING_CONFIG, so the UI can pre-select recording topics and seed the
    monitor view without hardcoding anything (see the Record / Monitor tabs).

    - ``default_topics``: topics recorded / monitored by default (pre-checked in
      the Record tab; flagged as "configured" in the Monitor tab).
    - ``expected_hz``: pattern -> expected Hz, for the Monitor Late judgement.
      Patterns whose ``hz`` is omitted (dynamically learned) are skipped.
    - ``robot_name``: shown so operators can confirm which robot config is live.
    """
    if recording_config is None:
        return {"expected_hz": {}, "encoding": "vp8", "default_topics": []}
    expected_hz = {
        p.pattern: p.hz
        for p in recording_config.expected_hz_patterns
        if p.hz is not None
    }
    return {
        "expected_hz": expected_hz,
        "encoding": "vp8",
        "default_topics": list(recording_config.default_topics),
        "robot_name": recording_config.robot_name,
    }


def _register_root_and_config(
    app: FastAPI, settings: Settings, recording_config: RecordingConfig | None
) -> None:
    """Register the Stage 0 root + ``GET /api/v1/config``.

    The payload keeps its Stage 0 shape (the frontend render-gate depends on
    it) but the ``defaults`` block is now sourced from the live RECORDING_CONFIG
    so the Record / Monitor tabs can surface the configured topics instead of
    asking the operator to type topic names by hand.
    """
    defaults = _config_defaults(recording_config)

    @app.get("/")
    async def root() -> dict[str, str]:
        return {"service": SERVICE_NAME, "stage": "stage1"}

    @app.get("/api/v1/config")
    async def runtime_config() -> dict[str, object]:
        return {
            "endpoints": {
                "api": "/api/v1",
                "events": "/api/v1/events",
                "webrtc": settings.webrtc_public_url,
            },
            "tabs": [
                {"id": "record", "enabled": True},
                {"id": "monitor", "enabled": True},
                {"id": "stream", "enabled": True},
                {"id": "runs", "enabled": True},
                {"id": "pipelines", "enabled": True},
            ],
            "defaults": defaults,
            "schemas": {
                "pipeline_forms": {
                    "fast_validation": {
                        "type": "object",
                        "required": ["template"],
                        "properties": {"template": {"type": "string"}},
                    }
                }
            },
        }
