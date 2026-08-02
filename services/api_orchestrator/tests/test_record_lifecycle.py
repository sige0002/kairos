"""The recording lifecycle under v2: prepare, start, stop, status.

The shape of ``/api/v1/record/*`` is unchanged from v1 (§10) — what is new is
that every response carries ``capture_id`` and that the row is created from the
recorder's answer rather than before it. Both are load-bearing: ``capture_id`` is
the key every other v2 endpoint uses, and a row that only exists once the
recorder acknowledged the start is what stops phantom captures accumulating.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from api_orchestrator.models import CaptureState
from api_orchestrator.store import CaptureStore
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common.ids import is_uuid7
from kairos_common.rebuild import ReplicaState


def _store(client: TestClient) -> CaptureStore:
    return client.app.state.capture_store


def _start(client: TestClient, **body: object) -> dict:
    payload = {"topics": ["/joint_states"], **body}
    response = client.post("/api/v1/record/start", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


class TestStart:
    def test_start_returns_the_recorder_minted_capture_id(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        capture = _start(client)
        assert is_uuid7(capture["capture_id"])
        # The recorder mints it (§1); the orchestrator must not substitute one
        # of its own, or the row and the manifest on disk would disagree.
        assert capture["capture_id"] == fake_recorder.capture_id
        assert capture["state"] == "recording"

    def test_the_row_is_keyed_by_capture_id_not_run_id(
        self, client: TestClient
    ) -> None:
        capture = _start(client)
        store = _store(client)
        assert store.get_capture(capture["capture_id"]) is not None
        # run_id survives as a display name only.
        assert capture["run_id"].startswith("run_")

    def test_starting_registers_a_present_but_unverified_replica(
        self, client: TestClient
    ) -> None:
        capture = _start(client)
        replica = _store(client).get_replica(
            capture["capture_id"], client.app.state.instance_id
        )
        assert replica is not None
        # §9-4: nothing may claim present_verified before the digest job has
        # actually hashed the bytes.
        assert replica.state == ReplicaState.present_unverified

    def test_a_second_start_while_recording_is_a_conflict(
        self, client: TestClient
    ) -> None:
        _start(client)
        response = client.post(
            "/api/v1/record/start", json={"topics": ["/joint_states"]}
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "already_recording"

    def test_a_rejected_start_with_a_capture_id_is_filed_as_failed(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        known = "01920000-0000-7000-8000-0000000000aa"
        fake_recorder.start_status = 500
        fake_recorder.start_error = {
            "code": "spawn_failed",
            "message": "no such executable",
            "details": {"capture_id": known},
        }
        response = client.post(
            "/api/v1/record/start", json={"topics": ["/joint_states"]}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["state"] == "failed"
        assert body["capture_id"] == known
        assert body["error"]["code"] == "spawn_failed"

    def test_a_rejected_start_with_no_capture_id_creates_no_row(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        fake_recorder.start_status = 500
        fake_recorder.start_error = {"code": "spawn_failed", "message": "boom"}
        response = client.post(
            "/api/v1/record/start", json={"topics": ["/joint_states"]}
        )
        # No id means nothing to file it under, so the recorder's error
        # propagates. The failed-start sidecar it wrote is the durable record
        # and a rebuild turns it into a row (§3.4) — inventing an id here would
        # disagree with that file.
        assert response.status_code >= 500
        assert _store(client).list_captures(limit=10)[0] == []

    def test_an_empty_topic_list_is_rejected_before_the_recorder_is_called(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        response = client.post("/api/v1/record/start", json={"topics": []})
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "no_topics"
        assert fake_recorder.last_start_payload is None


class TestStop:
    def test_stop_finalises_from_the_recorder_manifest(
        self, client: TestClient
    ) -> None:
        started = _start(client)
        stopped = client.post("/api/v1/record/stop").json()
        assert stopped["capture_id"] == started["capture_id"]
        assert stopped["state"] == "completed"
        assert stopped["message_count"] == 1234
        assert stopped["bytes"] == 567890

    @pytest.mark.parametrize("final_state", ["failed", "interrupted"])
    def test_stop_reports_the_recorders_real_terminal_state(
        self, client: TestClient, fake_recorder: FakeRecorder, final_state: str
    ) -> None:
        fake_recorder.final_state = final_state
        _start(client)
        # A stop must never assume completion: a recording that failed and one
        # that finished are indistinguishable from the orchestrator's side.
        assert client.post("/api/v1/record/stop").json()["state"] == final_state

    def test_a_recorder_error_string_becomes_a_structured_error(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        fake_recorder.final_state = "failed"
        fake_recorder.final_error = "disk full"
        _start(client)
        error = client.post("/api/v1/record/stop").json()["error"]
        # §3 keeps manifest.error a plain string; without this the capture would
        # surface as failed with no reason at all.
        assert error["code"] == "recorder_failed"
        assert error["message"] == "disk full"

    def test_stop_with_nothing_active_returns_the_last_capture(
        self, client: TestClient
    ) -> None:
        started = _start(client)
        client.post("/api/v1/record/stop")
        again = client.post("/api/v1/record/stop")
        assert again.status_code == 200
        assert again.json()["capture_id"] == started["capture_id"]

    def test_stop_on_an_empty_store_is_a_404(self, client: TestClient) -> None:
        response = client.post("/api/v1/record/stop")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "no_captures"

    def test_stop_stops_a_recorder_session_the_catalog_never_saw(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        # Model a start whose row never committed: the recorder is writing and
        # nothing here claims to be active. Reporting success would send the
        # operator on while the bag keeps growing.
        fake_recorder.state = "recording"
        fake_recorder.run_id = "run_orphan"
        fake_recorder.capture_id = "01920000-0000-7000-8000-0000000000bb"
        response = client.post("/api/v1/record/stop")
        assert response.status_code == 404  # nothing to report
        assert fake_recorder.stop_call_count == 1


class TestPrepare:
    def test_prepare_carries_the_capture_id_through_to_start(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        prepared = client.post(
            "/api/v1/record/prepare", json={"topics": ["/joint_states"]}
        ).json()
        assert prepared["state"] == "armed"
        assert is_uuid7(prepared["capture_id"])
        started = _start(client)
        # A matching start reuses the armed session, so both ids must match or
        # the recorder would be writing under one id and the catalog under
        # another.
        assert started["capture_id"] == prepared["capture_id"]
        assert started["run_id"] == prepared["run_id"]

    def test_prepare_creates_no_row(self, client: TestClient) -> None:
        client.post("/api/v1/record/prepare", json={"topics": ["/joint_states"]})
        assert _store(client).list_captures(limit=10)[0] == []

    def test_a_non_matching_start_does_not_reuse_the_armed_session(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        prepared = client.post(
            "/api/v1/record/prepare", json={"topics": ["/joint_states"]}
        ).json()
        started = _start(client, topics=["/tf"])
        # The recorder disarms the stale session and mints a fresh capture, so
        # the started capture must not inherit the armed one's identity.
        assert started["capture_id"] != prepared["capture_id"]

    def test_stop_disarms_a_prepare_that_never_started(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        client.post("/api/v1/record/prepare", json={"topics": ["/joint_states"]})
        client.post("/api/v1/record/stop")
        # The recorder holds a live armed session — subscriptions established,
        # the same DDS load as recording — which must not leak until its own
        # auto-disarm timeout.
        assert fake_recorder.stop_call_count == 1


class TestStatusReconciliation:
    def test_status_finalises_a_capture_the_recorder_auto_stopped(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        started = _start(client)
        # The recorder's own byte/second backstop tripped, bypassing our stop.
        fake_recorder.state = "completed"
        fake_recorder.finalized = True
        fake_recorder.message_count = 42
        fake_recorder.bytes = 99

        client.get("/api/v1/record/status")
        capture = _store(client).get_capture(started["capture_id"])
        assert capture is not None
        # Finalised within one poll rather than surfacing as `interrupted` at
        # the next restart.
        assert capture.state == CaptureState.completed

    def test_startup_interrupts_a_capture_left_recording(
        self, settings, fake_recorder: FakeRecorder, data_dir: Path
    ) -> None:
        import httpx
        from api_orchestrator.app_factory import create_orchestrator_app
        from api_orchestrator.models import Capture

        store = CaptureStore(data_dir / "kairos.db", data_dir=data_dir)
        store.create_capture(
            Capture(
                capture_id="01920000-0000-7000-8000-0000000000cc",
                run_id="run_crashed",
                state=CaptureState.recording,
                started_at="2026-08-01T00:00:00.000Z",
            )
        )
        store.close()

        app = create_orchestrator_app(
            settings,
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(fake_recorder.handler)
            ),
        )
        with TestClient(app):
            pass
        reopened = CaptureStore(data_dir / "kairos.db", data_dir=data_dir)
        capture = reopened.get_capture("01920000-0000-7000-8000-0000000000cc")
        assert capture is not None
        # A `recording` row after a restart is a lie no later event corrects —
        # nothing is writing to it any more.
        assert capture.state == CaptureState.interrupted
        reopened.close()

    def test_an_unreachable_recorder_leaves_live_rows_alone(
        self, settings, fake_recorder: FakeRecorder, data_dir: Path
    ) -> None:
        import httpx
        from api_orchestrator.app_factory import create_orchestrator_app
        from api_orchestrator.models import Capture

        store = CaptureStore(data_dir / "kairos.db", data_dir=data_dir)
        store.create_capture(
            Capture(
                capture_id="01920000-0000-7000-8000-0000000000dd",
                run_id="run_live",
                state=CaptureState.recording,
                started_at="2026-08-01T00:00:00.000Z",
            )
        )
        store.close()
        fake_recorder.transport_down = True

        app = create_orchestrator_app(
            settings,
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(fake_recorder.handler)
            ),
        )
        with TestClient(app):
            pass
        reopened = CaptureStore(data_dir / "kairos.db", data_dir=data_dir)
        capture = reopened.get_capture("01920000-0000-7000-8000-0000000000dd")
        assert capture is not None
        # Without the recorder we cannot tell an abandoned recording from a live
        # one, and interrupting a live one would orphan a bag still being written.
        assert capture.state == CaptureState.recording
        reopened.close()


class TestRecordStatusEvents:
    def test_every_record_status_event_carries_the_capture_id(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        hub = client.app.state.event_hub
        published: list[tuple[str, dict]] = []
        real_publish = hub.publish

        async def capture_publish(event_type: str, data: dict):
            published.append((event_type, data))
            return await real_publish(event_type, data)

        hub.publish = capture_publish
        started = _start(client)
        client.post("/api/v1/record/stop")

        events = [data for name, data in published if name == "record_status"]
        assert len(events) >= 2
        # §10: the event NAME is unchanged so an existing subscriber keeps
        # working, and capture_id is additive so a v2 client no longer has to
        # map a display name back to an identity.
        assert {e["capture_id"] for e in events} == {started["capture_id"]}
        assert [e["state"] for e in events][-1] == "completed"
        assert all("run_id" in e for e in events)


class TestQuickCheckSettlement:
    def test_stop_settles_a_quick_check_onto_the_capture(
        self, client: TestClient
    ) -> None:
        started = _start(client)
        client.post("/api/v1/record/stop")
        asyncio.run(client.app.state.record_service.drain_settlements())

        capture = _store(client).get_capture(started["capture_id"])
        assert capture is not None
        assert capture.quick_check is not None
        assert capture.quick_check.layer0.integrity == "ok"

    def test_an_omitted_quality_is_derived_from_the_settled_verdict(
        self, client: TestClient
    ) -> None:
        started = _start(client)
        capture_id = started["capture_id"]
        client.post("/api/v1/record/stop")
        asyncio.run(client.app.state.record_service.drain_settlements())

        # The operator's Save sends no quality unless they overrode it, so the
        # server derives it from its own verdict — one derivation, not one per
        # client.
        saved = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={
                "base_revision": 0,
                "task_result": "success",
                "review_status": "adopted",
            },
        ).json()
        assert saved["quality_source"] == "quick_check"
        assert saved["quality"] == "needs_review"

    def test_a_late_verdict_corrects_a_quick_check_sourced_review(
        self, client: TestClient
    ) -> None:
        started = _start(client)
        capture_id = started["capture_id"]
        client.post("/api/v1/record/stop")
        asyncio.run(client.app.state.record_service.drain_settlements())
        client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={
                "base_revision": 0,
                "task_result": "success",
                "review_status": "adopted",
            },
        )

        # A review saved BEFORE the settlement landed took the conservative
        # fallback. Once the real verdict arrives it is corrected through the
        # ordinary §4.1 path, revision bump and all.
        asyncio.run(
            client.app.state.record_service.reconcile_quality(capture_id, "good")
        )

        capture = _store(client).get_capture(capture_id)
        assert capture is not None
        assert capture.quality == "good"
        assert capture.review_revision == 2
        assert capture.review_status == "adopted"

    def test_an_operator_quality_call_is_never_overwritten(
        self, client: TestClient
    ) -> None:
        started = _start(client)
        capture_id = started["capture_id"]
        client.post("/api/v1/record/stop")
        client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={
                "base_revision": 0,
                "task_result": "failure",
                "quality": "not_usable",
                "quality_source": "operator",
                "review_status": "excluded",
            },
        )
        asyncio.run(
            client.app.state.record_service.reconcile_quality(capture_id, "good")
        )

        capture = _store(client).get_capture(capture_id)
        assert capture is not None
        # A human decision outranks a heuristic; only quick_check-sourced values
        # are re-derived.
        assert capture.quality == "not_usable"
        assert capture.review_revision == 1
