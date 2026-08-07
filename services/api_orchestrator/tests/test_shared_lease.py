"""§7.1 as a SHARED reader lease (rev.2.15).

The lease used to have one owner, which made it two things at once: a record of
"somebody is touching ``objects/<capture_id>``" and a mutual exclusion between
jobs. The second job was never the point, and it is what stopped the N camera
encoders of a single recording running in parallel — so it is gone. Several
readers may hold one capture at once.

**What the lease protects did not change.** Discard and delete refuse while ANY
live holder remains, and the property the whole design leans on is preserved
holder by holder: an expired hold is already not a hold, each expires on its
own, and the capture becomes deletable when the last of them does. Every failure
still resolves toward "deletable again", never toward "permanently stuck".

Holders live in ``capture_leases``, one row per (capture, owner). The table is
volatile and is NOT rebuilt (§8): a lease describes a process running right now,
and a rebuild happens when no such process exists — resurrecting one would lock
a capture out of deletion with no job left to release it.
"""

from __future__ import annotations

from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import Settings
from kairos_common.capture_sidecars import (
    ObjectManifestV2,
    write_object_manifest,
)
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import ReplicaState


def _seed(client: TestClient, layout: DataLayout) -> str:
    capture_id = new_capture_id()
    capture_dir = layout.capture_dir(capture_id)
    capture_dir.mkdir(parents=True)
    (capture_dir / "bag_0.mcap").write_bytes(b"\x89MCAP0\r\n" + b"x" * 64)
    # A real manifest, so the capture still exists after a rebuild — the
    # volatility test below reopens the store with kairos.db deleted.
    write_object_manifest(
        capture_dir,
        ObjectManifestV2(
            capture_id=capture_id,
            source_instance_id=client.app.state.instance_id,
            run_id=f"run_{capture_id}",
            state="completed",
            started_at="2026-08-01T00:00:00.000Z",
            ended_at="2026-08-01T00:05:00.000Z",
        ),
    )
    client.app.state.capture_store.create_capture(
        Capture(
            capture_id=capture_id,
            run_id=f"run_{capture_id}",
            state=CaptureState.completed,
            started_at="2026-08-01T00:00:00.000Z",
        )
    )
    client.app.state.capture_store.upsert_replica(
        capture_id,
        client.app.state.instance_id,
        ReplicaState.present_unverified,
        path=str(capture_dir),
    )
    return capture_id


def _delete(client: TestClient, capture_id: str) -> httpx.Response:
    return client.post(f"/api/v1/captures/{capture_id}/delete", json={"kind": "delete"})


class TestSeveralReadersMayHoldOneCapture:
    def test_five_owners_all_hold_it(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed(client, layout)

        for n in range(5):
            assert store.acquire_lease(capture_id, f"job:cam{n}", ttl_s=600) is True

        assert len(store.lease_holders(capture_id)) == 5
        assert store.has_live_lease(capture_id) is True

    def test_each_holder_sees_only_its_own_hold(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """The mid-job re-check is per owner, which is what makes it useful."""
        store = client.app.state.capture_store
        capture_id = _seed(client, layout)
        store.acquire_lease(capture_id, "job:a", ttl_s=600)
        store.acquire_lease(capture_id, "job:b", ttl_s=600)

        assert store.holds_lease(capture_id, "job:a") is True
        assert store.holds_lease(capture_id, "job:c") is False


class TestDeleteRefusesWhileAnyoneHolds:
    def test_a_delete_names_every_holder(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed(client, layout)
        store.acquire_lease(capture_id, "job:a", ttl_s=600)
        store.acquire_lease(capture_id, "job:b", ttl_s=1200)

        refused = _delete(client, capture_id)

        assert refused.status_code == 409
        error = refused.json()["error"]
        assert error["code"] == "capture_busy"
        owners = [h["owner"] for h in error["details"]["holders"]]
        assert owners == ["job:a", "job:b"], (
            "the refusal named one holder out of several; an operator deciding "
            "whether to wait cannot see how many jobs they are waiting on"
        )
        assert "2 jobs are working on" in error["message"]

    def test_the_scalar_summary_names_the_last_to_finish(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """``lease_owner``/``lease_expires_at`` answer "until when can I retry".

        Kept for clients written against the single-owner shape, and pointed at
        the LATEST expiry rather than an arbitrary holder — that is the moment
        the capture actually becomes deletable.
        """
        store = client.app.state.capture_store
        capture_id = _seed(client, layout)
        store.acquire_lease(capture_id, "job:early", ttl_s=60)
        store.acquire_lease(capture_id, "job:late", ttl_s=6000)

        details = _delete(client, capture_id).json()["error"]["details"]

        assert details["lease_owner"] == "job:late"
        assert details["lease_expires_at"] == details["holders"][-1]["expires_at"]

    def test_one_holder_expiring_is_not_enough(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed(client, layout)
        store.acquire_lease(capture_id, "job:gone", ttl_s=-1)
        store.acquire_lease(capture_id, "job:still_here", ttl_s=600)

        refused = _delete(client, capture_id)

        assert refused.status_code == 409
        owners = [h["owner"] for h in refused.json()["error"]["details"]["holders"]]
        assert owners == ["job:still_here"], (
            "an expired hold was counted as a holder; an expired lease is not "
            "a lease, or a died job locks its capture out of deletion forever"
        )

    def test_when_the_last_holder_goes_the_delete_wins(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """The convergence property, reproduced holder by holder."""
        store = client.app.state.capture_store
        capture_id = _seed(client, layout)
        for n in range(3):
            store.acquire_lease(capture_id, f"job:cam{n}", ttl_s=600)
        assert _delete(client, capture_id).status_code == 409

        for n in range(3):
            store.release_lease(capture_id, f"job:cam{n}")

        assert store.lease_holders(capture_id) == []
        assert _delete(client, capture_id).status_code == 200

    def test_every_holder_expiring_also_lets_the_delete_win(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """No release needed: a whole fleet of dead jobs still converges."""
        store = client.app.state.capture_store
        capture_id = _seed(client, layout)
        for n in range(3):
            store.acquire_lease(capture_id, f"job:cam{n}", ttl_s=-1)

        assert store.has_live_lease(capture_id) is False
        assert _delete(client, capture_id).status_code == 200

    def test_a_reader_finishing_unblocks_the_delete_that_was_refused(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """The race the operator actually meets: refuse, then succeed."""
        store = client.app.state.capture_store
        capture_id = _seed(client, layout)
        store.acquire_lease(capture_id, "job:encoder", ttl_s=600)

        assert _delete(client, capture_id).status_code == 409
        store.release_lease(capture_id, "job:encoder")

        assert _delete(client, capture_id).status_code == 200


class TestRenewAndRelease:
    def test_renewing_extends_only_that_owners_row(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed(client, layout)
        store.acquire_lease(capture_id, "job:a", ttl_s=600)
        store.acquire_lease(capture_id, "job:b", ttl_s=600)
        before = {h["owner"]: h["expires_at"] for h in store.lease_holders(capture_id)}

        store.acquire_lease(capture_id, "job:a", ttl_s=9000)

        after = {h["owner"]: h["expires_at"] for h in store.lease_holders(capture_id)}
        assert after["job:a"] > before["job:a"]
        assert after["job:b"] == before["job:b"]

    def test_renewing_does_not_add_a_second_row_for_one_owner(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed(client, layout)

        for _ in range(4):
            store.acquire_lease(capture_id, "job:a", ttl_s=600)

        assert len(store.lease_holders(capture_id)) == 1

    def test_release_only_drops_the_named_owner(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed(client, layout)
        store.acquire_lease(capture_id, "job:a", ttl_s=600)
        store.acquire_lease(capture_id, "job:b", ttl_s=600)

        assert store.release_lease(capture_id, "job:a") is True
        assert [h["owner"] for h in store.lease_holders(capture_id)] == ["job:b"]

    def test_releasing_a_hold_nobody_has_is_a_no_op(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed(client, layout)
        store.acquire_lease(capture_id, "job:a", ttl_s=600)

        assert store.release_lease(capture_id, "job:someone_else") is False
        assert [h["owner"] for h in store.lease_holders(capture_id)] == ["job:a"]

    def test_expired_rows_are_swept_by_the_next_acquire(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """No GC task: the sweep rides on a write that was happening anyway."""
        store = client.app.state.capture_store
        capture_id = _seed(client, layout)
        store.acquire_lease(capture_id, "job:dead", ttl_s=-1)

        store.acquire_lease(capture_id, "job:live", ttl_s=600)

        with store._conn() as conn:
            rows = conn.execute(
                "SELECT owner FROM capture_leases WHERE capture_id = ?",
                (capture_id,),
            ).fetchall()
        assert [row["owner"] for row in rows] == ["job:live"]


class TestLeasesAreVolatile:
    def test_a_rebuild_leaves_no_holders_behind(
        self,
        settings: Settings,
        data_dir: Path,
        fake_recorder: FakeRecorder,
    ) -> None:
        """§8 does not rebuild leases, and must not.

        A lease describes a process running right now. A rebuild happens when no
        such process exists, so a restored hold would refuse deletes forever
        with no job left to release it — the one outcome §7.1 forbids.
        """

        def boot() -> TestClient:
            return TestClient(
                create_orchestrator_app(
                    settings,
                    http_client=httpx.AsyncClient(
                        transport=httpx.MockTransport(fake_recorder.handler)
                    ),
                )
            )

        with boot() as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)
            client.app.state.capture_store.acquire_lease(
                capture_id, "job:encoder", ttl_s=6000
            )
            assert _delete(client, capture_id).status_code == 409

        (data_dir / "kairos.db").unlink()

        with boot() as reopened:
            assert reopened.app.state.capture_store.lease_holders(capture_id) == []
            assert _delete(reopened, capture_id).status_code == 200
