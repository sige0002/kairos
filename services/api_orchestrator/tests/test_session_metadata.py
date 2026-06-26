"""Operator/task session metadata at the orchestrator boundary.

The session.json sidecar itself is written by the recorder (beside the MCAP).
Here we assert the orchestrator (a) persists operator/task on the run so it
round-trips via GET /api/v1/runs/{id}, and (b) forwards them in the recorder
start payload so the recorder can write them.
"""

from __future__ import annotations

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.store import RunStore
from fastapi.testclient import TestClient
from kairos_common import Settings


def _client(fake_recorder, store: RunStore) -> TestClient:
    settings = Settings(recording_config="/nonexistent/recording.yaml")
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_recorder.handler)
    )
    app = create_orchestrator_app(settings, store=store, http_client=http_client)
    return TestClient(app)


def test_operator_task_round_trip_and_forwarded(fake_recorder, store: RunStore):
    with _client(fake_recorder, store) as client:
        start = client.post(
            "/api/v1/record/start",
            json={"topics": "all", "operator": "yuki", "task": "pick-and-place"},
        ).json()
        run_id = start["run_id"]
        # Returned on the run and forwarded to the recorder start payload.
        assert start["operator"] == "yuki"
        assert start["task"] == "pick-and-place"
        assert fake_recorder.last_start_payload["operator"] == "yuki"
        assert fake_recorder.last_start_payload["task"] == "pick-and-place"

        client.post("/api/v1/record/stop")
        detail = client.get(f"/api/v1/runs/{run_id}").json()
        assert detail["operator"] == "yuki"
        assert detail["task"] == "pick-and-place"


def test_operator_task_default_when_omitted(fake_recorder, store: RunStore):
    with _client(fake_recorder, store) as client:
        run_id = client.post("/api/v1/record/start", json={"topics": "all"}).json()[
            "run_id"
        ]
        # Omitted/blank -> defaulted to stable placeholders (dataset export keys
        # data/<operator>/<task>, so a null component must not slip through), and
        # the placeholders are forwarded to the recorder for session.json.
        assert fake_recorder.last_start_payload["operator"] == "unknown_operator"
        assert fake_recorder.last_start_payload["task"] == "unknown_task"
        detail = client.get(f"/api/v1/runs/{run_id}").json()
        assert detail["operator"] == "unknown_operator"
        assert detail["task"] == "unknown_task"


def test_operator_task_blank_is_defaulted(fake_recorder, store: RunStore):
    with _client(fake_recorder, store) as client:
        run_id = client.post(
            "/api/v1/record/start",
            json={"topics": "all", "operator": "  ", "task": ""},
        ).json()["run_id"]
        detail = client.get(f"/api/v1/runs/{run_id}").json()
        assert detail["operator"] == "unknown_operator"
        assert detail["task"] == "unknown_task"
