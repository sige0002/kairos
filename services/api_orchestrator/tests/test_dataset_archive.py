"""The dataset archive run (§6.x): freeze, copy out, seal — and every resume.

The run is N per-capture archives plus a start and a seal, so the tests here
are mostly about the seams: what refuses before anything moves, and what a
resume does at each place a crash can land. Crash states are constructed
directly (rows, ledger lines, debris directories) rather than induced, because
the whole design claim is that the resume decides from durable state alone.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.dataset_archive import MANIFEST_NAME
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
    (capture_dir / "bag_0.mcap").write_bytes(b"\x89MCAP0\r\n" + b"payload" * 100)
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
    store.upsert_replica(
        capture_id,
        client.app.state.instance_id,
        ReplicaState.present_unverified,
        path=str(capture_dir),
    )
    return capture_id


def _dataset(client: TestClient, layout: DataLayout, *, members: int) -> dict:
    dataset = client.post(
        "/api/v1/datasets", json={"name": "ds", "operator": "alice", "task": "pick"}
    ).json()
    for _ in range(members):
        client.post(
            f"/api/v1/datasets/{dataset['dataset_id']}/members",
            json={"capture_id": _seed(client, layout)},
        )
    return dataset


def _settle(client: TestClient, dataset_id: str, *, attempts: int = 500) -> None:
    """Wait for the background run, the same way ``settle_views`` waits."""
    archiver = client.app.state.dataset_archiver
    for _ in range(attempts):
        if not archiver.is_running(dataset_id) and not archiver._tasks:
            return
        time.sleep(0.01)
    raise AssertionError("the archive run did not settle")


def _events(layout: DataLayout, kind: str) -> list[dict]:
    return [e for e in ledger_v2.read_all(layout.data_dir) if e["kind"] == kind]


# The server appends <operator>/<task>/<name> to the sent destination itself.
def _dataset_dir(roots: Path) -> Path:
    return roots / "exports" / "alice" / "pick" / "ds"


class TestPreflight:
    """Everything that must refuse before a single byte moves."""

    def test_a_shared_member_blocks_the_start(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            dataset = _dataset(client, layout, members=1)
            member = client.get(f"/api/v1/datasets/{dataset['dataset_id']}").json()[
                "members"
            ][0]
            other = client.post("/api/v1/datasets", json={"name": "other"}).json()
            client.post(
                f"/api/v1/datasets/{other['dataset_id']}/members",
                json={"capture_id": member["capture_id"]},
            )

            response = client.post(
                f"/api/v1/datasets/{dataset['dataset_id']}/archive",
                json={"destination": str(roots / "exports")},
            )

            assert response.status_code == 409
            error = response.json()["error"]
            assert error["code"] == "dataset_member_shared"
            assert error["details"]["conflicts"][0]["capture_id"] == (
                member["capture_id"]
            )
            assert error["details"]["conflicts"][0]["dataset_ids"] == [
                other["dataset_id"]
            ]
            # Nothing moved, nothing froze.
            detail = client.get(f"/api/v1/datasets/{dataset['dataset_id']}").json()
            assert detail["status"] == "active"

    def test_an_empty_dataset_has_nothing_to_archive(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            dataset = client.post("/api/v1/datasets", json={"name": "ds"}).json()
            response = client.post(
                f"/api/v1/datasets/{dataset['dataset_id']}/archive",
                json={"destination": str(roots / "exports")},
            )
            assert response.status_code == 409
            assert response.json()["error"]["code"] == "dataset_empty"

    def test_without_configured_roots_the_start_refuses(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        dataset = _dataset(client, layout, members=1)
        response = client.post(
            f"/api/v1/datasets/{dataset['dataset_id']}/archive",
            json={"destination": "/mnt/nas/exports"},
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "archive_not_configured"

    def test_a_destination_overlapping_the_store_is_refused(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        # The allow-list contains the data dir — the §6 misconfiguration the
        # overlap check exists to survive.
        with _archive_client(data_dir, data_dir, fake_recorder) as client:
            layout = client.app.state.data_layout
            dataset = _dataset(client, layout, members=1)
            response = client.post(
                f"/api/v1/datasets/{dataset['dataset_id']}/archive",
                json={"destination": str(data_dir)},
            )
            assert response.status_code == 400
            assert response.json()["error"]["code"] == "destination_inside_data_dir"

    def test_busy_members_are_each_reported_with_their_reason(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            store = client.app.state.capture_store
            dataset = _dataset(client, layout, members=2)
            members = client.get(f"/api/v1/datasets/{dataset['dataset_id']}").json()[
                "members"
            ]
            store.update_capture(members[0]["capture_id"], state=CaptureState.recording)
            import shutil

            shutil.rmtree(layout.capture_dir(members[1]["capture_id"]))

            response = client.post(
                f"/api/v1/datasets/{dataset['dataset_id']}/archive",
                json={"destination": str(roots / "exports")},
            )

            # One 409 listing every blocker, not one blocker per round-trip:
            # the operation is N captures and the operator fixes them together.
            assert response.status_code == 409
            error = response.json()["error"]
            assert error["code"] == "dataset_not_archivable"
            codes = {b["capture_id"]: b["code"] for b in error["details"]["blockers"]}
            assert codes == {
                members[0]["capture_id"]: "capture_recording",
                members[1]["capture_id"]: "capture_not_present",
            }

    def test_a_non_empty_destination_is_refused(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            dataset = _dataset(client, layout, members=1)
            occupied = _dataset_dir(roots)
            occupied.mkdir(parents=True)
            (occupied / "surprise.txt").write_text("here first", encoding="utf-8")

            response = client.post(
                f"/api/v1/datasets/{dataset['dataset_id']}/archive",
                json={"destination": str(roots / "exports")},
            )
            assert response.status_code == 409
            assert response.json()["error"]["code"] == "destination_not_empty"


class TestHappyPath:
    def test_the_run_copies_seals_and_flips(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            store = client.app.state.capture_store
            dataset = _dataset(client, layout, members=2)
            dataset_id = dataset["dataset_id"]
            members = client.get(f"/api/v1/datasets/{dataset_id}").json()["members"]

            accepted = client.post(
                f"/api/v1/datasets/{dataset_id}/archive",
                json={"destination": str(roots / "exports")},
            )
            assert accepted.status_code == 202
            assert accepted.json()["status"] == "archiving"
            _settle(client, dataset_id)

            # The dataset: terminal, and it says where.
            detail = client.get(f"/api/v1/datasets/{dataset_id}").json()
            target = _dataset_dir(roots)
            assert detail["status"] == "archived"
            assert detail["archive_destination"] == str(target)
            assert detail["archived_at"] is not None

            # The destination: the views shape, plus a manifest that vouches
            # for itself.
            assert (target / "001" / "bag_0.mcap").is_file()
            assert (target / "002" / "bag_0.mcap").is_file()
            manifest_bytes = (target / MANIFEST_NAME).read_bytes()
            manifest = json.loads(manifest_bytes)
            assert manifest["status"] == "complete"
            assert manifest["dataset_id"] == dataset_id
            assert [m["dir"] for m in manifest["members"]] == ["001", "002"]
            assert all(m["files"] for m in manifest["members"])
            assert manifest["started_event_id"]

            # The ledger: started → one archive per member → seal, and the
            # seal's hash is the manifest that is actually on disk.
            started = _events(layout, "dataset_archive_started")
            archived = _events(layout, "capture_archived")
            seals = _events(layout, "dataset_archived")
            assert len(started) == 1 and len(seals) == 1
            assert {e["capture_id"] for e in archived} == {
                m["capture_id"] for m in members
            }
            assert seals[0]["manifest_sha256"] == (
                hashlib.sha256(manifest_bytes).hexdigest()
            )
            assert seals[0]["member_total"] == 2

            # The store: sources gone, rows kept, views no longer cite it.
            for member in members:
                assert not layout.capture_dir(member["capture_id"]).exists()
                row = store.get_capture(member["capture_id"])
                assert row.archived_at is not None
            assert store.list_view_entries() == []

            progress = client.get(f"/api/v1/datasets/{dataset_id}/archive").json()
            assert progress["members_done"] == 2
            assert progress["member_total"] == 2
            assert progress["running"] is False
            assert progress["error"] is None


class TestResume:
    """Each crash window, constructed as durable state and resumed."""

    def _frozen_run(
        self, client: TestClient, layout: DataLayout, roots: Path, *, members: int = 2
    ) -> tuple[str, list[dict], Path]:
        """A dataset whose run started (CAS + started event) and then died
        before copying anything: exactly what a crash right after the 202
        leaves behind, and what the ledger replay reconstructs."""
        dataset = _dataset(client, layout, members=members)
        dataset_id = dataset["dataset_id"]
        detail = client.get(f"/api/v1/datasets/{dataset_id}").json()
        target = _dataset_dir(roots)
        store = client.app.state.capture_store
        assert store.begin_dataset_archive(dataset_id, destination=str(target))
        ledger_v2.append(
            layout.data_dir,
            "dataset_archive_started",
            instance_id=client.app.state.instance_id,
            payload={
                "dataset_id": dataset_id,
                "destination": str(target),
                "dataset_name": "ds",
                "operator": "alice",
                "task": "pick",
                "members": [
                    {
                        "membership_id": m["membership_id"],
                        "capture_id": m["capture_id"],
                        "display_index": m["display_index"],
                    }
                    for m in detail["members"]
                ],
            },
        )
        return dataset_id, detail["members"], target

    def _resume(self, client: TestClient, dataset_id: str) -> dict:
        response = client.post(f"/api/v1/datasets/{dataset_id}/archive", json={})
        assert response.status_code == 202, response.text
        _settle(client, dataset_id)
        return client.get(f"/api/v1/datasets/{dataset_id}/archive").json()

    def test_a_frozen_start_resumes_to_the_end(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            dataset_id, _, target = self._frozen_run(client, layout, roots)

            progress = self._resume(client, dataset_id)

            assert progress["status"] == "archived"
            assert (target / "001" / "bag_0.mcap").is_file()
            # Resume did not re-freeze: one started line, one seal.
            assert len(_events(layout, "dataset_archive_started")) == 1
            assert len(_events(layout, "dataset_archived")) == 1

    def test_a_completed_member_is_not_archived_twice(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            service = client.app.state.capture_service
            dataset_id, members, target = self._frozen_run(client, layout, roots)
            # Member 1 finished before the crash — through the real code path.
            asyncio.run(
                service.archive_member(
                    members[0]["capture_id"],
                    dataset_id=dataset_id,
                    membership_id=members[0]["membership_id"],
                    display_index=members[0]["display_index"],
                    target=target / "001",
                )
            )

            progress = self._resume(client, dataset_id)

            assert progress["status"] == "archived"
            events = _events(layout, "capture_archived")
            # One event per member: the finished one was recognised from its
            # row, not copied and recorded again.
            assert len(events) == len(members)

    def test_a_crash_between_append_and_row_finishes_without_recopying(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            store = client.app.state.capture_store
            dataset_id, members, target = self._frozen_run(
                client, layout, roots, members=1
            )
            capture_id = members[0]["capture_id"]
            # The copy landed and the ledger recorded it; the row update and
            # the source removal never happened.
            (target / "001").mkdir(parents=True)
            (target / "001" / "bag_0.mcap").write_bytes(b"copied")
            ledger_v2.append(
                layout.data_dir,
                "capture_archived",
                instance_id=client.app.state.instance_id,
                capture_id=capture_id,
                payload={
                    "destination": str(target / "001"),
                    "dataset_id": dataset_id,
                    "membership_id": members[0]["membership_id"],
                    "display_index": 1,
                },
            )

            progress = self._resume(client, dataset_id)

            assert progress["status"] == "archived"
            # The ledger line was believed: no second copy, no second event.
            assert (target / "001" / "bag_0.mcap").read_bytes() == b"copied"
            assert len(_events(layout, "capture_archived")) == 1
            row = store.get_capture(capture_id)
            assert row.archived_at is not None
            assert not layout.capture_dir(capture_id).exists()

    def test_unrecorded_debris_is_rebuilt_while_the_source_lives(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            dataset_id, members, target = self._frozen_run(
                client, layout, roots, members=1
            )
            # A copy died mid-write: bytes at the target, nothing in the ledger.
            (target / "001").mkdir(parents=True)
            (target / "001" / "bag_0.mcap").write_bytes(b"half a")

            progress = self._resume(client, dataset_id)

            assert progress["status"] == "archived"
            copied = (target / "001" / "bag_0.mcap").read_bytes()
            assert copied.startswith(b"\x89MCAP0")  # the real bytes, re-copied

    def test_debris_with_no_source_halts_for_a_human(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            dataset_id, members, target = self._frozen_run(
                client, layout, roots, members=1
            )
            (target / "001").mkdir(parents=True)
            (target / "001" / "bag_0.mcap").write_bytes(b"half a")
            import shutil

            shutil.rmtree(layout.capture_dir(members[0]["capture_id"]))

            progress = self._resume(client, dataset_id)

            # The one state the runner must not touch: the only bytes left are
            # an unverified, unrecorded copy.
            assert progress["status"] == "archiving"
            assert progress["running"] is False
            assert progress["error"]["code"] == "bytes_unaccounted"
            assert (target / "001" / "bag_0.mcap").read_bytes() == b"half a"

    def test_a_sealed_run_only_needs_its_flip(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            store = client.app.state.capture_store
            dataset_id, members, target = self._frozen_run(
                client, layout, roots, members=1
            )
            capture_id = members[0]["capture_id"]
            # Everything happened except the status flip.
            import shutil

            (target / "001").mkdir(parents=True)
            ledger_v2.append(
                layout.data_dir,
                "capture_archived",
                instance_id=client.app.state.instance_id,
                capture_id=capture_id,
                payload={"destination": str(target / "001")},
            )
            store.update_capture(
                capture_id,
                archived_at="2026-08-01T00:00:00.000Z",
                archive_destination=str(target / "001"),
            )
            shutil.rmtree(layout.capture_dir(capture_id))
            ledger_v2.append(
                layout.data_dir,
                "dataset_archived",
                instance_id=client.app.state.instance_id,
                payload={"dataset_id": dataset_id, "destination": str(target)},
            )

            progress = self._resume(client, dataset_id)

            assert progress["status"] == "archived"
            assert len(_events(layout, "dataset_archived")) == 1  # no second seal

    def test_a_membership_planted_mid_run_halts_the_member(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            store = client.app.state.capture_store
            dataset_id, members, target = self._frozen_run(
                client, layout, roots, members=1
            )
            # A second membership appears after the preflight — through the
            # store directly, because the API-level guard refuses it. The
            # runner's own re-check must still catch it.
            other = client.post("/api/v1/datasets", json={"name": "other"}).json()
            store.add_dataset_member(
                other["dataset_id"], members[0]["capture_id"]
            )

            progress = self._resume(client, dataset_id)

            assert progress["status"] == "archiving"
            assert progress["error"]["code"] == "capture_in_dataset"
            assert layout.capture_dir(members[0]["capture_id"]).is_dir()


class TestResumeRefusals:
    def test_a_new_destination_cannot_hijack_a_run(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            store = client.app.state.capture_store
            dataset = _dataset(client, layout, members=1)
            store.begin_dataset_archive(
                dataset["dataset_id"], destination=str(_dataset_dir(roots))
            )

            response = client.post(
                f"/api/v1/datasets/{dataset['dataset_id']}/archive",
                json={"destination": str(roots / "elsewhere")},
            )
            assert response.status_code == 409
            assert (
                response.json()["error"]["code"] == "archive_destination_mismatch"
            )

    def test_progress_for_an_unknown_dataset_is_404(self, client: TestClient) -> None:
        response = client.get("/api/v1/datasets/nope/archive")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "dataset_not_found"


class TestCopyMode:
    """§6.1 mode=copy: seal the set, keep the recordings — sources untouched."""

    def test_a_copy_seals_shares_and_all_and_touches_nothing(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            store = client.app.state.capture_store
            dataset = _dataset(client, layout, members=2)
            dataset_id = dataset["dataset_id"]
            members = client.get(f"/api/v1/datasets/{dataset_id}").json()["members"]
            # One member is SHARED with another active dataset — the very case
            # a combined set produces, and the reason copy mode exists.
            other = client.post("/api/v1/datasets", json={"name": "source"}).json()
            client.post(
                f"/api/v1/datasets/{other['dataset_id']}/members",
                json={"capture_id": members[0]["capture_id"]},
            )

            accepted = client.post(
                f"/api/v1/datasets/{dataset_id}/archive",
                json={"destination": str(roots / "exports"), "mode": "copy"},
            )
            assert accepted.status_code == 202, accepted.text
            _settle(client, dataset_id)

            detail = client.get(f"/api/v1/datasets/{dataset_id}").json()
            target = _dataset_dir(roots)
            assert detail["status"] == "archived"
            assert detail["archive_mode"] == "copy"

            # The export is complete and self-describing…
            assert (target / "001" / "bag_0.mcap").is_file()
            assert (target / "002" / "bag_0.mcap").is_file()
            manifest = json.loads((target / MANIFEST_NAME).read_bytes())
            assert manifest["mode"] == "copy"
            assert manifest["status"] == "complete"
            assert all(m["files"] for m in manifest["members"])
            assert all(
                m["capture_archived_event_id"] is None for m in manifest["members"]
            )
            seals = _events(layout, "dataset_archived")
            assert len(seals) == 1 and seals[0]["mode"] == "copy"

            # …and NOTHING here changed: no per-member events, no row updates,
            # every recording still on disk, the sharing dataset intact.
            assert _events(layout, "capture_archived") == []
            for member in members:
                row = store.get_capture(member["capture_id"])
                assert row.archived_at is None
                assert layout.capture_dir(member["capture_id"]).is_dir()
            assert (
                client.get(f"/api/v1/datasets/{other['dataset_id']}").json()[
                    "member_count"
                ]
                == 1
            )

    def test_copy_sealed_membership_pins_nothing(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            dataset = _dataset(client, layout, members=1)
            dataset_id = dataset["dataset_id"]
            capture_id = client.get(f"/api/v1/datasets/{dataset_id}").json()[
                "members"
            ][0]["capture_id"]
            client.post(
                f"/api/v1/datasets/{dataset_id}/archive",
                json={"destination": str(roots / "exports"), "mode": "copy"},
            )
            _settle(client, dataset_id)

            # A copy-sealed dataset is a record, not a claim on the bytes: its
            # member may join a NEW dataset (the keep-working flow)…
            fresh = client.post("/api/v1/datasets", json={"name": "next"}).json()
            added = client.post(
                f"/api/v1/datasets/{fresh['dataset_id']}/members",
                json={"capture_id": capture_id},
            )
            assert added.status_code == 201, added.text
            client.delete(
                f"/api/v1/datasets/{fresh['dataset_id']}/members/"
                f"{added.json()['membership_id']}"
            )

            # …and may be deleted when the operator wants the disk back —
            # without the frozen member set becoming a permanent lock.
            deleted = client.post(
                f"/api/v1/captures/{capture_id}/delete",
                json={"kind": "delete"},
            )
            assert deleted.status_code == 200, deleted.text

    def test_a_copy_resume_believes_the_manifest_and_rebuilds_debris(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            store = client.app.state.capture_store
            dataset = _dataset(client, layout, members=2)
            dataset_id = dataset["dataset_id"]
            members = client.get(f"/api/v1/datasets/{dataset_id}").json()["members"]
            target = _dataset_dir(roots)
            assert store.begin_dataset_archive(
                dataset_id, destination=str(target), mode="copy"
            )
            ledger_v2.append(
                layout.data_dir,
                "dataset_archive_started",
                instance_id=client.app.state.instance_id,
                payload={
                    "dataset_id": dataset_id,
                    "destination": str(target),
                    "dataset_name": "ds",
                    "mode": "copy",
                    "members": [
                        {
                            "membership_id": m["membership_id"],
                            "capture_id": m["capture_id"],
                            "display_index": m["display_index"],
                        }
                        for m in members
                    ],
                },
            )
            # Member 1 finished in a previous run: its manifest entry and its
            # directory exist. The fake hash proves a resume does not re-copy
            # (a re-copy would overwrite it with the real one).
            (target / "001").mkdir(parents=True)
            (target / "001" / "bag_0.mcap").write_bytes(b"already copied")
            fake_files = [{"path": "bag_0.mcap", "size": 14, "sha256": "f" * 64}]
            (target / MANIFEST_NAME).write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "mode": "copy",
                        "status": "archiving",
                        "members": [
                            {
                                "dir": "001",
                                "capture_id": members[0]["capture_id"],
                                "files": fake_files,
                                "bytes": 14,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            # Member 2 is debris: bytes at the target, no manifest entry. In
            # copy mode the source is by definition still here, so debris is
            # always rebuilt — there is no bytes-lost state to halt on.
            (target / "002").mkdir(parents=True)
            (target / "002" / "bag_0.mcap").write_bytes(b"half a copy")

            response = client.post(
                f"/api/v1/datasets/{dataset_id}/archive", json={}
            )
            assert response.status_code == 202, response.text
            _settle(client, dataset_id)

            progress = client.get(f"/api/v1/datasets/{dataset_id}/archive").json()
            assert progress["status"] == "archived"
            assert progress["mode"] == "copy"
            manifest = json.loads((target / MANIFEST_NAME).read_bytes())
            entries = {m["dir"]: m for m in manifest["members"]}
            assert entries["001"]["files"] == fake_files  # believed, not redone
            assert (target / "001" / "bag_0.mcap").read_bytes() == b"already copied"
            assert entries["002"]["files"]  # rebuilt from the living source
            copied = (target / "002" / "bag_0.mcap").read_bytes()
            assert copied.startswith(b"\x89MCAP0")

    def test_a_resume_cannot_switch_modes(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            store = client.app.state.capture_store
            dataset = _dataset(client, layout, members=1)
            store.begin_dataset_archive(
                dataset["dataset_id"],
                destination=str(_dataset_dir(roots)),
                mode="copy",
            )

            response = client.post(
                f"/api/v1/datasets/{dataset['dataset_id']}/archive",
                json={"mode": "move"},
            )
            assert response.status_code == 409
            assert response.json()["error"]["code"] == "archive_mode_mismatch"

    def test_a_copy_seal_survives_a_rebuild_with_its_mode(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            dataset = _dataset(client, layout, members=1)
            dataset_id = dataset["dataset_id"]
            client.post(
                f"/api/v1/datasets/{dataset_id}/archive",
                json={"destination": str(roots / "exports"), "mode": "copy"},
            )
            _settle(client, dataset_id)
        # The client context closed the app; reopen on a fresh database.
        settings = Settings(
            data_dir=str(data_dir),
            archive_roots=str(roots),
            recording_config="/nonexistent/recording.yaml",
            stream_config="/nonexistent/stream.yaml",
        )
        (data_dir / "kairos.db").unlink()
        app = create_orchestrator_app(
            settings,
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(fake_recorder.handler)
            ),
        )
        with TestClient(app) as restarted:
            detail = restarted.get(f"/api/v1/datasets/{dataset_id}").json()
            # Mode is part of the record: without it, a rebuilt catalog could
            # not say whether the recordings were kept or removed.
            assert detail["status"] == "archived"
            assert detail["archive_mode"] == "copy"
