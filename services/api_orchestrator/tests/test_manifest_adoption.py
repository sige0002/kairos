"""The manifest is authoritative for what was recorded (§3, §8).

A capture does not always reach a terminal state through the stop path. A
recorder killed mid-recording writes its OWN recovery manifest on restart, with
re-measured counters — and the catalog row, which still holds the live session's
values, is then wrong about a recording that exists on disk. QA found 10.7 MB of
robot data reported as "0 B / empty / NOT USABLE", where the rational operator
response is an irreversible discard.

Three paths can settle such a capture, and all three must adopt the manifest:
the status-poll interrupt, the periodic reconciler, and the digest. Each is
driven separately below, because in the field it is a race which one arrives
first and a fix in only one of them would look correct on a good day.
"""

from __future__ import annotations

import asyncio

from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState
from conftest import reconcile, run_digests
from fastapi.testclient import TestClient
from kairos_common.capture_sidecars import ObjectManifestV2, write_object_manifest
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import ReplicaState

# The shape QA hit, not the instance: a recorder-recovery manifest carrying
# counters the catalog never learned.
RECOVERED_BYTES = 11_182_080
RECOVERED_MESSAGES = 8_321
RECOVERED_ENDED_AT = "2026-08-03T00:03:00.000Z"
RECORDER_REASON = "recorder restarted while the capture was recording"


def _crashed_capture(
    client: TestClient,
    layout: DataLayout,
    *,
    row_state: CaptureState = CaptureState.recording,
    manifest_state: str = "interrupted",
    error: str | None = RECORDER_REASON,
) -> str:
    """A row left behind by a crash, beside the recorder's recovery manifest."""
    store = client.app.state.capture_store
    capture_id = new_capture_id()
    store.create_capture(
        Capture(
            capture_id=capture_id,
            run_id=f"run_{capture_id}",
            state=row_state,
            started_at="2026-08-03T00:00:00.000Z",
            # What the live session had reported before the recorder died.
            bytes=0,
            message_count=0,
        )
    )
    capture_dir = layout.capture_dir(capture_id)
    capture_dir.mkdir(parents=True, exist_ok=True)
    (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
    (capture_dir / f"{capture_id}_0.mcap").write_bytes(b"z" * 4096)
    store.upsert_replica(
        capture_id,
        client.app.state.instance_id,
        ReplicaState.present_unverified,
        path=str(capture_dir),
    )
    write_object_manifest(
        capture_dir,
        ObjectManifestV2(
            capture_id=capture_id,
            source_instance_id=client.app.state.instance_id,
            run_id=f"run_{capture_id}",
            state=manifest_state,
            started_at="2026-08-03T00:00:00.000Z",
            ended_at=RECOVERED_ENDED_AT,
            message_count=RECOVERED_MESSAGES,
            bytes=RECOVERED_BYTES,
            integrity="failed",
            error=error,
        ),
    )
    return capture_id


def _assert_agrees_with_the_manifest(client: TestClient, capture_id: str) -> None:
    body = client.get(f"/api/v1/captures/{capture_id}").json()
    # The four numbers every UI surface reads. "0 B" is what made an operator
    # reach for Discard.
    assert body["bytes"] == RECOVERED_BYTES
    assert body["message_count"] == RECOVERED_MESSAGES
    assert body["ended_at"] == RECOVERED_ENDED_AT
    assert body["state"] == "interrupted"
    # And the recorder's own reason, not a generic one written over it.
    assert body["error"]["message"] == RECORDER_REASON
    # The row must also agree with the manifest the endpoint serves beside it.
    assert body["manifest"]["bytes"] == body["bytes"]
    assert body["manifest"]["message_count"] == body["message_count"]


class TestEachSettlingPathAdopts:
    def test_the_reconciler_settles_a_stale_row(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _crashed_capture(client, layout)
        result = reconcile(client)

        assert result.settled == 1
        _assert_agrees_with_the_manifest(client, capture_id)

    def test_the_status_poll_interrupt_settles_it(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _crashed_capture(client, layout)
        # The recorder came back idle; this is the path that used to write
        # state=interrupted with a generic reason and leave bytes at 0.
        asyncio.run(client.app.state.record_service.reconcile_on_startup())

        _assert_agrees_with_the_manifest(client, capture_id)

    def test_the_digest_settles_it_when_it_seals(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _crashed_capture(
            client, layout, row_state=CaptureState.interrupted
        )
        # The digest is often first to touch such a capture. Sealing bytes whose
        # counters the catalog never learned would verify data the UI calls
        # empty — a "verified (empty)" recording.
        run_digests(client)

        body = client.get(f"/api/v1/captures/{capture_id}").json()
        assert body["digest_state"] == "complete"
        _assert_agrees_with_the_manifest(client, capture_id)


class TestTheReverseHole:
    def test_a_completed_manifest_settled_without_the_stop_path(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """Not only the interrupted case: a clean bag can miss the stop path too.

        The orchestrator can be restarted between the recorder finishing and the
        stop-path finalize running, and then nothing else would ever read the
        completed manifest's counters.
        """
        capture_id = _crashed_capture(
            client, layout, manifest_state="completed", error=None
        )
        assert reconcile(client).settled == 1

        body = client.get(f"/api/v1/captures/{capture_id}").json()
        assert body["state"] == "completed"
        assert body["bytes"] == RECOVERED_BYTES
        assert body["message_count"] == RECOVERED_MESSAGES

    def test_a_stale_row_error_is_cleared_by_a_clean_manifest(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _crashed_capture(
            client, layout, manifest_state="completed", error=None
        )
        store = client.app.state.capture_store
        asyncio.run(client.app.state.record_service.reconcile_on_startup())

        # The manifest saying nothing about an error IS the statement that the
        # recording ended cleanly, so a stale sync error must not survive it.
        assert store.get_capture(capture_id).error is None


class TestAdoptionIsNarrow:
    def test_an_unfinalized_manifest_is_not_adopted(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _crashed_capture(client, layout, manifest_state="recording")
        service = client.app.state.capture_service

        # Until finalise the recorder is sole writer (§3.3) and its in-progress
        # counters are less trustworthy than the live session's.
        assert service.adopt_manifest_facts(capture_id) is False
        assert client.app.state.capture_store.get_capture(capture_id).bytes == 0

    def test_an_agreeing_row_is_not_rewritten(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _crashed_capture(client, layout)
        service = client.app.state.capture_service
        assert service.adopt_manifest_facts(capture_id) is True

        # Idempotent, and the return value means "the catalog was wrong and is
        # now right" rather than "I ran" — the reconciler's settled count would
        # otherwise climb forever on a healthy store.
        assert service.adopt_manifest_facts(capture_id) is False
        assert reconcile(client).settled == 0

    def test_a_null_counter_does_not_blank_a_known_one(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _crashed_capture(client, layout)
        store = client.app.state.capture_store
        store.update_capture(capture_id, bytes=999, message_count=7)
        # An older recorder that never measured a count must not erase one the
        # live session did observe: null is "not measured", not "zero".
        write_object_manifest(
            layout.capture_dir(capture_id),
            ObjectManifestV2(
                capture_id=capture_id,
                source_instance_id=client.app.state.instance_id,
                run_id=f"run_{capture_id}",
                state="interrupted",
                started_at="2026-08-03T00:00:00.000Z",
                message_count=None,
                bytes=None,
            ),
        )
        client.app.state.capture_service.adopt_manifest_facts(capture_id)

        capture = store.get_capture(capture_id)
        assert capture.bytes == 999
        assert capture.message_count == 7

    def test_a_corrupt_manifest_adopts_nothing(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _crashed_capture(client, layout)
        (layout.capture_dir(capture_id) / "object_manifest.json").write_bytes(b"")

        service = client.app.state.capture_service
        # §8 rule 4: an unreadable manifest is reported, never guessed from.
        assert service.adopt_manifest_facts(capture_id) is False
        assert client.app.state.capture_store.get_capture(capture_id).bytes == 0

    def test_review_state_is_untouched(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _crashed_capture(
            client, layout, row_state=CaptureState.interrupted
        )
        client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 0, "review_status": "adopted"},
        )
        client.app.state.capture_service.adopt_manifest_facts(capture_id)

        capture = client.app.state.capture_store.get_capture(capture_id)
        # record.json owns review state (§4.1-4); the manifest owns recording
        # facts. Adopting one must not disturb the other.
        assert capture.review_status == "adopted"
        assert capture.review_revision == 1
        assert capture.bytes == RECOVERED_BYTES
