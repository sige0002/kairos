# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Browser recording-control lease: reject accidental remote normal stops."""

from __future__ import annotations

from fastapi.testclient import TestClient


def _start(client: TestClient) -> dict[str, object]:
    response = client.post("/api/v1/record/start", json={"topics": ["/joint_states"]})
    assert response.status_code == 200, response.text
    return response.json()


def _stop(client: TestClient, capture_id: str):
    return client.post("/api/v1/record/stop", json={"capture_id": capture_id})


def test_owner_can_normally_stop_and_status_reports_control(client: TestClient) -> None:
    started = _start(client)
    capture_id = str(started["capture_id"])
    assert client.get("/api/v1/record/status").json()["control"] == {
        "capture_id": capture_id,
        "controlled_by_this_client": True,
        "lease_known": True,
    }
    assert _stop(client, capture_id).status_code == 200


def test_owner_can_retry_same_stop_after_a_lost_success_response(
    client: TestClient, fake_recorder
) -> None:
    started = _start(client)
    capture_id = str(started["capture_id"])

    assert _stop(client, capture_id).status_code == 200
    calls_after_first_stop = fake_recorder.stop_call_count
    retried = _stop(client, capture_id)

    assert retried.status_code == 200
    assert retried.json()["capture_id"] == capture_id
    assert fake_recorder.stop_call_count == calls_after_first_stop


def test_stale_stop_cannot_disarm_a_newer_prepared_capture(
    client: TestClient, fake_recorder
) -> None:
    started = _start(client)
    capture_id = str(started["capture_id"])
    assert _stop(client, capture_id).status_code == 200

    prepared = client.post("/api/v1/record/prepare", json={"topics": ["/joint_states"]})
    assert prepared.status_code == 200, prepared.text
    prepared_id = str(prepared.json()["capture_id"])
    calls_before_stale_stop = fake_recorder.stop_call_count

    stale_normal = _stop(client, capture_id)
    stale_force = client.post(
        "/api/v1/record/force-stop", json={"capture_id": capture_id}
    )

    assert stale_normal.status_code == 409
    assert stale_force.status_code == 409
    assert stale_force.json()["error"]["details"]["active_capture_id"] == prepared_id
    assert fake_recorder.stop_call_count == calls_before_stale_stop


def test_start_lifecycle_and_lease_issuance_share_the_control_operation_lock(
    client: TestClient, monkeypatch
) -> None:
    """A force-stop/takeover cannot interleave before the start lease issues."""
    service = client.app.state.record_service
    original_start = service.start

    async def assert_control_admitted(body):
        assert client.app.state.record_control.operation_lock.locked()
        return await original_start(body)

    monkeypatch.setattr(service, "start", assert_control_admitted)
    started = _start(client)
    assert client.get("/api/v1/record/status").json()["control"] == {
        "capture_id": str(started["capture_id"]),
        "controlled_by_this_client": True,
        "lease_known": True,
    }


def test_missing_or_wrong_token_never_calls_recorder_stop(
    client: TestClient, fake_recorder
) -> None:
    started = _start(client)
    capture_id = str(started["capture_id"])
    client.cookies.clear()
    rejected = _stop(client, capture_id)
    assert rejected.status_code == 409
    assert rejected.json()["error"]["code"] == "record_control_token_invalid"
    assert fake_recorder.stop_call_count == 0


def test_capture_mismatch_is_fail_closed(client: TestClient, fake_recorder) -> None:
    _start(client)
    rejected = _stop(client, "01920000-0000-7000-8000-0000000000ff")
    assert rejected.status_code == 409
    assert rejected.json()["error"]["code"] == "record_control_capture_mismatch"
    assert fake_recorder.stop_call_count == 0


def test_takeover_rotates_the_token_and_invalidates_the_old_owner(
    client: TestClient, fake_recorder
) -> None:
    started = _start(client)
    capture_id = str(started["capture_id"])
    old_cookie = client.cookies.get("kairos_record_control")
    client.cookies.clear()
    taken = client.post("/api/v1/record/takeover", json={"capture_id": capture_id})
    assert taken.status_code == 200
    new_cookie = client.cookies.get("kairos_record_control")
    assert new_cookie and new_cookie != old_cookie
    client.cookies.set("kairos_record_control", old_cookie)
    rejected = _stop(client, capture_id)
    assert rejected.status_code == 409
    assert fake_recorder.stop_call_count == 0


def test_force_stop_is_explicit_recovery_and_restart_requires_takeover(
    client: TestClient, fake_recorder
) -> None:
    started = _start(client)
    capture_id = str(started["capture_id"])
    # Replacing the in-memory lease models an orchestrator restart.  The old
    # cookie must not silently regain ownership.
    from api_orchestrator.record_control import RecordControlService

    client.app.state.record_control = RecordControlService()
    rejected = _stop(client, capture_id)
    assert rejected.status_code == 409
    assert rejected.json()["error"]["code"] == "record_control_recovery_required"
    assert fake_recorder.stop_call_count == 0
    forced = client.post("/api/v1/record/force-stop", json={"capture_id": capture_id})
    assert forced.status_code == 200
    assert fake_recorder.stop_call_count == 1


def test_restart_recovery_can_take_over_then_normally_stop(
    client: TestClient, fake_recorder
) -> None:
    started = _start(client)
    capture_id = str(started["capture_id"])
    from api_orchestrator.record_control import RecordControlService

    client.app.state.record_control = RecordControlService()
    recovered = client.post("/api/v1/record/takeover", json={"capture_id": capture_id})
    assert recovered.status_code == 200
    assert _stop(client, capture_id).status_code == 200
    assert fake_recorder.stop_call_count == 1


def test_stale_target_never_returns_or_stops_a_newer_last_capture(
    client: TestClient, fake_recorder
) -> None:
    first = _start(client)
    first_id = str(first["capture_id"])
    assert _stop(client, first_id).status_code == 200
    second = _start(client)
    second_id = str(second["capture_id"])
    assert _stop(client, second_id).status_code == 200

    # Model a stale but otherwise valid old browser lease against a recorder
    # that already completed the newer take.  _stop must not return B for A.
    token = client.app.state.record_control.issue_for_start(first_id)
    client.cookies.set("kairos_record_control", token)
    before = fake_recorder.stop_call_count
    stale = _stop(client, first_id)
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "record_control_capture_mismatch"
    assert fake_recorder.stop_call_count == before
