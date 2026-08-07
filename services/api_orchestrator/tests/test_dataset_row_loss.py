"""E-19: a dataset row that leaves ``kairos.db`` without a ledger event.

Every other deletion path in the suite goes through the API, which appends
``dataset_deleted`` before touching the row. This is the other case: the row is
gone from the index and the ledger never heard about it — a hand-edited
database, a partial restore, an operator with sqlite3 and a theory.

The contract says the sidecars and ``lifecycle.jsonl`` are authoritative and
``kairos.db`` is an index that can be deleted and rebuilt from them, so bringing
the dataset back is not a bug to fix but the whole design working. What these
tests pin is that the ledger — not the row — is what decides, in BOTH
directions, and that the one thing a replay cannot reconstruct honestly gets
said out loud instead of being rebuilt in silence.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import ledger_v2
from kairos_common.ids import new_capture_id
from test_dataset_archive import _archive_client, _dataset, _settle


def _capture(client: TestClient, layout: DataLayout) -> str:
    store = client.app.state.capture_store
    capture_id = new_capture_id()
    layout.capture_dir(capture_id).mkdir(parents=True, exist_ok=True)
    store.create_capture(
        Capture(
            capture_id=capture_id,
            run_id=f"run_{capture_id}",
            state=CaptureState.completed,
            operator="alice",
            task="pick",
            started_at="2026-08-01T00:00:00.000Z",
        )
    )
    return capture_id


class TestRowLossWithoutALedgerEvent:
    def test_the_ledger_not_the_row_decides_what_comes_back(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """Two datasets, two kinds of disappearance, opposite outcomes.

        The one deleted through the API stays gone because the ledger says so.
        The one whose row simply vanished comes back with its members and their
        numbers, because nothing ever recorded it leaving. Anything else would
        mean an index nobody may repair, or a delete that undeletes itself.
        """
        store = client.app.state.capture_store
        kept = client.post("/api/v1/datasets", json={"name": "kept"}).json()
        removed = client.post("/api/v1/datasets", json={"name": "removed"}).json()
        indices = []
        for _ in range(2):
            indices.append(
                client.post(
                    f"/api/v1/datasets/{kept['dataset_id']}/members",
                    json={"capture_id": _capture(client, layout)},
                ).json()["display_index"]
            )
        assert indices == [1, 2]
        # The honest deletion: ledger first, then the row.
        gone = removed["dataset_id"]
        assert client.delete(f"/api/v1/datasets/{gone}").status_code == 204
        # The dishonest one: the row, and nothing else. This is what
        # `DELETE FROM datasets WHERE ...` in a sqlite3 shell leaves behind.
        assert store.delete_dataset(kept["dataset_id"])
        assert client.get(f"/api/v1/datasets/{kept['dataset_id']}").status_code == 404

        client.app.state.dataset_service.restore_from_ledger()

        detail = client.get(f"/api/v1/datasets/{kept['dataset_id']}").json()
        assert detail["name"] == "kept"
        assert [m["display_index"] for m in detail["members"]] == [1, 2]
        # And the numbers are still spoken for: a rebuilt dataset does not
        # restart at 1 and hand a live member's number to a stranger.
        assert (
            client.post(
                f"/api/v1/datasets/{kept['dataset_id']}/members",
                json={"capture_id": _capture(client, layout)},
            ).json()["display_index"]
            == 3
        )
        # The API-deleted one stays deleted, however many times this runs.
        assert client.get(f"/api/v1/datasets/{gone}").status_code == 404

    def test_a_resurrected_dataset_brings_its_archive_claim_back(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        """The row carried a destination; the replay must carry it back.

        The claim on an archive destination lives in the row (§6.x), so a row
        that vanished took the claim with it — and a second dataset could then
        be handed a folder the first one is the archived record of. The replay
        restores the claim from the ledger's own ``dataset_archived`` line.
        """
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            store = client.app.state.capture_store
            archived = _dataset(client, layout, members=1, name="archived")
            later = _dataset(client, layout, members=1, name="later")
            body = {"destination": str(roots), "path": "handoff/final_set"}
            assert (
                client.post(
                    f"/api/v1/datasets/{archived['dataset_id']}/archive", json=body
                ).status_code
                == 202
            )
            _settle(client, archived["dataset_id"])
            target = roots / "handoff" / "final_set"

            # The index loses the row, and the export is moved off to tape —
            # so neither the claim nor the bytes are there to refuse anybody.
            assert store.delete_dataset(archived["dataset_id"])
            for path in sorted(target.iterdir(), reverse=True):
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()

            client.app.state.dataset_service.restore_from_ledger()

            row = store.get_dataset(archived["dataset_id"])
            assert row is not None
            assert row["status"] == "archived"
            assert row["archive_destination"] == str(target)
            # With the claim back, the folder is refused to the next dataset.
            response = client.post(
                f"/api/v1/datasets/{later['dataset_id']}/archive", json=body
            )
            assert response.status_code == 409, response.text
            assert response.json()["error"]["code"] == "destination_claimed"
            assert (
                response.json()["error"]["details"]["held_by"]
                == (archived["dataset_id"])
            )

    def test_a_ledger_that_gave_one_folder_to_two_datasets_says_so(
        self,
        client: TestClient,
        layout: DataLayout,
        settings,
        fake_recorder: FakeRecorder,
    ) -> None:
        """The replay reconstructs history it would now refuse to create.

        A ledger written before the destination claim existed can hold two
        ``dataset_archived`` lines for one folder — that is exactly what the
        unguarded race produced. Replaying it is right: the events happened.
        Replaying it in silence is not, because the rebuilt catalog then shows
        two datasets whose archived record is the same directory, and only one
        of them can be describing what is in it.
        """
        store = client.app.state.capture_store
        destination = "/mnt/nas/exports/one_folder"
        for name in ("first", "second"):
            dataset_id = client.post("/api/v1/datasets", json={"name": name}).json()[
                "dataset_id"
            ]
            member = client.post(
                f"/api/v1/datasets/{dataset_id}/members",
                json={"capture_id": _capture(client, layout)},
            ).json()
            store.delete_dataset(dataset_id)
            for kind in ("dataset_archive_started", "dataset_archived"):
                ledger_v2.append(
                    layout.data_dir,
                    kind,
                    instance_id=client.app.state.instance_id,
                    payload={
                        "dataset_id": dataset_id,
                        "destination": destination,
                        "dataset_name": name,
                        "mode": "move",
                        "members": [
                            {
                                "membership_id": member["membership_id"],
                                "capture_id": member["capture_id"],
                                "display_index": member["display_index"],
                            }
                        ],
                    },
                )

        # A real restart onto a missing index, which is what replays the ledger.
        client.__exit__(None, None, None)
        layout.db.unlink()
        app = create_orchestrator_app(
            settings,
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(fake_recorder.handler)
            ),
        )

        with TestClient(app) as restarted:
            rebuilt = restarted.app.state.capture_store
            # Both rows come back — the replay never refuses history.
            holders = [
                row["dataset_id"]
                for row in rebuilt.list_datasets()
                if row.get("archive_destination") == destination
            ]
            assert len(holders) == 2
            # And the collision reaches the endpoint the Monitor store-health
            # card reads. This is the one finding here an operator cannot act
            # on without being told, and a counter nothing reads is not being
            # told: it arrives as the sentence, in the same warnings list the
            # capture half of the rebuild uses.
            health = restarted.get("/api/v1/store/health").json()
            matching = [w for w in health["warnings"] if destination in w]
            assert len(matching) == 1, health["warnings"]
            assert "more than one dataset" in matching[0]
            assert health["rebuild_summary"]["warning_count"] >= 1
