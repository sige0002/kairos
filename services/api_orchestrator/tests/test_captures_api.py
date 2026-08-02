"""``/api/v1/captures``: listing, detail, and the §4.1 review save.

The review save is where two terminals can collide, so most of this file is
about what happens when they do. The rule is compare-and-swap, never merge: the
loser gets a 409 telling it to reload, and the sidecar it may already have
written is deliberately left ahead of the database.
"""

from __future__ import annotations

from unittest.mock import patch

from api_orchestrator.models import Batch, Capture, CaptureState
from api_orchestrator.store import CaptureStore
from conftest import FakeRecorder, run_digests
from fastapi.testclient import TestClient
from kairos_common.capture_sidecars import read_record
from kairos_common.ids import new_capture_id


def _seed(
    store: CaptureStore, layout, *, with_dir: bool = True, **fields: object
) -> str:
    """A completed capture, on disk and in the catalog."""
    capture_id = str(fields.pop("capture_id", None) or new_capture_id())
    defaults: dict[str, object] = {
        "capture_id": capture_id,
        "run_id": f"run_{capture_id}",
        "state": CaptureState.completed,
        "operator": "alice",
        "task": "pick",
        "robot": "r1",
        "started_at": "2026-08-01T00:00:00.000Z",
    }
    defaults.update(fields)
    store.create_capture(Capture(**defaults))  # type: ignore[arg-type]
    if with_dir:
        layout.capture_dir(capture_id).mkdir(parents=True, exist_ok=True)
    return capture_id


class TestList:
    def test_filters_narrow_the_page(self, client: TestClient) -> None:
        store = client.app.state.capture_store
        layout = client.app.state.data_layout
        _seed(store, layout, operator="alice", task="pick")
        _seed(store, layout, operator="bob", task="place")

        body = client.get("/api/v1/captures", params={"operator": "alice"}).json()
        assert [c["operator"] for c in body["items"]] == ["alice"]

    def test_a_tombstoned_capture_is_hidden_unless_asked_for(
        self, client: TestClient
    ) -> None:
        store = client.app.state.capture_store
        layout = client.app.state.data_layout
        buried = _seed(store, layout, state=CaptureState.discarded, with_dir=False)

        visible = client.get("/api/v1/captures").json()["items"]
        assert buried not in {c["capture_id"] for c in visible}

        # The row survives so "where did it go" stays answerable (§7).
        all_of_them = client.get(
            "/api/v1/captures", params={"include_deleted": True}
        ).json()["items"]
        assert buried in {c["capture_id"] for c in all_of_them}

    def test_paging_is_stable_across_a_cursor(self, client: TestClient) -> None:
        store = client.app.state.capture_store
        layout = client.app.state.data_layout
        for _ in range(3):
            _seed(store, layout)

        first = client.get("/api/v1/captures", params={"limit": 2}).json()
        assert len(first["items"]) == 2
        second = client.get(
            "/api/v1/captures", params={"limit": 2, "cursor": first["next_cursor"]}
        ).json()
        assert len(second["items"]) == 1
        assert second["next_cursor"] is None


class TestDetail:
    def test_detail_carries_the_manifest_and_the_record(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        client.post("/api/v1/record/start", json={"topics": ["/joint_states"]})
        capture_id = fake_recorder.capture_id
        client.post("/api/v1/record/stop")
        run_digests(client)
        client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 0, "review_status": "adopted"},
        )

        body = client.get(f"/api/v1/captures/{capture_id}").json()
        assert body["manifest"]["capture_id"] == capture_id
        assert body["record"]["revision"] == 1
        # The digest queued at stop has sealed the manifest, so the replica is
        # verified and digest_state derives from it rather than a second column.
        assert body["replica"]["state"] == "present_verified"
        assert body["digest_state"] == "complete"

    def test_an_unknown_capture_is_a_404(self, client: TestClient) -> None:
        response = client.get(f"/api/v1/captures/{new_capture_id()}")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "capture_not_found"

    def test_a_non_uuid_id_is_a_404_not_a_path(self, client: TestClient) -> None:
        # capture_id becomes a directory name, so anything that is not a UUIDv7
        # is refused before it can be joined onto objects/.
        assert client.get("/api/v1/captures/..%2f..%2fetc").status_code == 404


class TestReviewSave:
    def test_a_save_writes_the_sidecar_before_the_row(self, client: TestClient) -> None:
        store = client.app.state.capture_store
        layout = client.app.state.data_layout
        capture_id = _seed(store, layout)

        saved = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={
                "base_revision": 0,
                "task_result": "success",
                "quality": "good",
                "review_status": "adopted",
            },
        ).json()
        assert saved["review_revision"] == 1

        # record.json is authoritative for review state (§4.1-4), so it must
        # exist and agree — the row is only a cache of it.
        record = read_record(layout.capture_dir(capture_id))
        assert record.ok
        assert record.record is not None
        assert record.record.revision == 1
        assert record.record.review_status == "adopted"

    def test_a_stale_base_revision_is_a_409(self, client: TestClient) -> None:
        store = client.app.state.capture_store
        layout = client.app.state.data_layout
        capture_id = _seed(store, layout)
        client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 0, "review_status": "adopted"},
        )

        conflict = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 0, "review_status": "excluded"},
        )
        assert conflict.status_code == 409
        error = conflict.json()["error"]
        assert error["code"] == "review_conflict"
        # The client needs the current revision to reload and re-apply.
        assert error["details"]["current_revision"] == 1

    def test_a_lost_cas_race_leaves_the_sidecar_ahead_and_does_not_roll_back(
        self, client: TestClient
    ) -> None:
        store = client.app.state.capture_store
        layout = client.app.state.data_layout
        capture_id = _seed(store, layout)

        # Model the race precisely: our request reads revision 0, writes its
        # sidecar, and only then does the other terminal's save commit.
        real_cas = store.save_review_cas

        def losing_cas(cid: str, **kwargs: object) -> bool:
            store.save_review_cas = real_cas  # only steal the first call
            real_cas(cid, base_revision=0, fields={"review_status": "excluded"})
            return real_cas(cid, **kwargs)  # type: ignore[arg-type]

        store.save_review_cas = losing_cas  # type: ignore[method-assign]
        conflict = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 0, "review_status": "adopted"},
        )
        assert conflict.status_code == 409

        # The sidecar we wrote is NOT rewound (§4.1-3): rewriting it would race
        # the winner's own sidecar, and a sidecar ahead of the database is the
        # direction a rebuild can resolve.
        record = read_record(layout.capture_dir(capture_id))
        assert record.record is not None
        assert record.record.review_status == "adopted"
        # The database holds the winner's value.
        winner = store.get_capture(capture_id)
        assert winner.review_status == "excluded"

    def test_a_sidecar_write_failure_is_a_500_with_the_row_untouched(
        self, client: TestClient
    ) -> None:
        store = client.app.state.capture_store
        layout = client.app.state.data_layout
        capture_id = _seed(store, layout)

        with patch(
            "api_orchestrator.captures.write_record",
            side_effect=OSError("no space left on device"),
        ):
            response = client.patch(
                f"/api/v1/captures/{capture_id}/review",
                json={"base_revision": 0, "review_status": "adopted"},
            )
        assert response.status_code == 500
        assert response.json()["error"]["code"] == "review_sidecar_write_failed"

        # Nothing was saved, so the same base_revision is still valid: the
        # client can simply retry once the disk is writable.
        capture = store.get_capture(capture_id)
        assert capture.review_revision == 0
        assert capture.review_status == "pending"

    def test_an_omitted_field_keeps_its_value_and_an_explicit_null_clears_it(
        self, client: TestClient
    ) -> None:
        store = client.app.state.capture_store
        layout = client.app.state.data_layout
        capture_id = _seed(store, layout)
        client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={
                "base_revision": 0,
                "task_result": "failure",
                "failure_reason": "gripper slipped",
            },
        )

        # Omitted: unchanged.
        after = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 1, "review_status": "excluded"},
        ).json()
        assert after["failure_reason"] == "gripper slipped"

        # Explicitly null: cleared. Treating null as "not supplied" would make a
        # recorded failure_reason impossible to ever remove.
        cleared = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 2, "failure_reason": None},
        ).json()
        assert cleared["failure_reason"] is None

    def test_the_first_save_bumps_the_batch_counter_once(
        self, client: TestClient
    ) -> None:
        store = client.app.state.capture_store
        layout = client.app.state.data_layout
        store.create_batch(Batch(batch_id="batch_1", project="p", task="t"))
        capture_id = _seed(store, layout, batch_id="batch_1")

        client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={
                "base_revision": 0,
                "batch_id": "batch_1",
                "review_status": "adopted",
            },
        )
        client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 1, "review_status": "excluded"},
        )
        # Monotone and once per capture: the counter answers "how many did we
        # record", which a later exclude does not change (§4.1's移設 of the
        # retired POST /episodes side effect).
        assert store.get_batch("batch_1").episodes_recorded == 1

    def test_reviewing_a_discarded_capture_is_refused(self, client: TestClient) -> None:
        store = client.app.state.capture_store
        layout = client.app.state.data_layout
        capture_id = _seed(store, layout, state=CaptureState.discarded, with_dir=False)
        response = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 0, "review_status": "adopted"},
        )
        # Writing record.json would recreate objects/<capture_id>/ for a capture
        # whose bytes were deliberately destroyed.
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "capture_deleted"
        assert not layout.capture_dir(capture_id).exists()

    def test_a_review_before_the_bytes_arrive_still_saves(
        self, client: TestClient
    ) -> None:
        store = client.app.state.capture_store
        layout = client.app.state.data_layout
        # A split deployment reviews on the recording PC before the pull lands —
        # the auto-pull is triggered BY this save — so no local copy yet is a
        # normal state, not an error.
        capture_id = _seed(store, layout, with_dir=False)
        response = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 0, "review_status": "adopted"},
        )
        assert response.status_code == 200
        record = read_record(layout.capture_dir(capture_id))
        assert record.ok
