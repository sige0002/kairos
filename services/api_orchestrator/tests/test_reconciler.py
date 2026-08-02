"""The reconciler (§8 adoption, §7 reaping, §9-3 the threshold guard).

The guard is the part worth most of this file. A bind mount that comes unmounted
mid-scan presents an empty directory, and every capture then looks deleted —
so the pass compares the volume marker *after* scanning, and refuses to apply
anything if more copies vanished at once than ``max(5, 10%)``. Recording a whole
catalog as ``missing_unmanaged`` because a mount flapped is not a recovery, it
is the incident.
"""

from __future__ import annotations

import shutil
from unittest.mock import patch

from api_orchestrator.health import missing_threshold
from api_orchestrator.layout import VOLUME_MARKER_NAME, DataLayout
from api_orchestrator.models import Capture, CaptureState
from conftest import reconcile
from fastapi.testclient import TestClient
from kairos_common.capture_sidecars import ObjectManifestV2, write_object_manifest
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import ReplicaState


def _present(client: TestClient, layout: DataLayout, count: int) -> list[str]:
    """*count* captures that are both catalogued and on disk."""
    store = client.app.state.capture_store
    instance = client.app.state.instance_id
    ids: list[str] = []
    for _ in range(count):
        capture_id = new_capture_id()
        capture_dir = layout.capture_dir(capture_id)
        capture_dir.mkdir(parents=True)
        (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
        store.create_capture(
            Capture(
                capture_id=capture_id,
                run_id=f"run_{capture_id}",
                state=CaptureState.completed,
                started_at="2026-08-01T00:00:00.000Z",
            )
        )
        store.upsert_replica(
            capture_id,
            instance,
            ReplicaState.present_unverified,
            path=str(capture_dir),
        )
        ids.append(capture_id)
    return ids


def _orphan(layout: DataLayout, instance: str, **fields: object) -> str:
    """A valid capture directory with no row — an import that landed and died."""
    capture_id = new_capture_id()
    capture_dir = layout.capture_dir(capture_id)
    capture_dir.mkdir(parents=True)
    (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
    defaults: dict[str, object] = {
        "capture_id": capture_id,
        "source_instance_id": instance,
        "run_id": f"run_{capture_id[:13]}",
        "state": "completed",
        "started_at": "2026-08-01T00:00:00.000Z",
        "operator": "alice",
    }
    defaults.update(fields)
    write_object_manifest(capture_dir, ObjectManifestV2(**defaults))  # type: ignore[arg-type]
    return capture_id


class TestOrphanAdoption:
    def test_a_valid_directory_with_no_row_is_adopted(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _orphan(layout, client.app.state.instance_id)
        result = reconcile(client)

        assert result.adopted == 1
        body = client.get(f"/api/v1/captures/{capture_id}").json()
        # This is where a transfer arrival and a crashed import both land: the
        # bytes are here and complete, so the catalog should say so.
        assert body["operator"] == "alice"
        assert body["replica"]["state"] == "present_unverified"

    def test_a_directory_with_no_manifest_is_not_adopted(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = new_capture_id()
        layout.capture_dir(capture_id).mkdir(parents=True)
        result = reconcile(client)

        # §2's invariant says an incomplete directory under objects/ can only be
        # a live capture; adopting this would invent one out of a directory name.
        assert result.adopted == 0
        assert client.get(f"/api/v1/captures/{capture_id}").status_code == 404

    def test_adoption_does_not_overwrite_an_existing_row(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _orphan(layout, client.app.state.instance_id)
        reconcile(client)
        client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 0, "review_status": "adopted"},
        )

        reconcile(client)
        # A second pass must not re-adopt and wipe the review that was saved in
        # between; only rows that do not exist yet are written.
        assert store.get_capture(capture_id).review_status == "adopted"


class TestMissingDetection:
    def test_bytes_removed_behind_our_back_become_missing_unmanaged(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        [capture_id] = _present(client, layout, 1)
        shutil.rmtree(layout.capture_dir(capture_id))

        reconcile(client)
        capture = store.get_capture(capture_id)
        # §9-2: an external rm -rf is NOT a deletion. The capture row stays, and
        # the replica says the copy vanished without anyone asking — a warning,
        # not a completed cleanup.
        assert capture.state == CaptureState.completed
        assert capture.replica.state == ReplicaState.missing_unmanaged

    def test_a_tombstoned_captures_absence_is_not_a_loss(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        [capture_id] = _present(client, layout, 1)
        client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "delete", "reason": "done"},
        )
        result = reconcile(client)
        # The copy is supposed to be gone; counting it as missing would put
        # every ordinary deletion into the threshold's numerator.
        assert result.missing == 0


class TestThresholdGuard:
    def test_the_threshold_has_a_floor_of_five(self) -> None:
        # Ten percent of four captures is zero, and a threshold of zero would
        # refuse every ordinary single deletion on a small store.
        assert missing_threshold(0) == 5
        assert missing_threshold(40) == 5
        assert missing_threshold(200) == 20

    def test_a_few_missing_copies_are_applied_normally(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        ids = _present(client, layout, 4)
        for capture_id in ids[:3]:
            shutil.rmtree(layout.capture_dir(capture_id))

        result = reconcile(client)
        assert result.applied is True
        assert result.missing == 3
        assert client.get("/api/v1/store/health").json()["state"] == "ok"

    def test_a_mass_disappearance_applies_nothing_and_latches_suspect(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        ids = _present(client, layout, 10)
        for capture_id in ids:
            shutil.rmtree(layout.capture_dir(capture_id))

        result = reconcile(client)
        assert result.applied is False
        assert result.threshold == 5

        # NOT "mark them and warn": a storage fault that ate ten captures must
        # not also rewrite ten rows on the way past.
        for capture_id in ids:
            assert (
                store.get_replica(capture_id, client.app.state.instance_id).state
                == ReplicaState.present_unverified
            )
        health = client.get("/api/v1/store/health").json()
        assert health["state"] == "suspect"
        assert "vanished at once" in health["suspect_reason"]

    def test_suspect_latches_rather_than_re_firing(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        ids = _present(client, layout, 10)
        for capture_id in ids:
            shutil.rmtree(layout.capture_dir(capture_id))
        reconcile(client)
        first = client.get("/api/v1/store/health").json()["suspect_at"]

        reconcile(client)
        # Re-firing every pass would turn one storage incident into a log flood
        # and keep resetting the timestamp an operator is trying to read.
        assert client.get("/api/v1/store/health").json()["suspect_at"] == first

    def test_suspect_stops_the_reaper(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        [capture_id] = _present(client, layout, 1)
        client.app.state.capture_service._store.update_capture(
            capture_id, state=CaptureState.deleted, delete_kind="delete"
        )
        layout.trash.mkdir(parents=True, exist_ok=True)
        shutil.move(
            str(layout.capture_dir(capture_id)), str(layout.trash_dir(capture_id))
        )
        store.upsert_replica(
            capture_id, client.app.state.instance_id, ReplicaState.trashed
        )
        client.app.state.store_health.latch_suspect("storage looks wrong")

        reconcile(client)
        # If the volume is not what we think it is, "delete these bytes" is the
        # last instruction to obey (§9-3).
        assert layout.trash_dir(capture_id).exists()

    def test_repair_clears_suspect_and_re_runs_the_pass(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        ids = _present(client, layout, 10)
        for capture_id in ids:
            shutil.rmtree(layout.capture_dir(capture_id))
        reconcile(client)
        assert client.get("/api/v1/store/health").json()["state"] == "suspect"

        response = client.post("/api/v1/store/repair")
        assert response.status_code == 200
        assert client.get("/api/v1/store/health").json()["state"] == "ok"
        # Repair is the operator confirming the copies really are gone, so the
        # pass it triggers APPLIES the transitions the guard was withholding —
        # otherwise the button would clear the latch and immediately re-set it.
        assert response.json()["reconcile"]["missing"] == 10
        store = client.app.state.capture_store
        assert (
            store.get_replica(ids[0], client.app.state.instance_id).state
            == ReplicaState.missing_unmanaged
        )

    def test_repair_is_refused_while_the_volume_cannot_identify_itself(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        client.app.state.store_health.latch_suspect("storage looks wrong")
        (layout.data_dir / VOLUME_MARKER_NAME).unlink()

        response = client.post("/api/v1/store/repair")
        # An approval that cannot name the volume it is approving is not an
        # approval: the latch exists precisely because a vanished volume and
        # vanished files are indistinguishable.
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "volume_unidentified"
        assert client.get("/api/v1/store/health").json()["state"] == "suspect"


class TestVolumeMarker:
    def test_a_pass_without_a_marker_applies_nothing(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        [capture_id] = _present(client, layout, 1)
        shutil.rmtree(layout.capture_dir(capture_id))
        (layout.data_dir / VOLUME_MARKER_NAME).unlink()

        result = reconcile(client)
        assert result.applied is False
        assert "volume marker" in result.skipped_reason

    def test_a_marker_that_changes_during_the_scan_discards_the_pass(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        [capture_id] = _present(client, layout, 1)
        shutil.rmtree(layout.capture_dir(capture_id))

        # Before the scan the marker reads "volume-a"; after it, "volume-b" —
        # the signature of a mount that changed underneath us mid-pass.
        with patch(
            "api_orchestrator.reconciler.layout_mod.read_volume_marker",
            side_effect=["volume-a", "volume-b"],
        ):
            result = reconcile(client)

        assert result.applied is False
        assert "changed during the scan" in result.skipped_reason
        # Nothing was written, so the capture is untouched rather than recorded
        # as missing from a volume we were not even looking at.
        assert (
            store.get_replica(capture_id, client.app.state.instance_id).state
            == ReplicaState.present_unverified
        )


class TestDigestReQueue:
    def test_a_terminal_unverified_capture_is_queued_for_digest(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        _present(client, layout, 2)
        result = reconcile(client)
        # §8: a digest interrupted by a crash is picked up here rather than
        # waiting for the next recording to happen to trigger one.
        assert result.digests_queued == 2

    def test_the_background_loop_actually_runs_what_it_queues(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        import asyncio

        [capture_id] = _present(client, layout, 1)
        write_object_manifest(
            layout.capture_dir(capture_id),
            ObjectManifestV2(
                capture_id=capture_id,
                source_instance_id=client.app.state.instance_id,
                run_id=f"run_{capture_id[:13]}",
                state="completed",
                started_at="2026-08-01T00:00:00.000Z",
            ),
        )

        async def one_cycle() -> None:
            result = await client.app.state.reconciler.run_once()
            if result.applied and result.digests_queued:
                await client.app.state.reconciler.run_digests()

        asyncio.run(one_cycle())

        # Queueing without running would leave a digest that a crash
        # interrupted pending forever — the stop path is its only other
        # trigger, and that recording is already over.
        replica = client.app.state.capture_store.get_replica(
            capture_id, client.app.state.instance_id
        )
        assert replica.state == ReplicaState.present_verified


class TestCorruptReplicas:
    """A corrupt manifest has no capture row by design — but its bytes exist (M4)."""

    def _corrupt_capture(self, layout: DataLayout) -> str:
        capture_id = new_capture_id()
        capture_dir = layout.capture_dir(capture_id)
        capture_dir.mkdir(parents=True)
        (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
        (capture_dir / f"{capture_id}_0.mcap").write_bytes(b"\x89MCAP0\r\n")
        # The signature of a crash between rename and writeback.
        (capture_dir / "object_manifest.json").write_bytes(b"")
        return capture_id

    def test_a_corrupt_capture_gets_a_replica_row(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = self._corrupt_capture(layout)
        reconcile(client)

        store = client.app.state.capture_store
        replica = store.get_replica(capture_id, client.app.state.instance_id)
        # Without this row the catalog holds NO trace of bytes that are sitting
        # right there: §8 rule 4 forbids inventing a captures row from an
        # unreadable manifest, so the replica is the only thing that can say
        # "this copy is here and its description is broken".
        assert replica is not None
        assert replica.state == ReplicaState.corrupt
        assert replica.path == str(layout.capture_dir(capture_id))

    def test_the_corrupt_capture_still_has_no_capture_row(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = self._corrupt_capture(layout)
        reconcile(client)
        # The manifest was the only thing that could say what this capture IS;
        # a row would be fabricated.
        assert client.get(f"/api/v1/captures/{capture_id}").status_code == 404

    def test_the_corruption_is_reported_on_the_pass(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = self._corrupt_capture(layout)
        result = reconcile(client)
        assert [c["capture_id"] for c in result.corrupt] == [capture_id]

    def test_a_corrupt_replica_is_not_counted_as_present(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        self._corrupt_capture(layout)
        reconcile(client)
        # It must not inflate §9-3's denominator: the threshold is about copies
        # we can vouch for, and this is precisely one we cannot.
        store = client.app.state.capture_store
        assert store.count_present_replicas(client.app.state.instance_id) == 0


class TestCorruptVisibility:
    """§8 rule 4 requires corruption to be REPORTED — reachably, not just logged."""

    def _corrupt_after_startup(self, layout: DataLayout) -> str:
        capture_id = new_capture_id()
        capture_dir = layout.capture_dir(capture_id)
        capture_dir.mkdir(parents=True)
        (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
        (capture_dir / "object_manifest.json").write_bytes(b"")
        return capture_id

    def test_a_sidecar_that_goes_bad_after_startup_is_reachable_via_the_api(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        # Clean at boot, so the startup rebuild has nothing to report.
        assert client.get("/api/v1/store/health").json()["corrupt"] == []
        capture_id = self._corrupt_after_startup(layout)

        reconcile(client)

        body = client.get("/api/v1/store/health").json()
        entry = next(c for c in body["corrupt"] if c["capture_id"] == capture_id)
        # The path and the reason, not just a count: an operator cannot repair
        # a file the API will not name.
        assert entry["path"].endswith("object_manifest.json")
        assert "empty file" in entry["reason"]
        assert body["corrupt_source"] == "reconcile"
        assert body["corrupt_observed_at"] is not None

    def test_a_repaired_sidecar_drops_out_of_the_list(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = self._corrupt_after_startup(layout)
        reconcile(client)
        assert client.get("/api/v1/store/health").json()["corrupt"] != []

        write_object_manifest(
            layout.capture_dir(capture_id),
            ObjectManifestV2(
                capture_id=capture_id,
                source_instance_id=client.app.state.instance_id,
                run_id=f"run_{capture_id[:13]}",
                state="completed",
                started_at="2026-08-01T00:00:00.000Z",
            ),
        )
        reconcile(client)

        # A complete scan replaces the previous one, so a fixed file stops being
        # reported rather than lingering as a permanent false alarm.
        assert client.get("/api/v1/store/health").json()["corrupt"] == []

    def test_a_pass_that_never_scanned_does_not_clear_the_list(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        self._corrupt_after_startup(layout)
        reconcile(client)
        assert client.get("/api/v1/store/health").json()["corrupt"] != []

        (layout.data_dir / VOLUME_MARKER_NAME).unlink()
        reconcile(client)

        # "We could not look" must never be recorded as "nothing is corrupt".
        assert client.get("/api/v1/store/health").json()["corrupt"] != []

    def test_a_threshold_blocked_pass_still_reports_what_it_saw(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        import shutil

        capture_id = self._corrupt_after_startup(layout)
        ids = _present(client, layout, 10)
        for present in ids:
            shutil.rmtree(layout.capture_dir(present))

        result = reconcile(client)
        assert result.applied is False  # SUSPECT latched

        body = client.get("/api/v1/store/health").json()
        # Corruption is something the scan SAW, not something it chose to
        # apply — withholding it because the writes were blocked would hide a
        # fault at exactly the moment the operator is investigating.
        assert [c["capture_id"] for c in body["corrupt"]] == [capture_id]

    def test_the_startup_rebuild_still_reports_before_any_pass_runs(
        self, settings, fake_recorder, layout: DataLayout, instance_id: str
    ) -> None:
        import httpx
        from api_orchestrator.app_factory import create_orchestrator_app

        capture_id = self._corrupt_after_startup(layout)
        app = create_orchestrator_app(
            settings,
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(fake_recorder.handler)
            ),
        )
        with TestClient(app) as booted:
            body = booted.get("/api/v1/store/health").json()
        assert [c["capture_id"] for c in body["corrupt"]] == [capture_id]
        assert body["corrupt_source"] == "rebuild"
