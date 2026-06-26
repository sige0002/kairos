"""GET /api/v1/config `schemas.pipeline_forms` is dynamic (OL-4.2).

The orchestrator builds the validation-job form schema from dora_runner's
`/pipelines` registry instead of a hardcoded shape, and falls back to the
static `fast_validation` form if dora_runner is unreachable (config must never
500).
"""

from __future__ import annotations

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.store import RunStore
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import Settings

_DYNAMIC_PIPELINES = {
    "items": [
        {
            "id": "fast_validation",
            "name": "Fast validation",
            "description": "Required-topic check.",
            "enabled": True,
            "schema": {
                "type": "object",
                "required": ["template"],
                "properties": {"template": {"type": "string"}},
            },
        },
        {
            "id": "loss_report",
            "name": "Loss report",
            "description": "Per-topic loss estimate.",
            "enabled": True,
            "schema": {
                "type": "object",
                "properties": {
                    "target_topics": {
                        "type": "array",
                        "items": {"type": "string"},
                        "default": ["/hsrb/*"],
                    },
                    "gap_threshold_multiplier": {"type": "number", "default": 5.0},
                },
            },
        },
    ]
}


def test_pipeline_forms_are_built_from_dora_runner(
    settings: Settings, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    """Each pipeline id maps to its dora_runner-provided params_schema."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.port == settings.dora_runner_port:
            if request.url.path == "/pipelines":
                return httpx.Response(200, json=_DYNAMIC_PIPELINES)
            return httpx.Response(200, json={"status": "ok"})
        return fake_recorder.handler(request)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app = create_orchestrator_app(settings, store=store, http_client=http_client)
    with TestClient(app) as client:
        forms = client.get("/api/v1/config").json()["schemas"]["pipeline_forms"]

    assert set(forms) == {"fast_validation", "loss_report"}
    assert forms["fast_validation"]["required"] == ["template"]
    # OL-4.3 loss_report params surface so the auto-form can render them.
    loss = forms["loss_report"]["properties"]
    assert loss["gap_threshold_multiplier"]["default"] == 5.0
    assert loss["target_topics"]["default"] == ["/hsrb/*"]


def test_pipeline_forms_fall_back_when_dora_runner_unreachable(
    settings: Settings, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    """A dora_runner outage degrades to the static fast_validation form, not a 500."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.port == settings.dora_runner_port:
            # Simulate an outage on /pipelines (transport-level failure).
            if request.url.path == "/pipelines":
                raise httpx.ConnectError("dora_runner down")
            return httpx.Response(200, json={"status": "ok"})
        return fake_recorder.handler(request)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app = create_orchestrator_app(settings, store=store, http_client=http_client)
    with TestClient(app) as client:
        resp = client.get("/api/v1/config")

    assert resp.status_code == 200
    forms = resp.json()["schemas"]["pipeline_forms"]
    assert set(forms) == {"fast_validation"}
    assert forms["fast_validation"]["required"] == ["template"]
