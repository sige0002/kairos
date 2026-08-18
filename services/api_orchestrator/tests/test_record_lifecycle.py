# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The recording lifecycle under v2: prepare, start, stop, status.

The shape of ``/api/v1/record/*`` is unchanged from v1 (§10) — what is new is
that every response carries ``capture_id`` and that the row is created from the
recorder's answer rather than before it. Both are load-bearing: ``capture_id`` is
the key every other v2 endpoint uses, and a row that only exists once the
recorder acknowledged the start is what stops phantom captures accumulating.
"""

from __future__ import annotations

import asyncio
import threading
import time
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


def _hold_settlement(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> threading.Event:
    """Park the stop-time quick-check settlement until the event is set.

    The settlement runs on the app's own loop (the TestClient portal keeps it
    turning), so a test that needs a review saved BEFORE the verdict lands must
    hold it there — otherwise the ordering, which IS the scenario, is decided by
    a race with the test thread.

    The gate sits on the settlement's first await, and it yields to the loop
    rather than blocking it, so the request under test is still served. It is
    deliberately not inside the MCAP read: that one is wrapped in a 1.5s
    ``wait_for`` which would cancel the gate and let the settlement carry on.
    """
    service = client.app.state.record_service
    release = threading.Event()
    original = service._monitor_metric_topics

    async def gated() -> object:
        while not release.is_set():
            await asyncio.sleep(0.01)
        return await original()

    monkeypatch.setattr(service, "_monitor_metric_topics", gated)
    return release


def _hold_reconcile(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> threading.Event:
    """Park the settlement's re-derivation, letting its verdict land first.

    This opens the window the correction is dangerous in: the verdict is on the
    capture and visible to any client, but the re-derivation that follows has
    not read the review yet. A review written in that window is a judgement
    about a verdict the operator could actually see.
    """
    service = client.app.state.record_service
    release = threading.Event()
    original = service.reconcile_quality

    async def gated(*args: object, **kwargs: object) -> None:
        while not release.is_set():
            await asyncio.sleep(0.01)
        await original(*args, **kwargs)

    monkeypatch.setattr(service, "reconcile_quality", gated)
    return release


def _await_verdict(client: TestClient, capture_id: str, *, timeout_s: float = 10.0):
    """Wait for the settled quick_check to appear on the capture."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        capture = _store(client).get_capture(capture_id)
        if capture is not None and capture.quick_check is not None:
            return capture
        time.sleep(0.02)
    raise AssertionError("the quick check never settled")


def _await_settlement(client: TestClient, *, timeout_s: float = 10.0) -> None:
    """Block until every in-flight quick-check settlement has finished.

    ``drain_settlements()`` cannot be used from here for a settlement that is
    still running: the task belongs to the app's loop and this is another
    thread. The task removes itself from the set when it completes (after
    ``reconcile_quality``), so an empty set is the honest "it is done" — and a
    settlement that never finishes fails the test rather than being waited on
    forever.
    """
    service = client.app.state.record_service
    deadline = time.monotonic() + timeout_s
    while service._settlement_tasks and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not service._settlement_tasks, "the quick-check settlement never finished"


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

    @pytest.mark.parametrize("final_state", ["completed", "failed"])
    def test_a_flush_that_outlives_the_stop_response_settles_honestly(
        self, client: TestClient, fake_recorder: FakeRecorder, final_state: str
    ) -> None:
        # Delayed success/failure: the recorder answers /record/stop with
        # ``stopping`` and keeps flushing for two more status reads. The old
        # code read status ONCE and sealed any still-active answer as
        # ``completed``; the fix polls until the recorder settles and reports
        # what it actually settled into.
        service = client.app.state.record_service
        service._final_state_poll_interval_s = 0.01
        service._final_state_poll_budget_s = 2.0
        fake_recorder.final_state = final_state
        fake_recorder.settle_after_status_polls = 2
        _start(client)
        assert client.post("/api/v1/record/stop").json()["state"] == final_state

    def test_a_recorder_still_writing_at_the_budget_is_never_completed(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        # S2-6: the recorder ANSWERS, and the answer is "I am not done". That
        # answer used to be sealed as ``completed`` — a bag still being written
        # became a good take. It must end ``interrupted`` with an error that
        # names the unconfirmed stop, never ``completed``.
        service = client.app.state.record_service
        service._final_state_poll_interval_s = 0.01
        service._final_state_poll_budget_s = 0.05
        fake_recorder.settle_after_status_polls = 10**9
        _start(client)
        stopped = client.post("/api/v1/record/stop").json()
        assert stopped["state"] == "interrupted"
        assert stopped["error"]["code"] == "stop_not_confirmed"

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
        #
        # This fake writes NO sidecar for that id, so there is nothing on disk
        # to reconstruct the capture from (§8 rule 4) — which is what makes the
        # refusal the right answer here rather than the recovery E-17 added for
        # the case where the manifest IS there.
        fake_recorder.state = "recording"
        fake_recorder.run_id = "run_orphan"
        fake_recorder.capture_id = "01920000-0000-7000-8000-0000000000bb"
        response = client.post("/api/v1/record/stop")
        # Was a 404 whose code (`no_captures`) came from the empty-store
        # fallback rather than from any decision about this capture — the same
        # fallback that, with one earlier take in the store, answered 200 and
        # named it (E-17). The refusal is now about THIS capture and says so.
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "stop_capture_unfiled"
        assert response.json()["error"]["details"]["capture_id"] == (
            fake_recorder.capture_id
        )
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

    def test_a_rejected_prepare_files_no_row_even_with_a_capture_id(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        # S2-7: the recorder no longer mints objects/<id>.failed.json for a
        # failed pre-arm probe, so filing a row here would be the §13-4
        # divergence (a row the next rebuild silently drops). The failure
        # reaches the operator through the propagated rejection — the console
        # surfaces a failing pre-arm live — not through the capture list.
        # (The pre-S2-7 contract was the exact opposite: sidecar + row per
        # failed keep-alive, which piled up a failed capture every 30 s.)
        known = "01920000-0000-7000-8000-0000000000ab"
        fake_recorder.prepare_status = 507
        fake_recorder.prepare_error = {
            "code": "record_arm_failed",
            "message": "Recording failed to arm (subscribe + resume).",
            "details": {"capture_id": known},
        }
        response = client.post(
            "/api/v1/record/prepare", json={"topics": ["/joint_states"]}
        )
        # The caller armed nothing and must know — the rejection propagates.
        assert response.status_code >= 500
        assert _store(client).get_capture(known) is None
        assert _store(client).list_captures(limit=10)[0] == []

    def test_start_budget_scales_with_the_live_configs_waits(
        self, client: TestClient
    ) -> None:
        # S2-3: the flat 25 s budget left 0.5 s of margin against the default
        # config waits, and a documented `start_delay_s: 10` (camera warm-up)
        # made every cold start a 503 that filed a failed row onto a recording
        # that was actually coming up. The budget must follow the config.
        from kairos_common import RecordingConfig, RecordingTuning

        service = client.app.state.record_service
        original = service._config
        try:
            service._config = None
            assert service._start_budget_s() == pytest.approx(25.0)
            # The default waits (2 + 5 + 0) land exactly on the floor.
            service._config = RecordingConfig(robot_name="t")
            assert service._start_budget_s() == pytest.approx(25.0)
            # Camera warm-up: 18 (floor) + 10 + 5 + 0.
            service._config = RecordingConfig(
                robot_name="t", recording=RecordingTuning(start_delay_s=10)
            )
            assert service._start_budget_s() == pytest.approx(33.0)
            # The budget never shrinks below the floor constant.
            service._config = RecordingConfig(
                robot_name="t",
                recording=RecordingTuning(
                    start_delay_s=0, subscription_ready_timeout_s=0
                ),
            )
            assert service._start_budget_s() == pytest.approx(25.0)
        finally:
            service._config = original

    def test_a_rejected_prepare_with_no_capture_id_creates_no_row(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        fake_recorder.prepare_status = 507
        fake_recorder.prepare_error = {"code": "record_arm_failed", "message": "boom"}
        response = client.post(
            "/api/v1/record/prepare", json={"topics": ["/joint_states"]}
        )
        assert response.status_code >= 500
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
        _await_settlement(client)

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
        _await_settlement(client)

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
        # A healthy 10s take settles GOOD, and the derivation carries that
        # through. Asserting needs_review here used to pass for the wrong
        # reason: the fake's bag was unreadable, so every verdict was
        # needs_review and the derivation could not be told from the fallback.
        assert saved["quality"] == "good"

    def test_a_late_verdict_corrects_a_quick_check_sourced_review(
        self, client: TestClient
    ) -> None:
        started = _start(client)
        capture_id = started["capture_id"]
        client.post("/api/v1/record/stop")
        _await_settlement(client)
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
        # ordinary §4.1 path, revision bump and all. The correction is to a
        # DIFFERENT value than the save produced — otherwise the test would
        # pass whether or not the correction ran at all.
        asyncio.run(
            client.app.state.record_service.reconcile_quality(
                capture_id, "needs_review"
            )
        )

        capture = _store(client).get_capture(capture_id)
        assert capture is not None
        assert capture.quality == "needs_review"
        assert capture.review_revision == 2
        # The adoption stands. This review was written AFTER a settled verdict,
        # so it is a judgement about something the operator could see, not a
        # guess — and the caller here passes no evidence to the contrary. Only a
        # settlement that can show the review predates its verdict demotes one
        # (see the two tests below).
        assert capture.review_status == "adopted"

    def test_an_accidental_double_click_is_not_offered_as_good(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        """The QA report, driven through the real stop path.

        A 90ms take in which every topic happens to deliver a message passes
        every other quick-check rule, so before the minimum-duration criterion
        this settled GOOD and the UI offered "Save — success" as the Enter-able
        default.
        """
        fake_recorder.bag_duration_s = 0.09
        fake_recorder.bag_messages = 25
        started = _start(client)
        client.post("/api/v1/record/stop")
        _await_settlement(client)

        capture = _store(client).get_capture(started["capture_id"])
        quick = capture.quick_check
        assert quick.layer1.summary_available is True
        assert quick.verdict.quality == "needs_review"
        reason = next(r for r in quick.verdict.reasons if "shorter than" in r)
        assert "accidental" in reason

        # And the review derivation carries it, so the operator is not offered
        # a good-quality default for a capture the check just flagged.
        saved = client.patch(
            f"/api/v1/captures/{started['capture_id']}/review",
            json={"base_revision": 0, "task_result": "success"},
        ).json()
        assert saved["quality"] == "needs_review"

    def test_the_deployments_configured_floor_reaches_the_stop_path(
        self, settings, fake_recorder: FakeRecorder, tmp_path: Path
    ) -> None:
        """The floor is read from RECORDING_CONFIG, not hardcoded in the service."""
        import httpx
        import yaml
        from api_orchestrator.app_factory import create_orchestrator_app

        config = tmp_path / "recording.yaml"
        config.write_text(
            yaml.safe_dump(
                {
                    "robot_name": "r",
                    "default_topics": ["/joint_states"],
                    "validation": {"min_duration_s": 30},
                }
            ),
            encoding="utf-8",
        )
        strict = settings.model_copy(update={"recording_config": str(config)})
        fake_recorder.bag_duration_s = 10.0  # fine by default, short for this deploy

        app = create_orchestrator_app(
            strict,
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(fake_recorder.handler)
            ),
        )
        with TestClient(app) as client:
            started = _start(client)
            client.post("/api/v1/record/stop")
            _await_settlement(client)
            capture = app.state.capture_store.get_capture(started["capture_id"])

        assert capture.quick_check.verdict.quality == "needs_review"
        assert "30s minimum" in " ".join(capture.quick_check.verdict.reasons)

    def test_a_save_that_beats_the_verdict_does_not_stay_adopted(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A fast Save must not adopt data this server is about to flag.

        Collect's result panel has no verdict to show while the quick check is
        still settling, so its auto quality falls back to good and the save
        carries ``review_status: adopted``. For the SAME capture the server
        derives ``needs_review`` — and used to correct only the quality, so the
        capture kept the ``adopted`` it was handed and sat in Review's READY
        lane (the lane that needs no attention), dataset-eligible, while the
        verdict said the opposite.
        """
        fake_recorder.bag_duration_s = 0.09  # settles needs_review
        fake_recorder.bag_messages = 25
        release = _hold_settlement(client, monkeypatch)

        started = _start(client)
        capture_id = started["capture_id"]
        client.post("/api/v1/record/stop")

        saved = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={
                "base_revision": 0,
                "task_result": "success",
                "review_status": "adopted",
            },
        ).json()
        # What the two sides said about the same capture at save time.
        assert saved["review_status"] == "adopted"
        assert saved["quality"] == "needs_review"
        assert saved["quality_source"] == "quick_check"

        release.set()
        _await_settlement(client)

        capture = _store(client).get_capture(capture_id)
        assert capture is not None
        # The verdict is real and it is not good …
        assert capture.quick_check is not None
        assert capture.quick_check.verdict.quality == "needs_review"
        # … so the capture must not still be sitting in READY as adopted. It
        # belongs in NEEDS CHECK, where "Mark OK — include" is the deliberate
        # human confirmation.
        assert capture.review_status == "pending"
        assert capture.quality == "needs_review"

    def test_mark_ok_inside_the_settlement_window_is_not_undone(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Review's deliberate "Mark OK — include" must survive the correction.

        It sends ``{review_status: adopted}`` and nothing else (see
        ``markOk`` in v2/review/useReviewState.ts), so it reaches the server
        with exactly the shape of Collect's fast save: same fields, same
        ``quick_check`` quality source, on a capture whose verdict says
        needs_review. The one thing that differs is that this one was written
        against a verdict the operator could see. Demoting it would silently
        undo a human decision — a worse failure than the divergence the
        correction exists to fix, and one the operator has no way to notice.
        """
        fake_recorder.bag_duration_s = 0.09  # settles needs_review
        fake_recorder.bag_messages = 25
        release = _hold_reconcile(client, monkeypatch)

        started = _start(client)
        capture_id = started["capture_id"]
        client.post("/api/v1/record/stop")

        # The verdict has landed; only the re-derivation behind it is held.
        capture = _await_verdict(client, capture_id)
        assert capture.quick_check.verdict.quality == "needs_review"

        saved = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 0, "review_status": "adopted"},
        ).json()
        assert saved["review_status"] == "adopted"
        # Nobody claimed the quality was a human call — the source stays
        # quick_check, which is precisely why the naive rule ate this row.
        assert saved["quality_source"] == "quick_check"
        assert saved["quality"] == "needs_review"

        release.set()
        _await_settlement(client)

        capture = _store(client).get_capture(capture_id)
        assert capture is not None
        assert capture.review_status == "adopted"
        assert capture.quality == "needs_review"

    def test_an_adoption_that_beat_the_verdict_entirely_is_still_a_guess(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Where the line falls, stated outright.

        This is the bare "Mark OK" payload again, but written before the verdict
        existed rather than after it. Nothing on the wire separates it from
        Collect's fast save at this point — both adopted a capture nothing had
        measured — so it gets the same answer, and this test exists so that is a
        decision rather than an oversight. The cost is bounded and visible: the
        capture is in NEEDS CHECK with the real verdict now on it, one click
        from being adopted again by an operator who can finally see what they
        are adopting.
        """
        fake_recorder.bag_duration_s = 0.09  # settles needs_review
        fake_recorder.bag_messages = 25
        release = _hold_settlement(client, monkeypatch)

        started = _start(client)
        capture_id = started["capture_id"]
        client.post("/api/v1/record/stop")
        client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 0, "review_status": "adopted"},
        )

        release.set()
        _await_settlement(client)

        capture = _store(client).get_capture(capture_id)
        assert capture is not None
        assert capture.review_status == "pending"
        # The "one click away" half of that argument, asserted rather than
        # assumed. NEEDS CHECK is only a fair place to send this capture if the
        # verdict is ON it for the operator to read; demoting while the verdict
        # went missing would leave them a row they cannot act on, and the status
        # assertion alone would not notice.
        assert capture.quick_check is not None
        assert capture.quick_check.verdict.quality == "needs_review"

    def test_a_good_verdict_leaves_the_operators_adoption_alone(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The correction above must not undo an adoption the verdict agrees with.

        The same fast Save on a healthy take: it banked the conservative
        ``needs_review`` fallback, and when the real verdict says good the
        adoption was right and stands. A correction that demoted every save
        that outran the settlement would send good data to NEEDS CHECK for no
        reason — and be indistinguishable, on screen, from the real thing.
        """
        release = _hold_settlement(client, monkeypatch)  # default bag: a good take

        started = _start(client)
        capture_id = started["capture_id"]
        client.post("/api/v1/record/stop")
        saved = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={
                "base_revision": 0,
                "task_result": "success",
                "review_status": "adopted",
            },
        ).json()
        assert saved["quality"] == "needs_review"  # the fallback, not a verdict

        release.set()
        _await_settlement(client)

        capture = _store(client).get_capture(capture_id)
        assert capture is not None
        assert capture.quick_check is not None
        assert capture.quick_check.verdict.quality == "good"
        assert capture.quality == "good"
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
