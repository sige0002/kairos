# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The digest job (§11, gated by §9-4): hashing a finished capture once.

``present_verified`` is the only claim in the system that a copy is intact, and
§9-4 says it is reachable exactly one way: the digest job hashed every file and
sealed the result into the manifest in a single atomic write. So these tests are
mostly about the guards that stop that write happening at the wrong moment.
"""

from __future__ import annotations

import asyncio

from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState
from conftest import FakeRecorder, run_digests
from fastapi.testclient import TestClient
from kairos_common.capture_sidecars import (
    ObjectManifestV2,
    manifest_digest,
    read_object_manifest,
    write_object_manifest,
)
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import ReplicaState


def _finished_capture(client: TestClient, layout: DataLayout, **fields) -> str:
    """A terminal capture with real files and a pending-digest manifest."""
    store = client.app.state.capture_store
    instance = client.app.state.instance_id
    capture_id = new_capture_id()
    capture_dir = layout.capture_dir(capture_id)
    capture_dir.mkdir(parents=True)
    (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
    (capture_dir / "bag_0.mcap").write_bytes(b"\x89MCAP0\r\n" + b"payload")
    write_object_manifest(
        capture_dir,
        ObjectManifestV2(
            capture_id=capture_id,
            source_instance_id=instance,
            run_id=f"run_{capture_id[:13]}",
            state="completed",
            started_at="2026-08-01T00:00:00.000Z",
        ),
    )
    defaults = {
        "capture_id": capture_id,
        "run_id": f"run_{capture_id}",
        "state": CaptureState.completed,
        "started_at": "2026-08-01T00:00:00.000Z",
    }
    defaults.update(fields)
    store.create_capture(Capture(**defaults))
    store.upsert_replica(
        capture_id, instance, ReplicaState.present_unverified, path=str(capture_dir)
    )
    return capture_id


class TestCompletion:
    def test_the_digest_seals_the_manifest_and_verifies_the_replica(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _finished_capture(client, layout)
        assert run_digests(client) == 1

        manifest = read_object_manifest(layout.capture_dir(capture_id)).manifest
        assert manifest is not None
        assert manifest.digest_state == "complete"
        assert {f.path for f in manifest.files} == {"metadata.yaml", "bag_0.mcap"}
        # §3.2's digest is a property of the CAPTURE, not of the directory
        # listing order that produced it, so it must be reproducible from the
        # file list alone.
        assert manifest.manifest_digest == manifest_digest(manifest.files)

        replica = client.app.state.capture_store.get_replica(
            capture_id, client.app.state.instance_id
        )
        assert replica.state == ReplicaState.present_verified
        assert replica.manifest_digest == manifest.manifest_digest
        assert replica.verified_at is not None

    def test_the_mutable_review_sidecar_is_not_hashed(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _finished_capture(client, layout)
        client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 0, "review_status": "adopted"},
        )
        run_digests(client)

        manifest = read_object_manifest(layout.capture_dir(capture_id)).manifest
        # Including record.json would make the capture digest change on every
        # review edit, turning "these bytes are intact" into "nobody has touched
        # anything" and failing every replica comparison after a routine save.
        assert "record.json" not in {f.path for f in manifest.files}
        assert "object_manifest.json" not in {f.path for f in manifest.files}

    def test_the_digest_releases_its_lease(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _finished_capture(client, layout)
        run_digests(client)
        # A lease left behind would block every later deletion of this capture
        # until it expired (§7.1).
        assert client.app.state.capture_store.has_live_lease(capture_id) is False

    def test_running_twice_is_idempotent(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _finished_capture(client, layout)
        run_digests(client)
        before = read_object_manifest(layout.capture_dir(capture_id)).manifest

        # A second pass finds nothing to do: the queue only holds captures whose
        # replica is still unverified.
        assert run_digests(client) == 0
        after = read_object_manifest(layout.capture_dir(capture_id)).manifest
        assert after.manifest_digest == before.manifest_digest

    def test_sealing_stamps_which_instance_sealed(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        # S3-3: "verified" means different things depending on WHERE the hashes
        # were minted (source vs a receiver that got the bytes before any
        # digest ran). The stamp is what lets a reader tell them apart.
        capture_id = _finished_capture(client, layout)
        run_digests(client)
        manifest = read_object_manifest(layout.capture_dir(capture_id)).manifest
        assert manifest.digest_sealed_by == client.app.state.instance_id

    def test_an_unverified_copy_of_a_sealed_manifest_is_actually_compared(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """An intact copy passes real verification (not a rubber stamp)."""
        capture_id = _finished_capture(client, layout)
        store = client.app.state.capture_store
        instance = client.app.state.instance_id
        run_digests(client)
        sealed = read_object_manifest(layout.capture_dir(capture_id)).manifest

        # Model an arrival elsewhere: the manifest is sealed, the local copy
        # has not been verified yet.
        store.upsert_replica(
            capture_id,
            instance,
            ReplicaState.present_unverified,
            path=str(layout.capture_dir(capture_id)),
        )
        assert run_digests(client) == 1
        replica = store.get_replica(capture_id, instance)
        assert replica.state == ReplicaState.present_verified
        # Verification never rewrites a sealed manifest.
        after = read_object_manifest(layout.capture_dir(capture_id)).manifest
        assert after.manifest_digest == sealed.manifest_digest

    def test_a_copy_that_disagrees_with_its_seal_is_marked_corrupt(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """S3-3's worst edge: a truncated arrival with a sealed manifest.

        The old "already complete" branch promoted to present_verified without
        comparing a single byte — a bag cut short in transit would have worn
        the green badge. The comparison is the whole point of the state.
        """
        capture_id = _finished_capture(client, layout)
        store = client.app.state.capture_store
        instance = client.app.state.instance_id
        run_digests(client)

        # The bytes rot (a truncated transfer, disk damage) AFTER sealing.
        (layout.capture_dir(capture_id) / "bag_0.mcap").write_bytes(b"\x89MC")
        store.upsert_replica(
            capture_id,
            instance,
            ReplicaState.present_unverified,
            path=str(layout.capture_dir(capture_id)),
        )

        assert run_digests(client) == 0  # nothing completed
        replica = store.get_replica(capture_id, instance)
        assert replica.state == ReplicaState.corrupt
        # The sealed manifest is evidence — never overwritten by the check.
        manifest = read_object_manifest(layout.capture_dir(capture_id)).manifest
        assert manifest.digest_state == "complete"


class TestGuards:
    def test_a_capture_the_recorder_still_holds_is_skipped(
        self, client: TestClient, layout: DataLayout, fake_recorder: FakeRecorder
    ) -> None:
        capture_id = _finished_capture(client, layout)
        fake_recorder.state = "recording"
        fake_recorder.capture_id = capture_id

        assert run_digests(client) == 0
        manifest = read_object_manifest(layout.capture_dir(capture_id)).manifest
        # Hashing a bag the recorder is still appending to would seal hashes of
        # a file that is about to grow (§3.3, §9-4).
        assert manifest.digest_state == "pending"

    def test_an_unreachable_recorder_defers_rather_than_assuming(
        self, client: TestClient, layout: DataLayout, fake_recorder: FakeRecorder
    ) -> None:
        _finished_capture(client, layout)
        fake_recorder.transport_down = True
        # §9-4 needs a positive "the recorder is not holding it". Silence is not
        # that, so the work waits for the next pass.
        assert run_digests(client) == 0

    def test_a_non_terminal_capture_is_not_digested(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _finished_capture(client, layout)
        client.app.state.capture_store.update_capture(
            capture_id, state=CaptureState.recording
        )
        assert run_digests(client) == 0

    def test_a_leased_capture_is_left_to_its_holder(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _finished_capture(client, layout)
        client.app.state.capture_store.acquire_lease(
            capture_id, "dora_export", ttl_s=300
        )
        assert run_digests(client) == 0

    def test_a_corrupt_manifest_is_never_overwritten(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _finished_capture(client, layout)
        manifest_path = layout.capture_dir(capture_id) / "object_manifest.json"
        manifest_path.write_text("{ not json", encoding="utf-8")

        assert run_digests(client) == 0
        # The manifest is the only description of what this capture IS;
        # replacing it would discard that, so §3.3 reports and does not repair.
        assert manifest_path.read_text() == "{ not json"

    def test_a_capture_deleted_mid_hash_is_not_resurrected(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _finished_capture(client, layout)
        store = client.app.state.capture_store
        digest = client.app.state.digest_job

        real_hash = digest._hash_files

        def delete_then_hash(capture_dir):
            files = real_hash(capture_dir)
            # The operator discarded it while we were reading.
            store.update_capture(capture_id, state=CaptureState.discarded)
            import shutil

            shutil.rmtree(capture_dir)
            return files

        digest._hash_files = delete_then_hash
        outcome = asyncio.run(digest.run(capture_id))

        assert outcome.completed is False
        # §7.1 forbids a job from creating objects/<capture_id>: a manifest
        # written now would recreate the directory, and the next rebuild would
        # adopt it as a real capture.
        assert not layout.capture_dir(capture_id).exists()

    def test_a_suspect_store_runs_no_digests(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        _finished_capture(client, layout)
        client.app.state.store_health.latch_suspect("storage looks wrong")
        # §9-3: SUSPECT stops digests for this storage, because a digest that
        # reads the wrong volume would record a verification that means nothing.
        assert run_digests(client) == 0


class TestStopSchedulesDigest:
    def test_stopping_a_recording_queues_its_digest(
        self, client: TestClient, layout: DataLayout, fake_recorder: FakeRecorder
    ) -> None:
        client.post("/api/v1/record/start", json={"topics": ["/joint_states"]})
        capture_id = fake_recorder.capture_id
        client.post("/api/v1/record/stop")
        run_digests(client)

        body = client.get(f"/api/v1/captures/{capture_id}").json()
        assert body["digest_state"] == "complete"
        assert body["replica"]["state"] == "present_verified"
