"""Archiving a capture (§6): copy, verify, record, then delete the source.

Archiving is the one operation that both writes bytes somewhere new and destroys
the originals, so the order is not negotiable: the copy is verified before the
ledger event, and the source is removed only after the event is durable. The
event carries enough to reconstruct the row (rev.2.1) because after this runs
there is nothing else left that describes the capture.
"""

from __future__ import annotations

from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import Settings, ledger_v2
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import ReplicaState


def _archive_client(
    data_dir: Path, roots: Path, fake_recorder: FakeRecorder
) -> TestClient:
    settings = Settings(
        data_dir=str(data_dir),
        archive_roots=str(roots),
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


def _seed(client: TestClient, layout: DataLayout) -> str:
    store = client.app.state.capture_store
    capture_id = new_capture_id()
    capture_dir = layout.capture_dir(capture_id)
    capture_dir.mkdir(parents=True)
    (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
    (capture_dir / "bag_0.mcap").write_bytes(b"\x89MCAP0\r\n" + b"payload" * 100)
    store.create_capture(
        Capture(
            capture_id=capture_id,
            run_id=f"run_{capture_id}",
            state=CaptureState.completed,
            operator="alice",
            task="pick",
            message_count=42,
            bytes=707,
            started_at="2026-08-01T00:00:00.000Z",
        )
    )
    store.upsert_replica(
        capture_id,
        client.app.state.instance_id,
        ReplicaState.present_unverified,
        path=str(capture_dir),
    )
    return capture_id


class TestArchive:
    def test_archiving_copies_verifies_records_then_removes_the_source(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)

            destination = roots / "batch_a"
            response = client.post(
                f"/api/v1/captures/{capture_id}/archive",
                json={"destination": str(destination), "operator": "alice"},
            )
            assert response.status_code == 200
            body = response.json()
            assert body["files"] == 2
            assert body["bytes"] > 0

            copied = destination / capture_id
            assert (copied / "metadata.yaml").is_file()
            assert (copied / "bag_0.mcap").is_file()
            # The source goes through the same trash pathway as any deletion,
            # so an archive interrupted at the last step recovers identically.
            assert not layout.capture_dir(capture_id).exists()

            capture = client.app.state.capture_store.get_capture(capture_id)
            assert capture.archive_destination == str(copied)
            assert capture.archived_at is not None

    def test_the_event_carries_enough_to_rebuild_the_row(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)
            client.post(
                f"/api/v1/captures/{capture_id}/archive",
                json={"destination": str(roots)},
            )

        events = ledger_v2.archive_events(data_dir)
        event = events[capture_id]
        # rev.2.1: archiving deletes the local copy, so this event is the ONLY
        # surviving description of the capture. A rebuild after the database is
        # lost has nothing else to reconstruct the row from.
        assert event["operator"] == "alice"
        assert event["task"] == "pick"
        assert event["bytes"] == 707
        assert event["message_count"] == 42
        assert event["run_id"].startswith("run_")

    def test_a_destination_outside_the_allow_list_is_refused(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)
            response = client.post(
                f"/api/v1/captures/{capture_id}/archive",
                json={"destination": str(tmp_path / "elsewhere")},
            )
            # This endpoint deletes the source afterwards, which makes an
            # unconstrained destination "copy anywhere, then remove the
            # original".
            assert response.status_code == 400
            assert response.json()["error"]["code"] == "destination_not_allowed"
            assert layout.capture_dir(capture_id).exists()

    def test_archiving_is_not_offered_without_configured_roots(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _seed(client, layout)
        config = client.get(f"/api/v1/captures/{capture_id}/archive/config").json()
        # Better than a control that can only ever 400.
        assert config == {"enabled": False, "roots": []}

    def test_a_dataset_member_cannot_be_archived(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)
            dataset = client.post("/api/v1/datasets", json={"name": "ds"}).json()
            client.post(
                f"/api/v1/datasets/{dataset['dataset_id']}/members",
                json={"capture_id": capture_id},
            )
            response = client.post(
                f"/api/v1/captures/{capture_id}/archive",
                json={"destination": str(roots)},
            )
            # Archiving removes the local copy, which would leave the dataset
            # citing a capture whose bytes are somewhere the dataset cannot say.
            assert response.status_code == 400
            assert response.json()["error"]["code"] == "capture_in_dataset"

    def test_a_capture_with_no_local_copy_cannot_be_archived(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            store = client.app.state.capture_store
            capture_id = new_capture_id()
            store.create_capture(
                Capture(
                    capture_id=capture_id,
                    run_id="run_absent",
                    state=CaptureState.completed,
                    started_at="2026-08-01T00:00:00.000Z",
                )
            )
            response = client.post(
                f"/api/v1/captures/{capture_id}/archive",
                json={"destination": str(roots)},
            )
            assert response.status_code == 409
            assert response.json()["error"]["code"] == "capture_not_present"
