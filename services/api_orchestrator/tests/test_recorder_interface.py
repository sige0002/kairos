"""The recorder wire contract (§10 rev.2.3/2.4), pinned by name.

This file exists because both services' suites stayed green while the
integration was broken: nothing referenced the liveness field at all, so a
rename could not fail anything. Every test here asserts a **specific wire name
or shape**, and the payloads are built literally rather than through the fake,
so a future rename breaks a test instead of surfacing as silent wrong behaviour
in a live stack.

The one rule underneath all of it: ``live_capture_ids`` is the only liveness
signal. The singular ``capture_id`` keeps naming the last capture after it
finishes, so reading it as "still live" marks every just-completed recording as
recorder-held forever — §9-4(b) then blocks its digest until the next recording
starts, and a rebuild live-excludes it so no row is ever created.
"""

from __future__ import annotations

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import DataLayout
from api_orchestrator.recorder_client import LIVE_CAPTURE_IDS_FIELD, live_capture_ids
from conftest import FakeRecorder, run_digests
from fastapi.testclient import TestClient
from kairos_common.capture_sidecars import (
    ObjectManifestV2,
    read_object_manifest,
    write_object_manifest,
)
from kairos_common.ids import new_capture_id

LIVE = "01920000-0000-7000-8000-000000000001"


class TestFieldName:
    def test_the_field_is_named_live_capture_ids(self) -> None:
        # Pinned by contract §10 rev.2.3. If this constant is renamed, the
        # recorder and the orchestrator stop agreeing about what is live, and
        # nothing else in either suite would notice.
        assert LIVE_CAPTURE_IDS_FIELD == "live_capture_ids"

    def test_the_array_is_read_from_that_exact_key(self) -> None:
        assert live_capture_ids({"live_capture_ids": [LIVE]}) == {LIVE}

    def test_an_empty_array_is_a_definitive_answer(self) -> None:
        # "The recorder says nothing is live" licenses normalizing an abandoned
        # recording; it must not be confused with "we could not ask".
        assert live_capture_ids({"live_capture_ids": []}) == set()

    def test_a_missing_array_is_not_an_empty_live_set(self) -> None:
        # §10 rev.2.4: an old or broken recorder is UNREACHABLE. Treating this
        # as idle is how a rename turns into normalizing live recordings to
        # interrupted while the recorder is still writing them.
        assert live_capture_ids({"state": "recording"}) is None
        assert live_capture_ids({"live_capture_ids": "not-a-list"}) is None

    def test_the_singular_capture_id_is_never_consulted(self) -> None:
        # It stays non-null after terminal states BY DESIGN.
        assert live_capture_ids({"capture_id": LIVE, "live_capture_ids": []}) == set()
        assert live_capture_ids({"capture_id": LIVE}) is None

    def test_the_old_capture_ids_spelling_is_not_accepted(self) -> None:
        # The name crossed in flight during the interface handshake; reading the
        # superseded spelling would silently resurrect the bug this file pins.
        assert live_capture_ids({"capture_ids": [LIVE]}) is None

    def test_non_uuid_entries_are_dropped(self) -> None:
        # These become directory names; anything that is not a UUIDv7 must not
        # reach objects/.
        assert live_capture_ids({"live_capture_ids": ["../etc", LIVE]}) == {LIVE}


def _finished_capture(client: TestClient, layout: DataLayout) -> str:
    """A terminal capture with bytes and a pending manifest, seeded directly.

    Seeded rather than recorded, because ``stop`` queues a digest that would
    race the gating these tests are about: by the time a test could adjust the
    recorder's state, the background job may already have sealed the manifest.
    """
    from api_orchestrator.models import Capture, CaptureState
    from kairos_common.rebuild import ReplicaState

    store = client.app.state.capture_store
    instance = client.app.state.instance_id
    capture_id = new_capture_id()
    capture_dir = layout.capture_dir(capture_id)
    capture_dir.mkdir(parents=True)
    (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
    write_object_manifest(
        capture_dir,
        ObjectManifestV2(
            capture_id=capture_id,
            source_instance_id=instance,
            run_id="run_seeded",
            state="completed",
            started_at="2026-08-01T00:00:00.000Z",
        ),
    )
    store.create_capture(
        Capture(
            capture_id=capture_id,
            run_id=f"run_{capture_id}",
            state=CaptureState.completed,
            started_at="2026-08-01T00:00:00.000Z",
        )
    )
    store.upsert_replica(
        capture_id, instance, ReplicaState.present_unverified, path=str(capture_dir)
    )
    return capture_id


class TestDigestGating:
    def test_a_capture_named_live_is_not_digested(
        self, client: TestClient, layout: DataLayout, fake_recorder: FakeRecorder
    ) -> None:
        capture_id = _finished_capture(client, layout)
        fake_recorder.state = "recording"
        fake_recorder.capture_id = capture_id

        assert run_digests(client) == 0
        manifest = read_object_manifest(layout.capture_dir(capture_id)).manifest
        assert manifest.digest_state == "pending"

    def test_a_finished_capture_the_singular_field_still_names_IS_digested(
        self, client: TestClient, layout: DataLayout, fake_recorder: FakeRecorder
    ) -> None:
        client.post("/api/v1/record/start", json={"topics": ["/joint_states"]})
        capture_id = fake_recorder.capture_id
        client.post("/api/v1/record/stop")

        # The recorder is idle and its live array is empty, but `capture_id`
        # still names this capture — which is exactly the state the old scalar
        # fallback mistook for "recorder still holds it", blocking the digest
        # forever.
        status = client.get("/api/v1/record/status").json()
        assert status["capture_id"] == capture_id
        assert status["live_capture_ids"] == []

        run_digests(client)
        manifest = read_object_manifest(layout.capture_dir(capture_id)).manifest
        assert manifest.digest_state == "complete"

    def test_a_recorder_that_omits_the_array_defers_the_digest(
        self, client: TestClient, layout: DataLayout, fake_recorder: FakeRecorder
    ) -> None:
        capture_id = _finished_capture(client, layout)
        fake_recorder.omit_live_capture_ids = True

        # §9-4 needs a positive "not holding it"; silence is not that.
        assert run_digests(client) == 0
        manifest = read_object_manifest(layout.capture_dir(capture_id)).manifest
        assert manifest.digest_state == "pending"


class TestRebuildLiveExclusion:
    def _boot(self, settings, fake_recorder: FakeRecorder) -> TestClient:
        app = create_orchestrator_app(
            settings,
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(fake_recorder.handler)
            ),
        )
        return TestClient(app)

    def _manifest_only(
        self, layout: DataLayout, instance_id: str, capture_id: str, state: str
    ) -> None:
        capture_dir = layout.capture_dir(capture_id)
        capture_dir.mkdir(parents=True, exist_ok=True)
        (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
        write_object_manifest(
            capture_dir,
            ObjectManifestV2(
                capture_id=capture_id,
                source_instance_id=instance_id,
                run_id="run_live",
                state=state,
                started_at="2026-08-01T00:00:00.000Z",
            ),
        )

    def test_a_capture_in_the_array_is_excluded_from_the_rebuild(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        capture_id = new_capture_id()
        self._manifest_only(layout, instance_id, capture_id, "recording")
        fake_recorder.state = "recording"
        fake_recorder.capture_id = capture_id

        with self._boot(settings, fake_recorder) as client:
            # No row: the recorder is still its sole writer and the normal
            # finalise path will produce one (§8 rule 1).
            assert client.get(f"/api/v1/captures/{capture_id}").status_code == 404

    def test_a_finished_capture_the_singular_field_names_still_gets_a_row(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        capture_id = new_capture_id()
        self._manifest_only(layout, instance_id, capture_id, "completed")
        # Idle recorder, empty live array, singular still naming it — the exact
        # shape the scalar fallback would have live-excluded forever.
        fake_recorder.state = "idle"
        fake_recorder.capture_id = capture_id

        with self._boot(settings, fake_recorder) as client:
            body = client.get(f"/api/v1/captures/{capture_id}").json()
        assert body["state"] == "completed"

    def test_an_armed_capture_is_excluded_too(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        capture_id = new_capture_id()
        # An armed prepare owns objects/<id>/ with NO manifest yet, so a rebuild
        # that missed it would report a manifest-less orphan.
        layout.capture_dir(capture_id).mkdir(parents=True)
        fake_recorder.state = "armed"
        fake_recorder.prepared_capture_id = capture_id

        with self._boot(settings, fake_recorder) as client:
            health = client.get("/api/v1/store/health").json()
        warnings = " ".join(health["warnings"])
        assert capture_id not in warnings
        assert health["rebuild_summary"]["captures"] == 0

    def test_an_omitted_array_defers_instead_of_normalizing(
        self,
        settings,
        fake_recorder: FakeRecorder,
        layout: DataLayout,
        instance_id: str,
    ) -> None:
        capture_id = new_capture_id()
        self._manifest_only(layout, instance_id, capture_id, "recording")
        fake_recorder.omit_live_capture_ids = True

        with self._boot(settings, fake_recorder) as client:
            summary = client.get("/api/v1/store/health").json()["rebuild_summary"]
            # Deferred, NOT normalized to interrupted: without the array we
            # cannot tell an abandoned recording from one still being written,
            # and interrupting a live one orphans a growing bag (§8 rule 1).
            assert summary["deferred"] == [capture_id]
            assert client.get(f"/api/v1/captures/{capture_id}").status_code == 404


class TestOtherPinnedShapes:
    def test_stop_names_the_capture_it_just_finalised(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        started = client.post(
            "/api/v1/record/start", json={"topics": ["/joint_states"]}
        ).json()
        stopped = client.post("/api/v1/record/stop").json()
        # The singular field's persistence past terminal is what makes this
        # correlation possible — it is a feature, used here and nowhere else.
        assert stopped["capture_id"] == started["capture_id"]

    def test_start_forwards_the_active_robot(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        client.post("/api/v1/record/start", json={"topics": ["/joint_states"]})
        # §10: the recorder stamps this into the manifest, which is what makes
        # the manifest rather than our row authoritative about the robot.
        # Asserted against the app's OWN active robot, not a literal name:
        # under `make` the developer's .env exports ROBOT and the catalog
        # resolves their local robot — the pinned property is "start forwards
        # whatever is active", which must hold in every environment.
        expected = client.app.state.config_catalog.active_robot()
        assert fake_recorder.last_start_payload["robot"] == expected

    def test_the_manifests_robot_wins_over_what_we_asked_for(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        started = client.post(
            "/api/v1/record/start", json={"topics": ["/joint_states"]}
        ).json()
        # The recorder recorded with something else (a live robot switch
        # between our request and its start).
        fake_recorder.robot = "other_robot"
        client.post("/api/v1/record/stop")

        body = client.get(f"/api/v1/captures/{started['capture_id']}").json()
        assert body["robot"] == "other_robot"

    def test_a_corrupt_manifest_is_recorded_as_corrupt_not_as_a_sync_failure(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        started = client.post(
            "/api/v1/record/start", json={"topics": ["/joint_states"]}
        ).json()
        # Corrupt on the wire AND on disk, because they are the same file: the
        # recorder's 500 says it could not parse the manifest the orchestrator
        # then goes on to read. A fake that answered 500 over a clean sidecar
        # would be modelling the sibling test's case, not this one.
        fake_recorder.manifest_corrupt = True
        fake_recorder.sidecar_corrupt = True
        client.post("/api/v1/record/stop")
        capture_id = started["capture_id"]

        body = client.get(f"/api/v1/captures/{capture_id}").json()
        # §10 sends this as a 500 with its own code precisely so it is not read
        # as "no manifest". A repairable fault must not be filed as transient
        # unreachability.
        assert body["error"]["code"] == "manifest_corrupt"

        # And it STAYS filed. Adoption is the one thing that clears this code
        # (the sibling test below), and it refuses an unparseable file — so the
        # digest runs here rather than being held back, and the complaint has
        # to survive it. That is the difference between a fault worth showing
        # an operator and one the next background pass erases.
        run_digests(client)
        after = client.get(f"/api/v1/captures/{capture_id}").json()
        assert after["error"]["code"] == "manifest_corrupt"

    def test_a_readable_terminal_manifest_clears_a_stale_corrupt_complaint(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        # The sidecar stays VALID here — that is the scenario, and it is why
        # this knob cannot simply corrupt the file too. Both adopters (the
        # digest stop queues, and the reconciler below) would therefore clear
        # the complaint, so the digest is held back to leave the pass named in
        # the assertion as the one that did it. The sibling test above covers
        # the opposite half of the rule with the digest running.
        digests_stay_queued: list[str],
    ) -> None:
        # Deliberate ruling (round 4, n3): manifest adoption CAN only run when
        # the file on disk read back as a valid terminal manifest — a corrupt
        # one adopts nothing — so at that point the on-disk file is the truth
        # and the HTTP-side manifest_corrupt complaint was transient. Keeping
        # the stale complaint once the file verifiably reads clean would be
        # the lie, not the honesty.
        from conftest import reconcile

        started = client.post(
            "/api/v1/record/start", json={"topics": ["/joint_states"]}
        ).json()
        fake_recorder.manifest_corrupt = True
        client.post("/api/v1/record/stop")
        capture_id = started["capture_id"]
        assert (
            client.get(f"/api/v1/captures/{capture_id}").json()["error"]["code"]
            == "manifest_corrupt"
        )

        # The recorder recovers; its metadata endpoint answers again. The valid
        # terminal manifest has been on disk the whole time (the fake writes
        # sidecars); a reconciler pass adopts the file's facts.
        fake_recorder.manifest_corrupt = False
        reconcile(client)
        body = client.get(f"/api/v1/captures/{capture_id}").json()
        assert body["error"] is None
        assert body["state"] == "completed"

    def test_a_corrupt_manifest_cannot_clear_the_complaint_it_caused(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        # The digest must not be the thing that happens to skip this capture;
        # the point is what adoption does when it IS asked.
        digests_stay_queued: list[str],
    ) -> None:
        """The mirror of the test above, with a REAL unreadable file.

        Both halves of the rule are decided by one fact — whether the sidecar
        reads back as a valid terminal manifest — so the clearing case is only
        half a specification.

        Adoption is called DIRECTLY here, and that is the whole point. Driving
        it through a background pass proves nothing about this rule: those
        passes may never route a corrupt capture to adoption at all, so the
        complaint would survive because nothing tried, and the test would pass
        while the guard it names could be deleted. The row carries a real
        complaint and the file on disk is real junk, so the only thing standing
        between them is ``adopt_manifest_facts`` refusing to read it.
        """
        started = client.post(
            "/api/v1/record/start", json={"topics": ["/joint_states"]}
        ).json()
        fake_recorder.manifest_corrupt = True
        fake_recorder.sidecar_corrupt = True
        client.post("/api/v1/record/stop")
        capture_id = started["capture_id"]
        # The stop path filed the fault, so there is now something to lose.
        assert (
            client.get(f"/api/v1/captures/{capture_id}").json()["error"]["code"]
            == "manifest_corrupt"
        )

        # The recorder's endpoint recovers; the FILE does not.
        fake_recorder.manifest_corrupt = False
        service = client.app.state.capture_service
        assert service.adopt_manifest_facts(capture_id) is False

        body = client.get(f"/api/v1/captures/{capture_id}").json()
        assert body["error"]["code"] == "manifest_corrupt"

    def test_the_bag_is_named_after_the_capture_not_the_run(
        self, client: TestClient, layout: DataLayout, fake_recorder: FakeRecorder
    ) -> None:
        client.post("/api/v1/record/start", json={"topics": ["/joint_states"]})
        capture_id = fake_recorder.capture_id
        client.post("/api/v1/record/stop")
        run_digests(client)

        manifest = read_object_manifest(layout.capture_dir(capture_id)).manifest
        paths = {f.path for f in manifest.files}
        # rosbag2 derives it from the output directory (objects/<capture_id>).
        # Nothing may assume a run_id-based filename.
        assert f"{capture_id}_0.mcap" in paths

    def test_a_failed_start_names_its_capture_in_the_error_details(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        known = new_capture_id()
        fake_recorder.start_status = 507
        fake_recorder.start_error = {
            "code": "insufficient_storage",
            "message": "no space left",
            "details": {"capture_id": known},
        }
        body = client.post(
            "/api/v1/record/start", json={"topics": ["/joint_states"]}
        ).json()
        # §10 makes capture_id mandatory in the 507 details, which is what lets
        # the failure be filed against a capture instead of vanishing until the
        # next rebuild reads the failed-start sidecar.
        assert body["capture_id"] == known
        assert body["state"] == "failed"


class TestRecorderKilledBetweenStopAndConfirmation:
    """E-9: the operator presses stop and the recorder dies before confirming.

    The two cases differ only in what reached the disk, and that is the whole
    point: the process being gone says nothing about whether the recording
    sealed. §3 makes the manifest authoritative, so the answer must come from
    the sidecar — not from the fact that nobody is left to ask.
    """

    def test_a_recording_that_did_seal_is_not_reported_as_lost(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        client.post("/api/v1/record/start", json={"topics": ["/joint_states"]})
        capture_id = fake_recorder.capture_id
        fake_recorder.die_after_stop = True  # sealed first, then killed
        client.post("/api/v1/record/stop")

        body = client.get(f"/api/v1/captures/{capture_id}").json()
        # The bag is finalised and the manifest says so. Calling this
        # interrupted would send an operator to re-record a good take.
        assert body["state"] == "completed"

    def test_a_recording_that_never_sealed_is_not_reported_as_clean(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        client.post("/api/v1/record/start", json={"topics": ["/joint_states"]})
        capture_id = fake_recorder.capture_id
        fake_recorder.seal_on_stop = False  # killed before finalising
        fake_recorder.die_after_stop = True
        client.post("/api/v1/record/stop")

        body = client.get(f"/api/v1/captures/{capture_id}").json()
        # Nothing finalised this bag: the manifest on disk still says
        # "recording" and no later event will ever correct it. Reporting
        # "completed" states that the take is good, which is the one answer
        # that cannot be recovered from — it is dataset-eligible on the
        # strength of a guess made because nobody was left to ask.
        assert body["state"] == "interrupted"
