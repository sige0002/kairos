"""Deletion (§7): the trash pathway, its guards, and resuming a crash.

§7's five steps are ordered so that every prefix of them is recoverable, and
that is what this file tests. The sequence is:

1. append the ledger tombstone (fatal — nothing is destroyed before this);
2. mark the row ``delete_pending`` (a durable marker of intent, written BEFORE
   the rename rather than as a record of a failure);
3. rename ``objects/<id>`` into ``.trash`` (atomic, same filesystem);
4. commit the tombstone state;
5. reap: physically remove, then VERIFY absence before saying so.

Each "crash" test below leaves the store in the state a kill at that point would
produce, restarts the process, and asserts the deletion finishes. The one thing
that must never happen at any step is a capture that is gone from disk with no
record of who removed it.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from api_orchestrator import layout as layout_mod
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState, ReviewSaveRequest
from api_orchestrator.store import CaptureStore
from conftest import FakeRecorder, reconcile
from fastapi.testclient import TestClient
from kairos_common import ledger_v2
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import ReplicaState


def _seed_on_disk(store: CaptureStore, layout: DataLayout, **fields: object) -> str:
    """A completed capture with real bytes under ``objects/``."""
    capture_id = str(fields.pop("capture_id", None) or new_capture_id())
    defaults: dict[str, object] = {
        "capture_id": capture_id,
        "run_id": f"run_{capture_id}",
        "state": CaptureState.completed,
        "operator": "alice",
        "task": "pick",
        "started_at": "2026-08-01T00:00:00.000Z",
    }
    defaults.update(fields)
    store.create_capture(Capture(**defaults))  # type: ignore[arg-type]
    store.upsert_replica(
        capture_id,
        store.instance_id or "",
        ReplicaState.present_unverified,
        path=str(layout.capture_dir(capture_id)),
    )
    capture_dir = layout.capture_dir(capture_id)
    capture_dir.mkdir(parents=True, exist_ok=True)
    (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
    return capture_id


def _restart(settings, fake_recorder: FakeRecorder) -> TestClient:
    """A fresh process against the same data directory."""
    app = create_orchestrator_app(
        settings,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(fake_recorder.handler)
        ),
    )
    return TestClient(app)


class TestDeleteHappyPath:
    @pytest.mark.parametrize(
        ("kind", "expected_state", "expected_event"),
        [
            ("discard", "discarded", "capture_discarded"),
            ("delete", "deleted", "capture_deleted"),
        ],
    )
    def test_a_delete_buries_the_capture_and_records_why(
        self,
        client: TestClient,
        layout: DataLayout,
        kind: str,
        expected_state: str,
        expected_event: str,
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)

        response = client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": kind, "reason": "bad take"},
        )
        assert response.status_code == 200
        assert response.json()["state"] == expected_state

        # The row survives as a tombstone: "where did episode 11 go" is the
        # question the ledger and this row exist to answer (§7).
        capture = store.get_capture(capture_id)
        assert capture is not None
        assert capture.delete_reason == "bad take"
        assert capture.deleted_at is not None

        events = ledger_v2.read_all(layout.data_dir)
        assert [e["kind"] for e in events] == [expected_event]
        assert events[0]["capture_id"] == capture_id

        assert not layout.capture_dir(capture_id).exists()

    def test_the_reaper_verifies_absence_before_saying_the_copy_is_gone(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "delete", "reason": "done"},
        )
        # The route schedules the reaper as a background task, which TestClient
        # runs before the response is returned.
        replica = store.get_replica(capture_id, store.instance_id or "")
        assert replica is not None
        assert replica.state == ReplicaState.absent_managed
        assert not (layout.trash / capture_id).exists()

    def test_sibling_files_go_to_the_trash_too(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        sibling = layout.objects / f"{capture_id}.failed.json"
        sibling.write_text("{}", encoding="utf-8")

        client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "delete", "reason": "done"},
        )
        # A deletion that leaves the failed-start marker behind resurrects the
        # capture on the next rebuild (§3.4).
        assert not sibling.exists()

    def test_deleting_twice_is_idempotent(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        body = {"kind": "delete", "reason": "done"}
        client.post(f"/api/v1/captures/{capture_id}/delete", json=body)
        second = client.post(f"/api/v1/captures/{capture_id}/delete", json=body)

        assert second.status_code == 200
        # One operator action, one ledger line.
        assert len(ledger_v2.read_all(layout.data_dir)) == 1


class TestDeleteGuards:
    def test_a_recording_capture_cannot_be_deleted(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout, state=CaptureState.recording)
        response = client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "delete", "reason": "oops"},
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "capture_recording"

    def test_a_leased_capture_is_busy_not_deletable(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        store.acquire_lease(capture_id, "digest", ttl_s=300)

        response = client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "delete", "reason": "now"},
        )
        # Renaming the directory out from under a running digest is exactly what
        # the lease exists to prevent (§7.1).
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "capture_busy"

    def test_an_expired_lease_does_not_block(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        store.acquire_lease(capture_id, "digest", ttl_s=-1)
        # A job that died holding a lease must not lock its capture out of
        # deletion forever.
        response = client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "delete", "reason": "now"},
        )
        assert response.status_code == 200

    def test_a_dataset_member_must_be_removed_first(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        dataset = client.post("/api/v1/datasets", json={"name": "ds"}).json()
        client.post(
            f"/api/v1/datasets/{dataset['dataset_id']}/members",
            json={"capture_id": capture_id},
        )

        response = client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "delete", "reason": "now"},
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "capture_in_dataset"

    def test_a_discard_without_a_reason_is_refused(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        response = client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "discard", "reason": "  "},
        )
        # A discard is irreversible and the ledger line is the only surviving
        # explanation of why the data is gone.
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "reason_required"

    def test_deletes_are_withdrawn_when_trash_is_on_another_filesystem(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        client.app.state.store_health.disable_deletes(
            ".trash is on a different filesystem from objects/"
        )
        response = client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "delete", "reason": "now"},
        )
        # §2 forbids the copy+delete fallback, so the capability is withdrawn
        # rather than silently degraded into a non-atomic operation.
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "delete_unavailable"

    def test_an_unwritable_ledger_stops_the_deletion_before_anything_moves(
        self, client: TestClient, layout: DataLayout, monkeypatch
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        monkeypatch.setattr(
            "api_orchestrator.captures.ledger_v2.append_with_slack_release",
            lambda *a, **k: (_ for _ in ()).throw(OSError("read-only file system")),
        )
        response = client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "delete", "reason": "now"},
        )
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "ledger_unwritable"
        # Ledger-first (§9-1): a capture is never destroyed without a record.
        assert layout.capture_dir(capture_id).exists()
        assert store.get_capture(capture_id).state == CaptureState.completed


class TestCrashResume:
    """Each test leaves the state a kill at one §7 step would produce."""

    def test_a_crash_after_the_ledger_append_resumes_on_the_next_start(
        self, settings, fake_recorder: FakeRecorder, layout: DataLayout
    ) -> None:
        store = CaptureStore(layout.db, data_dir=layout.data_dir)
        store.set_instance_id("11111111-1111-4111-8111-111111111111")
        capture_id = _seed_on_disk(store, layout)
        # Step 1 landed and nothing else did: the ledger claims a deletion that
        # never touched the row or the bytes.
        ledger_v2.append(
            layout.data_dir,
            "capture_discarded",
            instance_id="11111111-1111-4111-8111-111111111111",
            capture_id=capture_id,
            payload={"reason": "operator discarded"},
        )
        store.close()

        with _restart(settings, fake_recorder):
            pass

        reopened = CaptureStore(layout.db, data_dir=layout.data_dir)
        capture = reopened.get_capture(capture_id)
        assert capture is not None
        # The ledger is scanned on EVERY startup, not only after a rebuild,
        # because a crash here leaves no delete_pending row to find.
        assert capture.state == CaptureState.discarded
        assert not layout.capture_dir(capture_id).exists()
        reopened.close()

    def test_a_crash_after_delete_pending_but_before_the_rename_resumes(
        self, settings, fake_recorder: FakeRecorder, layout: DataLayout
    ) -> None:
        store = CaptureStore(layout.db, data_dir=layout.data_dir)
        store.set_instance_id("11111111-1111-4111-8111-111111111111")
        capture_id = _seed_on_disk(store, layout)
        ledger_v2.append(
            layout.data_dir,
            "capture_deleted",
            instance_id="11111111-1111-4111-8111-111111111111",
            capture_id=capture_id,
        )
        store.update_capture(
            capture_id,
            state=CaptureState.delete_pending,
            delete_kind="delete",
            deleted_at="2026-08-01T00:00:00.000Z",
        )
        store.close()

        with _restart(settings, fake_recorder):
            pass

        reopened = CaptureStore(layout.db, data_dir=layout.data_dir)
        assert reopened.get_capture(capture_id).state == CaptureState.deleted
        assert not layout.capture_dir(capture_id).exists()
        reopened.close()

    def test_a_crash_after_the_rename_but_before_the_tombstone_resumes(
        self, settings, fake_recorder: FakeRecorder, layout: DataLayout
    ) -> None:
        store = CaptureStore(layout.db, data_dir=layout.data_dir)
        store.set_instance_id("11111111-1111-4111-8111-111111111111")
        capture_id = _seed_on_disk(store, layout)
        ledger_v2.append(
            layout.data_dir,
            "capture_discarded",
            instance_id="11111111-1111-4111-8111-111111111111",
            capture_id=capture_id,
        )
        store.update_capture(
            capture_id, state=CaptureState.delete_pending, delete_kind="discard"
        )
        # The rename already happened; the process died before step 4.
        layout.trash.mkdir(parents=True, exist_ok=True)
        layout.capture_dir(capture_id).rename(layout.trash_dir(capture_id))
        store.close()

        with _restart(settings, fake_recorder):
            pass

        reopened = CaptureStore(layout.db, data_dir=layout.data_dir)
        assert reopened.get_capture(capture_id).state == CaptureState.discarded
        reopened.close()

    def test_a_crash_before_the_reap_leaves_the_reaper_to_finish(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        store = CaptureStore(layout.db, data_dir=layout.data_dir)
        instance = instance_id
        store.set_instance_id(instance)
        capture_id = _seed_on_disk(store, layout)
        ledger_v2.append(
            layout.data_dir,
            "capture_deleted",
            instance_id=instance,
            capture_id=capture_id,
        )
        store.update_capture(
            capture_id, state=CaptureState.deleted, delete_kind="delete"
        )
        layout.trash.mkdir(parents=True, exist_ok=True)
        layout.capture_dir(capture_id).rename(layout.trash_dir(capture_id))
        store.upsert_replica(capture_id, instance, ReplicaState.trashed)
        store.close()

        with _restart(settings, fake_recorder) as client:
            reconcile(client)
            replica = client.app.state.capture_store.get_replica(
                capture_id, client.app.state.instance_id
            )
        assert replica is not None
        assert replica.state == ReplicaState.absent_managed
        assert not layout.trash_dir(capture_id).exists()

    def test_the_resume_is_idempotent_across_repeated_restarts(
        self, settings, fake_recorder: FakeRecorder, layout: DataLayout
    ) -> None:
        store = CaptureStore(layout.db, data_dir=layout.data_dir)
        store.set_instance_id("11111111-1111-4111-8111-111111111111")
        capture_id = _seed_on_disk(store, layout)
        ledger_v2.append(
            layout.data_dir,
            "capture_discarded",
            instance_id="11111111-1111-4111-8111-111111111111",
            capture_id=capture_id,
        )
        store.close()

        for _ in range(3):
            with _restart(settings, fake_recorder):
                pass

        # Replaying the same tombstone must not append new events or change the
        # verdict; the resume is driven by what is on disk, not by a counter.
        assert len(ledger_v2.read_all(layout.data_dir)) == 1
        reopened = CaptureStore(layout.db, data_dir=layout.data_dir)
        assert reopened.get_capture(capture_id).state == CaptureState.discarded
        reopened.close()


class TestPartialTrashMove:
    """A kill INSIDE move_to_trash, between the two renames it performs (M1)."""

    def test_a_sibling_left_behind_is_trashed_by_the_resume(
        self, settings, fake_recorder: FakeRecorder, layout: DataLayout
    ) -> None:
        store = CaptureStore(layout.db, data_dir=layout.data_dir)
        store.set_instance_id("11111111-1111-4111-8111-111111111111")
        capture_id = _seed_on_disk(store, layout)
        sibling = layout.objects / f"{capture_id}.failed.json"
        sibling.write_text("{}", encoding="utf-8")
        ledger_v2.append(
            layout.data_dir,
            "capture_deleted",
            instance_id="11111111-1111-4111-8111-111111111111",
            capture_id=capture_id,
        )
        store.update_capture(
            capture_id, state=CaptureState.delete_pending, delete_kind="delete"
        )
        # The directory rename landed; the process died before the sibling's.
        layout.trash.mkdir(parents=True, exist_ok=True)
        layout.capture_dir(capture_id).rename(layout.trash_dir(capture_id))
        assert sibling.exists()
        store.close()

        with _restart(settings, fake_recorder):
            pass

        # A failed-start marker left in objects/ is read by the next rebuild as
        # a capture that exists (§3.4) — the deletion would undo itself.
        assert not sibling.exists()
        reopened = CaptureStore(layout.db, data_dir=layout.data_dir)
        assert reopened.get_capture(capture_id).state == CaptureState.deleted
        reopened.close()

    def test_a_duplicate_parking_is_reaped_with_the_capture(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        # A previous interrupted attempt already trashed a copy: the delete now
        # has two directories claiming one id, and parks the newcomer.
        layout.trash_dir(capture_id).mkdir(parents=True, exist_ok=True)
        (layout.trash_dir(capture_id) / "earlier.mcap").write_bytes(b"1")

        client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "delete", "reason": "done"},
        )

        # Both copies gone, and only then is the replica allowed to say so.
        assert list(layout.trash.glob(f"{capture_id}*")) == []
        replica = store.get_replica(capture_id, client.app.state.instance_id)
        assert replica.state == ReplicaState.absent_managed


class TestReviewDeleteRace:
    def test_review_is_refused_while_a_delete_is_in_flight(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        store.update_capture(
            capture_id, state=CaptureState.delete_pending, delete_kind="delete"
        )

        response = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 0, "review_status": "adopted"},
        )
        # delete_pending is the window between the ledger append and the
        # rename; a review accepted here writes into a directory that is about
        # to move, or recreates it afterwards.
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "capture_deleting"

    def test_a_review_cannot_recreate_a_capture_the_resume_removed(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "delete", "reason": "done"},
        )
        assert not layout.capture_dir(capture_id).exists()

        response = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 0, "review_status": "adopted"},
        )
        assert response.status_code == 409
        # The directory must not come back: a rebuild would then see a capture
        # with no manifest, and the reaper has already walked past it.
        assert not layout.capture_dir(capture_id).exists()

    def test_the_resume_and_a_review_do_not_interleave(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """The resume holds the same per-capture mutex a review save takes."""
        import asyncio

        store = client.app.state.capture_store
        service = client.app.state.capture_service
        capture_id = _seed_on_disk(store, layout)
        store.update_capture(
            capture_id, state=CaptureState.delete_pending, delete_kind="delete"
        )

        async def race() -> tuple[object, object]:
            # Both paths contend for the capture; whichever order they run in,
            # the review must not leave objects/<id> behind.
            return await asyncio.gather(
                service.resume_delete_pending(),
                service.save_review(
                    capture_id,
                    ReviewSaveRequest(base_revision=0, review_status="adopted"),
                ),
                return_exceptions=True,
            )

        asyncio.run(race())
        assert not layout.capture_dir(capture_id).exists()
        assert store.get_capture(capture_id).state == CaptureState.deleted


class TestReapBound:
    def test_the_bound_stops_the_work_not_just_the_logging(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """§7 step 5 forbids an unbounded retry loop (m1)."""
        from unittest.mock import patch

        from api_orchestrator.captures import MAX_REAP_ATTEMPTS

        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        service = client.app.state.capture_service
        store.update_capture(
            capture_id, state=CaptureState.deleted, delete_kind="delete"
        )
        layout.trash.mkdir(parents=True, exist_ok=True)
        layout.capture_dir(capture_id).rename(layout.trash_dir(capture_id))

        calls = 0
        real_purge = layout_mod.purge_from_trash

        def stubborn_purge(*args: object, **kwargs: object) -> bool:
            nonlocal calls
            calls += 1
            return False

        with patch(
            "api_orchestrator.captures.layout_mod.purge_from_trash", stubborn_purge
        ):
            for _ in range(MAX_REAP_ATTEMPTS + 5):
                service.reap(capture_id)

        # Counting attempts only on failure would let the reconciler re-walk an
        # undeletable tree on every pass forever; the cap has to stop the work.
        assert calls == MAX_REAP_ATTEMPTS
        assert real_purge is layout_mod.purge_from_trash

    def test_an_operator_intervention_lets_it_try_again(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        from unittest.mock import patch

        from api_orchestrator.captures import MAX_REAP_ATTEMPTS

        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        service = client.app.state.capture_service
        store.update_capture(
            capture_id, state=CaptureState.deleted, delete_kind="delete"
        )
        layout.trash.mkdir(parents=True, exist_ok=True)
        layout.capture_dir(capture_id).rename(layout.trash_dir(capture_id))

        # Burn the budget on something that genuinely cannot be removed (a
        # permission fault, a busy mount — whatever the operator then fixes).
        with patch(
            "api_orchestrator.captures.layout_mod.purge_from_trash",
            return_value=False,
        ):
            for _ in range(MAX_REAP_ATTEMPTS):
                service.reap(capture_id)

        # The fault is gone, but the sticky per-process bound still refuses.
        assert service.reap(capture_id) is False
        assert layout.trash_dir(capture_id).exists()

        service.reset_reap_attempts(capture_id)
        # The bound must not outlive the operator's fix.
        assert service.reap(capture_id) is True
        assert not layout.trash_dir(capture_id).exists()


class TestReportGarbageCollection:
    """Derived artifacts must not outlive the capture they describe."""

    def _with_reports(
        self, client: TestClient, layout: DataLayout
    ) -> tuple[str, list[Path]]:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        made: list[Path] = []
        for pipeline, name in (
            ("fast_validation", "summary.json"),
            ("video_check", "preview.mp4"),
            ("loss_report", "summary.json"),
        ):
            report = layout.report_dir(pipeline, capture_id)
            report.mkdir(parents=True, exist_ok=True)
            (report / name).write_bytes(b"derived artifact")
            made.append(report)
        return capture_id, made

    def test_a_discard_removes_the_reports(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id, reports = self._with_reports(client, layout)

        client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "discard", "reason": "bad take"},
        )

        # The UI calls a discard unrecoverable (§12). A surviving mp4 preview
        # of the recording would make that untrue.
        for report in reports:
            assert not report.exists(), report

    def test_a_delete_removes_them_too(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id, reports = self._with_reports(client, layout)
        client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "delete", "reason": "done"},
        )
        assert all(not report.exists() for report in reports)

    def test_the_files_endpoint_stops_serving_them(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id, _ = self._with_reports(client, layout)
        served = f"report/video_check/{capture_id}/preview.mp4"
        assert client.get(f"/api/v1/files/{served}").status_code == 200

        client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "discard", "reason": "bad take"},
        )

        # The actual complaint: not merely that bytes lingered on disk, but that
        # they stayed reachable over HTTP after the capture was destroyed.
        assert client.get(f"/api/v1/files/{served}").status_code == 404

    def test_another_captures_reports_are_untouched(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id, _ = self._with_reports(client, layout)
        bystander, bystander_reports = self._with_reports(client, layout)

        client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "discard", "reason": "bad take"},
        )
        assert all(report.is_dir() for report in bystander_reports)
        assert bystander != capture_id

    def test_reports_from_a_pipeline_added_later_are_still_collected(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        # A plugin pipeline nobody hardcoded anywhere.
        novel = layout.report_dir("some_future_plugin", capture_id)
        novel.mkdir(parents=True)
        (novel / "summary.json").write_text("{}", encoding="utf-8")

        client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "delete", "reason": "done"},
        )
        # Enumerated by scanning report/, not from a list that goes stale the
        # moment a pipeline is added.
        assert not novel.exists()

    def test_a_capture_with_no_reports_deletes_cleanly(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed_on_disk(store, layout)
        response = client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "delete", "reason": "done"},
        )
        assert response.status_code == 200

    def test_suspect_stops_report_removal_with_everything_else(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id, reports = self._with_reports(client, layout)
        client.app.state.store_health.latch_suspect("storage looks wrong")

        client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "delete", "reason": "done"},
        )
        # §9-3: while the volume is in doubt, "delete these bytes" is the last
        # instruction to obey — reports included.
        assert all(report.is_dir() for report in reports)
