"""Startup rebuild (§8): the catalog reconstructed from what is on disk.

``kairos.db`` is an index, not the truth. Deleting it and restarting must bring
the catalog back, because the sidecars beside each capture plus the lifecycle
ledger hold everything the database caches. These tests drive that through the
real startup path, including the two triggers that are easy to get wrong — a
missing database and a wrong schema version — and the one condition that must
stop the process rather than degrade.
"""

from __future__ import annotations

import json

import httpx
import pytest
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.bootstrap import StoreStartupError
from api_orchestrator.layout import DataLayout
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import ledger_v2
from kairos_common.capture_sidecars import (
    ObjectManifestV2,
    write_failed_start,
    write_object_manifest,
)
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import ReplicaState


def _manifest(capture_id: str, instance: str, **fields: object) -> ObjectManifestV2:
    defaults: dict[str, object] = {
        "capture_id": capture_id,
        "source_instance_id": instance,
        "run_id": f"run_{capture_id[:13]}",
        "state": "completed",
        "started_at": "2026-08-01T00:00:00.000Z",
        "ended_at": "2026-08-01T00:01:00.000Z",
        "operator": "alice",
        "task": "pick",
        "message_count": 100,
        "bytes": 4096,
    }
    defaults.update(fields)
    return ObjectManifestV2(**defaults)  # type: ignore[arg-type]


def _write_capture(
    layout: DataLayout, instance: str, *, with_bag: bool = True, **fields: object
) -> str:
    """A capture that exists only on disk — no database row anywhere."""
    capture_id = str(fields.pop("capture_id", None) or new_capture_id())
    capture_dir = layout.capture_dir(capture_id)
    capture_dir.mkdir(parents=True, exist_ok=True)
    if with_bag:
        (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
        (capture_dir / "bag_0.mcap").write_bytes(b"\x89MCAP0\r\n")
    write_object_manifest(capture_dir, _manifest(capture_id, instance, **fields))
    return capture_id


def _boot(settings, fake_recorder: FakeRecorder) -> TestClient:
    app = create_orchestrator_app(
        settings,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(fake_recorder.handler)
        ),
    )
    return TestClient(app)


class TestRebuildTriggers:
    def test_a_missing_database_is_rebuilt_from_the_sidecars(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        capture_id = _write_capture(layout, instance_id)
        assert not layout.db.exists()

        with _boot(settings, fake_recorder) as client:
            body = client.get(f"/api/v1/captures/{capture_id}").json()
            assert body["operator"] == "alice"
            assert body["message_count"] == 100
            assert body["replica"]["state"] == "present_unverified"

            health = client.get("/api/v1/store/health").json()
            assert health["rebuild_summary"]["trigger"] == "missing_database"
            assert health["rebuild_summary"]["captures"] == 1

    def test_a_wrong_schema_version_is_discarded_and_rebuilt(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        import sqlite3

        capture_id = _write_capture(layout, instance_id)
        conn = sqlite3.connect(layout.db)
        conn.execute("PRAGMA user_version = 1")
        conn.execute("CREATE TABLE runs (run_id TEXT)")
        conn.commit()
        conn.close()

        with _boot(settings, fake_recorder) as client:
            # No migration: the v1 database is thrown away and the catalog comes
            # back from the sidecars (§8).
            assert client.get(f"/api/v1/captures/{capture_id}").status_code == 200
            health = client.get("/api/v1/store/health").json()
            assert health["rebuild_summary"]["trigger"] == "schema_mismatch"

    def test_a_healthy_database_is_not_rebuilt(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        _write_capture(layout, instance_id)
        with _boot(settings, fake_recorder):
            pass
        with _boot(settings, fake_recorder) as client:
            # The second boot found a v2 database that already exists, so it
            # trusts the index rather than re-scanning every capture.
            assert client.get("/api/v1/store/health").json()["rebuild_summary"] is None

    def test_the_rebuild_env_flag_forces_a_scan(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
        monkeypatch,
    ) -> None:
        _write_capture(layout, instance_id)
        with _boot(settings, fake_recorder):
            pass
        monkeypatch.setenv("KAIROS_REBUILD", "1")
        with _boot(settings, fake_recorder) as client:
            assert (
                client.get("/api/v1/store/health").json()["rebuild_summary"]["trigger"]
                == "requested"
            )


class TestNormalisation:
    def test_an_abandoned_recording_becomes_interrupted(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        capture_id = _write_capture(layout, instance_id, state="recording")
        with _boot(settings, fake_recorder) as client:
            body = client.get(f"/api/v1/captures/{capture_id}").json()
        # A `recording` row after a restart is a lie no later event corrects:
        # nothing is writing to it any more (§8 rule 2).
        assert body["state"] == "interrupted"

    def test_a_recording_manifest_with_no_bag_becomes_failed(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        capture_id = _write_capture(
            layout, instance_id, state="recording", with_bag=False
        )
        with _boot(settings, fake_recorder) as client:
            body = client.get(f"/api/v1/captures/{capture_id}").json()
        # Matches the recorder's own finalise judgement, so a crash and a clean
        # stop classify the same bag identically.
        assert body["state"] == "failed"

    def test_a_live_capture_is_left_to_the_recorder(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        capture_id = _write_capture(layout, instance_id, state="recording")
        fake_recorder.state = "recording"
        fake_recorder.capture_id = capture_id
        fake_recorder.run_id = "run_live"

        with _boot(settings, fake_recorder) as client:
            # Excluded entirely (§8 rule 1): the recorder is still its sole
            # writer and the normal finalise path will produce the row.
            assert client.get(f"/api/v1/captures/{capture_id}").status_code == 404

    def test_a_failed_start_sidecar_becomes_a_failed_row(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        capture_id = new_capture_id()
        write_failed_start(
            layout.data_dir,
            _manifest(capture_id, instance_id, state="failed", error="no such topic"),
        )
        with _boot(settings, fake_recorder) as client:
            body = client.get(f"/api/v1/captures/{capture_id}").json()
        assert body["state"] == "failed"
        assert body["error"]["message"] == "no such topic"

    def test_the_ledger_outranks_a_manifest_that_survived(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        capture_id = _write_capture(layout, instance_id)
        ledger_v2.append(
            layout.data_dir,
            "capture_discarded",
            instance_id=instance_id,
            capture_id=capture_id,
            payload={"reason": "operator discarded"},
        )

        with _boot(settings, fake_recorder) as client:
            body = client.get(f"/api/v1/captures/{capture_id}").json()
        # Believing the manifest would resurrect data somebody deliberately
        # destroyed (§8 rule 3), and the startup delete-resume then finishes the
        # removal the crash interrupted.
        assert body["state"] == "discarded"
        assert not layout.capture_dir(capture_id).exists()

    def test_a_corrupt_manifest_is_reported_not_dropped(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        capture_id = new_capture_id()
        capture_dir = layout.capture_dir(capture_id)
        capture_dir.mkdir(parents=True)
        # The signature of a crash between rename and writeback.
        (capture_dir / "object_manifest.json").write_bytes(b"")

        with _boot(settings, fake_recorder) as client:
            health = client.get("/api/v1/store/health").json()
            # No row is fabricated — the manifest was the only thing that could
            # say what this capture IS — but the bytes are reported so one bad
            # write cannot erase a recording from the catalog silently.
            assert client.get(f"/api/v1/captures/{capture_id}").status_code == 404
        assert [c["capture_id"] for c in health["corrupt"]] == [capture_id]
        assert "empty file" in health["corrupt"][0]["reason"]

    def test_review_state_is_restored_from_record_json(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        capture_id = _write_capture(layout, instance_id)
        (layout.capture_dir(capture_id) / "record.json").write_text(
            json.dumps(
                {
                    "schema_version": 2,
                    "capture_id": capture_id,
                    "revision": 3,
                    "review_status": "adopted",
                    "task_result": "success",
                    "quality": "good",
                    "quality_source": "operator",
                    "batch_id": "batch_1",
                    "index_in_batch": 4,
                    "updated_at": "2026-08-01T00:02:00.000Z",
                }
            ),
            encoding="utf-8",
        )
        with _boot(settings, fake_recorder) as client:
            body = client.get(f"/api/v1/captures/{capture_id}").json()
        assert body["review_status"] == "adopted"
        assert body["review_revision"] == 3
        assert body["batch_id"] == "batch_1"

    def test_an_archived_capture_is_reconstructed_from_its_event(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        capture_id = new_capture_id()
        ledger_v2.append(
            layout.data_dir,
            "capture_archived",
            instance_id=instance_id,
            capture_id=capture_id,
            payload={
                "destination": "/mnt/nas/datasets/x",
                "run_id": "run_archived",
                "operator": "alice",
                "task": "pick",
                "bytes": 4096,
                "message_count": 10,
            },
        )
        with _boot(settings, fake_recorder) as client:
            body = client.get(f"/api/v1/captures/{capture_id}").json()
        # A successful archive leaves nothing under objects/, so without this
        # the capture would silently vanish on the next rebuild — and "where did
        # episode 11 go" would be unanswerable again.
        assert body["archive_destination"] == "/mnt/nas/datasets/x"
        assert body["operator"] == "alice"
        assert body["replica"]["state"] == ReplicaState.absent_managed


class TestFatalConditions:
    def test_an_unreadable_ledger_aborts_startup(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        _write_capture(layout, instance_id)
        # A directory where the ledger should be: it exists, and it cannot be
        # read, which is different from "nothing was ever deleted".
        ledger_v2.ledger_path(layout.data_dir).mkdir()

        with (
            pytest.raises(StoreStartupError) as excinfo,
            _boot(settings, fake_recorder),
        ):
            pass
        message = str(excinfo.value)
        # The message has to tell an operator what to do, because the process is
        # refusing to start and the reason is not obvious from a stack trace.
        assert "lifecycle.jsonl" in message
        assert "deliberately destroyed" in message

    def test_a_corrupt_instance_file_stops_app_construction(
        self, settings, layout: DataLayout
    ) -> None:
        (layout.data_dir / "instance.json").write_bytes(b"")
        with pytest.raises(StoreStartupError) as excinfo:
            create_orchestrator_app(settings)
        # Minting a replacement id is the one outcome that cannot be undone: it
        # would orphan every replica row and sidecar naming the old one.
        assert "instance.json" in str(excinfo.value)


class TestCatalogSidecars:
    def test_validation_templates_survive_a_database_rebuild(
        self, settings, fake_recorder: FakeRecorder, layout: DataLayout
    ) -> None:
        with _boot(settings, fake_recorder) as client:
            client.post(
                "/api/v1/validation/templates",
                json={"name": "t", "version": 1, "required_topics": []},
            )
        layout.db.unlink()

        with _boot(settings, fake_recorder) as client:
            items = client.get("/api/v1/validation/templates").json()["items"]
        # The templates have no sidecar of their own, so saving one mirrors the
        # catalog to catalog/*.json — otherwise a rebuild would quietly lose the
        # UI's vocabulary (§8).
        assert [t["name"] for t in items] == ["t"]
