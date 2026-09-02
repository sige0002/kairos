# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Collection context is frozen before recording and enforced on review."""

from __future__ import annotations

from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.models import Capture, CaptureState, CollectionContextSnapshot
from conftest import FakeRecorder, stop_owned
from fastapi.testclient import TestClient
from kairos_common import Settings
from kairos_common.capture_sidecars import RecordV2, write_record
from kairos_common.ids import new_capture_id


def _batch(client: TestClient) -> dict[str, object]:
    response = client.post(
        "/api/v1/batches",
        json={
            "project": "project-a",
            "project_id": "project-a-id",
            "task": "pick",
            "task_id": "pick-id",
            "condition": "dry",
            "condition_id": "dry-id",
            "operator": "operator-a",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _context(batch: dict[str, object]) -> dict[str, object]:
    return {
        name: batch[name]
        for name in (
            "batch_id",
            "batch_seq",
            "project_id",
            "task_id",
            "condition_id",
            "project",
            "task",
            "condition",
            "robot",
            "operator",
        )
    }


def _start_with_context(
    client: TestClient, batch: dict[str, object]
) -> dict[str, object]:
    response = client.post(
        "/api/v1/record/start",
        json={
            "topics": ["/joint_states"],
            "operator": "operator-a",
            "task": "pick",
            "collection_context": _context(batch),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_start_freezes_context_on_the_row_and_recorder_payload(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    batch = _batch(client)
    capture = _start_with_context(client, batch)

    assert capture["batch_id"] == batch["batch_id"]
    assert capture["collection_context"] == _context(batch)
    assert fake_recorder.last_start_payload is not None
    assert fake_recorder.last_start_payload["collection_context"] == _context(batch)


def test_start_rejects_context_that_disagrees_with_recording_labels(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    batch = _batch(client)
    response = client.post(
        "/api/v1/record/start",
        json={
            "topics": ["/joint_states"],
            "operator": "someone-else",
            "task": "pick",
            "collection_context": _context(batch),
        },
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "collection_context_operator_mismatch"
    assert fake_recorder.last_start_payload is None


def test_start_rejects_a_stale_canonical_context_id(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    batch = _batch(client)
    context = _context(batch)
    context["condition_id"] = "condition-stale-id"

    response = client.post(
        "/api/v1/record/start",
        json={
            "topics": ["/joint_states"],
            "operator": "operator-a",
            "task": "pick",
            "collection_context": context,
        },
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "batch_condition_id_mismatch"
    assert fake_recorder.last_start_payload is None


def test_empty_batch_context_keeps_unknown_labels_null(client: TestClient) -> None:
    created = client.post("/api/v1/batches", json={"target_episodes": 1})
    assert created.status_code == 201, created.text
    batch = created.json()
    response = client.post(
        "/api/v1/record/start",
        json={"topics": ["/joint_states"], "collection_context": _context(batch)},
    )
    assert response.status_code == 200, response.text
    context = response.json()["collection_context"]
    assert context["operator"] is None
    assert context["task"] is None


def test_future_context_fields_round_trip_to_the_recorder(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    batch = _batch(client)
    context = _context(batch)
    context["future_label"] = "future-value"
    response = client.post(
        "/api/v1/record/start",
        json={
            "topics": ["/joint_states"],
            "operator": "operator-a",
            "task": "pick",
            "collection_context": context,
        },
    )
    assert response.status_code == 200, response.text
    assert fake_recorder.last_start_payload is not None
    assert (
        fake_recorder.last_start_payload["collection_context"]["future_label"]
        == "future-value"
    )
    assert response.json()["collection_context"]["future_label"] == "future-value"


def test_context_batch_cannot_be_cleared_and_allows_later_same_batch_review(
    client: TestClient,
) -> None:
    batch = _batch(client)
    capture = _start_with_context(client, batch)
    batch_id = str(batch["batch_id"])
    ended = client.patch(f"/api/v1/batches/{batch_id}", json={"status": "completed"})
    assert ended.status_code == 200, ended.text

    saved = client.patch(
        f"/api/v1/captures/{capture['capture_id']}/review",
        json={"base_revision": 0, "review_status": "adopted", "batch_id": batch_id},
    )
    assert saved.status_code == 200, saved.text
    assert client.get(f"/api/v1/batches/{batch_id}").json()["episodes_recorded"] == 1

    refused = client.patch(
        f"/api/v1/captures/{capture['capture_id']}/review",
        json={"base_revision": 1, "batch_id": None},
    )
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "batch_context_mismatch"


def test_new_legacy_association_to_terminal_batch_is_refused(
    client: TestClient,
) -> None:
    batch = _batch(client)
    batch_id = str(batch["batch_id"])
    capture = client.post("/api/v1/record/start", json={"topics": ["/joint_states"]})
    assert capture.status_code == 200, capture.text
    assert (
        client.patch(
            f"/api/v1/batches/{batch_id}", json={"status": "completed"}
        ).status_code
        == 200
    )

    refused = client.patch(
        f"/api/v1/captures/{capture.json()['capture_id']}/review",
        json={"base_revision": 0, "review_status": "adopted", "batch_id": batch_id},
    )
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "batch_not_active"


def test_unbatched_context_can_join_a_later_matching_batch(
    client: TestClient,
    fake_recorder: FakeRecorder,
    settings: Settings,
    data_dir: Path,
) -> None:
    context = {
        "batch_id": None,
        "batch_seq": None,
        "project": "project-a",
        "task": "pick",
        "condition": "dry",
        "robot": None,
        "operator": "operator-a",
    }
    started = client.post(
        "/api/v1/record/start",
        json={
            "topics": ["/joint_states"],
            "operator": "operator-a",
            "task": "pick",
            "collection_context": context,
        },
    )
    assert started.status_code == 200, started.text
    batch = _batch(client)

    saved = client.patch(
        f"/api/v1/captures/{started.json()['capture_id']}/review",
        json={
            "base_revision": 0,
            "review_status": "adopted",
            "batch_id": batch["batch_id"],
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["batch_id"] == batch["batch_id"]
    assert stop_owned(client).status_code == 200
    client.close()
    (data_dir / "kairos.db").unlink()

    app = create_orchestrator_app(
        settings,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(fake_recorder.handler)
        ),
    )
    with TestClient(app) as reopened:
        restored = reopened.get(
            f"/api/v1/captures/{started.json()['capture_id']}"
        ).json()
        assert restored["batch_id"] == batch["batch_id"]


def test_unbatched_context_refuses_a_later_mismatched_batch(
    client: TestClient,
) -> None:
    context = {
        "batch_id": None,
        "batch_seq": None,
        "project": "project-a",
        "task": "pick",
        "condition": "dry",
        "robot": None,
        "operator": "operator-a",
    }
    started = client.post(
        "/api/v1/record/start",
        json={
            "topics": ["/joint_states"],
            "operator": "operator-a",
            "task": "pick",
            "collection_context": context,
        },
    )
    assert started.status_code == 200, started.text
    mismatched = client.post(
        "/api/v1/batches",
        json={
            "project": "project-a",
            "task": "pick",
            "condition": "wet",
            "operator": "operator-a",
        },
    )
    assert mismatched.status_code == 201, mismatched.text

    refused = client.patch(
        f"/api/v1/captures/{started.json()['capture_id']}/review",
        json={
            "base_revision": 0,
            "review_status": "adopted",
            "batch_id": mismatched.json()["batch_id"],
        },
    )
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "batch_context_mismatch"


def test_rebuild_restores_manifest_context_and_start_batch(
    client: TestClient,
    fake_recorder: FakeRecorder,
    settings: Settings,
    data_dir: Path,
) -> None:
    batch = _batch(client)
    capture = _start_with_context(client, batch)
    assert stop_owned(client).status_code == 200
    client.close()
    (data_dir / "kairos.db").unlink()

    app = create_orchestrator_app(
        settings,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(fake_recorder.handler)
        ),
    )
    with TestClient(app) as reopened:
        restored = reopened.get(f"/api/v1/captures/{capture['capture_id']}").json()
        assert restored["batch_id"] == batch["batch_id"]
        assert restored["collection_context"] == _context(batch)
        # The start association is not proof of a first review. Rebuild's
        # counter remains a floor over reviewed captures only.
        assert (
            reopened.get(f"/api/v1/batches/{batch['batch_id']}").json()[
                "episodes_recorded"
            ]
            == 0
        )


def test_mid_recording_db_loss_recovers_context_before_stop(
    client: TestClient,
    fake_recorder: FakeRecorder,
    settings: Settings,
    data_dir: Path,
) -> None:
    batch = _batch(client)
    capture = _start_with_context(client, batch)
    client.close()
    (data_dir / "kairos.db").unlink()

    app = create_orchestrator_app(
        settings,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(fake_recorder.handler)
        ),
    )
    with TestClient(app) as reopened:
        stopped = reopened.post(
            "/api/v1/record/force-stop", json={"capture_id": capture["capture_id"]}
        )
        assert stopped.status_code == 200, stopped.text
        recovered = reopened.get(f"/api/v1/captures/{capture['capture_id']}").json()
        assert recovered["batch_id"] == batch["batch_id"]
        assert recovered["collection_context"] == _context(batch)


def test_ahead_sidecar_counts_its_first_review_once(client: TestClient) -> None:
    batch = _batch(client)
    batch_id = str(batch["batch_id"])
    capture_id = new_capture_id()
    context = CollectionContextSnapshot.model_validate(_context(batch))
    store = client.app.state.capture_store
    layout = client.app.state.data_layout
    # A rebuild's counter is a lower bound. A newly adopted first review must
    # add one, but cannot turn historical uncertainty into an exact count.
    store.rebuild_episodes_recorded(batch_id)
    store.create_capture(
        Capture(
            capture_id=capture_id,
            run_id=f"run_{capture_id}",
            state=CaptureState.completed,
            batch_id=batch_id,
            collection_context=context,
        )
    )
    capture_dir = layout.capture_dir(capture_id)
    capture_dir.mkdir(parents=True)
    write_record(
        capture_dir,
        RecordV2(
            capture_id=capture_id,
            revision=1,
            review_status="adopted",
            task_result="success",
            batch_id=batch_id,
        ),
    )

    adopted = client.patch(
        f"/api/v1/captures/{capture_id}/review",
        json={"base_revision": 0, "review_status": "adopted", "batch_id": batch_id},
    )
    assert adopted.status_code == 409
    restored_batch = store.get_batch(batch_id)
    assert restored_batch is not None
    assert restored_batch.episodes_recorded == 1
    assert restored_batch.episodes_recorded_is_floor is True

    assert not store.adopt_review_from_sidecar(
        capture_id,
        base_revision=0,
        revision=1,
        fields={
            "review_status": "adopted",
            "task_result": "success",
            "failure_reason": None,
            "quality": None,
            "quality_source": None,
            "batch_id": batch_id,
            "index_in_batch": None,
        },
    )
    assert store.get_batch(batch_id).episodes_recorded == 1

    saved = client.patch(
        f"/api/v1/captures/{capture_id}/review",
        json={"base_revision": 1, "review_status": "excluded", "batch_id": batch_id},
    )
    assert saved.status_code == 200, saved.text
    assert store.get_batch(batch_id).episodes_recorded == 1


def test_rebuild_keeps_manifest_context_over_an_inconsistent_record_batch(
    client: TestClient,
    fake_recorder: FakeRecorder,
    settings: Settings,
    data_dir: Path,
) -> None:
    batch = _batch(client)
    capture = _start_with_context(client, batch)
    assert stop_owned(client).status_code == 200
    write_record(
        data_dir / "objects" / str(capture["capture_id"]),
        RecordV2(
            capture_id=str(capture["capture_id"]),
            revision=1,
            review_status="adopted",
            batch_id="inconsistent-batch",
        ),
    )
    # ``TestClient.close()`` closes HTTP transport only; ending the context is
    # what runs the app lifespan and drains stop-time work before this test
    # replaces the catalog file.
    client.__exit__(None, None, None)
    (data_dir / "kairos.db").unlink()

    app = create_orchestrator_app(
        settings,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(fake_recorder.handler)
        ),
    )
    with TestClient(app) as reopened:
        restored = reopened.get(f"/api/v1/captures/{capture['capture_id']}").json()
        assert restored["batch_id"] == batch["batch_id"]
        assert restored["collection_context"] == _context(batch)
