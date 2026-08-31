# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Retention's v2 definition (§10) and the store-health surface (§8, §2).

Retention had to be redefined outright. The v1 rule — "a row still exists, so it
was never exported" — matched everything the moment §6 stopped deleting rows on
export. A candidate is now a capture no dataset cites, still ``pending`` or
``excluded`` in review, and older than the retention period.

The health endpoint exists because the store's two worst conditions are both
invisible in an ordinary capture list: a rebuild that could not parse some
manifests (those captures have no row at all), and a filesystem layout that
makes deletion unsafe.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import Settings
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import ReplicaState

OLD = "2026-01-01T00:00:00.000Z"


def _retention_client(
    data_dir: Path, fake_recorder: FakeRecorder, *, days: int
) -> TestClient:
    settings = Settings(
        data_dir=str(data_dir),
        retention_days=days,
        recording_config="/nonexistent/recording.yaml",
        stream_config="/nonexistent/stream.yaml",
    )
    app = create_orchestrator_app(
        settings,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(fake_recorder.handler)
        ),
    )
    return TestClient(app)


def _capture(client: TestClient, layout: DataLayout, **fields) -> str:
    store = client.app.state.capture_store
    capture_id = new_capture_id()
    capture_dir = layout.capture_dir(capture_id)
    capture_dir.mkdir(parents=True, exist_ok=True)
    (capture_dir / "bag_0.mcap").write_bytes(b"x" * 1024)
    defaults = {
        "capture_id": capture_id,
        "run_id": f"run_{capture_id}",
        "state": CaptureState.completed,
        "started_at": OLD,
    }
    defaults.update(fields)
    store.create_capture(Capture(**defaults))
    store.upsert_replica(
        capture_id,
        client.app.state.instance_id,
        ReplicaState.present_unverified,
        path=str(capture_dir),
    )
    return capture_id


class TestRetention:
    def test_a_zero_setting_disables_the_feature(
        self, data_dir: Path, fake_recorder: FakeRecorder
    ) -> None:
        with _retention_client(data_dir, fake_recorder, days=0) as client:
            _capture(client, client.app.state.data_layout)
            body = client.get("/api/v1/retention").json()
        assert body == {"days": 0, "candidates": [], "total_bytes": 0}

    def test_an_old_unreviewed_capture_is_a_candidate(
        self, data_dir: Path, fake_recorder: FakeRecorder
    ) -> None:
        with _retention_client(data_dir, fake_recorder, days=30) as client:
            capture_id = _capture(client, client.app.state.data_layout)
            body = client.get("/api/v1/retention").json()

        assert [c["capture_id"] for c in body["candidates"]] == [capture_id]
        assert body["total_bytes"] == 1024

    def test_a_recent_capture_is_not_a_candidate(
        self, data_dir: Path, fake_recorder: FakeRecorder
    ) -> None:
        with _retention_client(data_dir, fake_recorder, days=30) as client:
            _capture(
                client,
                client.app.state.data_layout,
                started_at=datetime.now(UTC).isoformat(),
            )
            body = client.get("/api/v1/retention").json()
        assert body["candidates"] == []

    def test_an_adopted_capture_is_not_a_candidate(
        self, data_dir: Path, fake_recorder: FakeRecorder
    ) -> None:
        with _retention_client(data_dir, fake_recorder, days=30) as client:
            _capture(client, client.app.state.data_layout, review_status="adopted")
            body = client.get("/api/v1/retention").json()
        # Adopted means somebody decided to keep it; only pending and excluded
        # captures are offered for reclamation (§10).
        assert body["candidates"] == []

    def test_an_excluded_capture_is_a_candidate(
        self, data_dir: Path, fake_recorder: FakeRecorder
    ) -> None:
        with _retention_client(data_dir, fake_recorder, days=30) as client:
            capture_id = _capture(
                client, client.app.state.data_layout, review_status="excluded"
            )
            body = client.get("/api/v1/retention").json()
        assert [c["capture_id"] for c in body["candidates"]] == [capture_id]

    def test_a_dataset_member_is_never_a_candidate(
        self, data_dir: Path, fake_recorder: FakeRecorder
    ) -> None:
        with _retention_client(data_dir, fake_recorder, days=30) as client:
            capture_id = _capture(client, client.app.state.data_layout)
            dataset = client.post("/api/v1/datasets", json={"name": "ds"}).json()
            client.post(
                f"/api/v1/datasets/{dataset['dataset_id']}/members",
                json={"capture_id": capture_id},
            )
            body = client.get("/api/v1/retention").json()
        # This is the v2 replacement for "was it exported": membership, not the
        # existence of a row, is what says a capture is spoken for.
        assert body["candidates"] == []

    def test_retention_deletes_nothing(
        self, data_dir: Path, fake_recorder: FakeRecorder
    ) -> None:
        with _retention_client(data_dir, fake_recorder, days=30) as client:
            layout = client.app.state.data_layout
            capture_id = _capture(client, layout)
            client.get("/api/v1/retention")
            # Advisory only: deletion always goes through the confirmed
            # POST /captures/{id}/delete path.
            assert layout.capture_dir(capture_id).is_dir()
            assert client.get(f"/api/v1/captures/{capture_id}").status_code == 200


class TestStoreHealth:
    def test_a_clean_store_reports_ok(self, client: TestClient) -> None:
        body = client.get("/api/v1/store/health").json()
        assert body["state"] == "ok"
        assert body["delete_available"] is True
        assert body["instance_id"] == client.app.state.instance_id
        assert body["corrupt"] == []

    def test_a_split_filesystem_withdraws_deletion(self, client: TestClient) -> None:
        client.app.state.store_health.disable_deletes(
            ".trash is on a different filesystem from objects/"
        )
        body = client.get("/api/v1/store/health").json()
        # §2 forbids the copy+delete fallback, so the capability is reported as
        # withdrawn rather than silently degraded into a non-atomic operation.
        assert body["delete_available"] is False
        assert "different filesystem" in body["delete_unavailable_reason"]

    def test_readiness_is_not_gated_on_the_store_being_healthy(
        self, client: TestClient
    ) -> None:
        client.app.state.store_health.latch_suspect("storage looks wrong")
        body = client.get("/readyz").json()
        # A SUSPECT catalog still records and still serves reviews (§9-3), so
        # failing readiness would take the service out of rotation for exactly
        # the condition it is designed to keep working through.
        assert body["status"] == "ready"
        assert client.get("/api/v1/store/health").json()["state"] == "suspect"
