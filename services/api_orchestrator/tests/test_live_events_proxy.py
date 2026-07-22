"""GET /api/v1/live/events — extension-event proxy with graceful absence."""

from __future__ import annotations

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.store import RunStore
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import Settings


def _client(settings: Settings, store: RunStore, handler) -> TestClient:
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app = create_orchestrator_app(settings, store=store, http_client=http_client)
    return TestClient(app)


def test_live_events_passthrough(
    settings: Settings, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if (
            request.url.port == settings.topic_monitor_port
            and request.url.path == "/live/events"
        ):
            assert request.url.params.get("since") == "5.0"
            return httpx.Response(
                200,
                json={
                    "ts": "2026-07-23T00:00:00Z",
                    "events": [{"kind": "dark_frame", "t": 9.0}],
                },
            )
        return fake_recorder.handler(request)

    with _client(settings, store, handler) as client:
        resp = client.get("/api/v1/live/events", params={"since": 5.0})
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is True
    assert body["events"] == [{"kind": "dark_frame", "t": 9.0}]


def test_live_events_absent_backend_degrades(
    settings: Settings, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    # Legacy monitor (LIVE=0) has no /live/events -> 404 -> available: false,
    # NOT an error (the UI hides the section).
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.port == settings.topic_monitor_port:
            return httpx.Response(404, json={"detail": "Not Found"})
        return fake_recorder.handler(request)

    with _client(settings, store, handler) as client:
        resp = client.get("/api/v1/live/events")
    assert resp.status_code == 200
    assert resp.json() == {"available": False, "events": []}


def test_live_events_broken_backend_surfaces_as_error(
    settings: Settings, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    # A genuine dora_live failure must NOT masquerade as "no surface": only
    # 404 means absent; a 5xx propagates as an error response.
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.port == settings.topic_monitor_port:
            return httpx.Response(500, json={"detail": "boom"})
        return fake_recorder.handler(request)

    with _client(settings, store, handler) as client:
        resp = client.get("/api/v1/live/events")
    assert resp.status_code >= 500
    assert "available" not in resp.json()
