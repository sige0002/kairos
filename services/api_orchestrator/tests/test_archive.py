"""Archiving a capture (§6): copy, verify, record, then delete the source.

Archiving is the one operation that both writes bytes somewhere new and destroys
the originals, so the order is not negotiable: the copy is verified before the
ledger event, and the source is removed only after the event is durable. The
event carries enough to reconstruct the row (rev.2.1) because after this runs
there is nothing else left that describes the capture.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import httpx
import pytest
from api_orchestrator import fileops
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import ApiError, Settings, ledger_v2
from kairos_common.capture_sidecars import RecordV2, write_record
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


def _seed(
    client: TestClient,
    layout: DataLayout,
    *,
    capture_id: str | None = None,
    task: str | None = "pick",
) -> str:
    store = client.app.state.capture_store
    capture_id = capture_id or new_capture_id()
    capture_dir = layout.capture_dir(capture_id)
    capture_dir.mkdir(parents=True)
    (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
    (capture_dir / "bag_0.mcap").write_bytes(b"\x89MCAP0\r\n" + b"payload" * 100)
    store.create_capture(
        Capture(
            capture_id=capture_id,
            run_id=f"run_{capture_id}",
            state=CaptureState.completed,
            operator="alice",
            task=task,
            message_count=42,
            bytes=707,
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


def _archive_and_wait(
    client: TestClient, capture_id: str, destination: Path, **extra: object
) -> dict:
    """POST the archive (accepted with a 202) and poll it to its terminal state.

    S2-1 made the copy a server-side background run; the tests keep asserting
    the same outcomes, they just wait for them the way a client now does. The
    wait must happen INSIDE the TestClient context — closing it stops the app
    loop the run executes on.
    """
    response = client.post(
        f"/api/v1/captures/{capture_id}/archive",
        json={"destination": str(destination), **extra},
    )
    assert response.status_code == 202, response.text
    deadline = time.monotonic() + 10.0
    progress: dict = {}
    while time.monotonic() < deadline:
        progress = client.get(f"/api/v1/captures/{capture_id}/archive").json()
        if progress["state"] != "running":
            return progress
        time.sleep(0.01)
    raise AssertionError(f"archive never settled: {progress}")


class TestArchive:
    def test_archiving_copies_verifies_records_then_removes_the_source(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)

            destination = roots / "batch_a"
            progress = _archive_and_wait(
                client, capture_id, destination, operator="alice"
            )
            assert progress["state"] == "complete", progress
            body = progress["result"]
            # 2 copied files + the generated task.json projection.
            assert body["file_count"] == 3
            assert body["bytes"] > 0

            copied = destination / capture_id
            assert (copied / "metadata.yaml").is_file()
            assert (copied / "bag_0.mcap").is_file()
            assert (copied / "task.json").is_file()
            # The source goes through the same trash pathway as any deletion,
            # so an archive interrupted at the last step recovers identically.
            assert not layout.capture_dir(capture_id).exists()

            capture = client.app.state.capture_store.get_capture(capture_id)
            assert capture.archive_destination == str(copied)
            assert capture.archived_at is not None

    def test_the_event_carries_enough_to_rebuild_the_row(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)
            _archive_and_wait(client, capture_id, roots)

        events = ledger_v2.archive_events(data_dir)
        event = events[capture_id]
        # rev.2.1: archiving deletes the local copy, so this event is the ONLY
        # surviving description of the capture. A rebuild after the database is
        # lost has nothing else to reconstruct the row from.
        assert event["operator"] == "alice"
        assert event["task"] == "pick"
        assert event["bytes"] == 707
        assert event["message_count"] == 42
        assert event["run_id"].startswith("run_")

    def test_a_destination_outside_the_allow_list_is_refused(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)
            response = client.post(
                f"/api/v1/captures/{capture_id}/archive",
                json={"destination": str(tmp_path / "elsewhere")},
            )
            # This endpoint deletes the source afterwards, which makes an
            # unconstrained destination "copy anywhere, then remove the
            # original".
            assert response.status_code == 400
            assert response.json()["error"]["code"] == "destination_not_allowed"
            assert layout.capture_dir(capture_id).exists()

    def test_archiving_is_not_offered_without_configured_roots(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _seed(client, layout)
        config = client.get(f"/api/v1/captures/{capture_id}/archive/config").json()
        # Better than a control that can only ever 400.
        assert config == {"enabled": False, "roots": []}

    def test_a_dataset_member_cannot_be_archived(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)
            dataset = client.post("/api/v1/datasets", json={"name": "ds"}).json()
            client.post(
                f"/api/v1/datasets/{dataset['dataset_id']}/members",
                json={"capture_id": capture_id},
            )
            response = client.post(
                f"/api/v1/captures/{capture_id}/archive",
                json={"destination": str(roots)},
            )
            # Archiving removes the local copy, which would leave the dataset
            # citing a capture whose bytes are somewhere the dataset cannot say.
            assert response.status_code == 400
            assert response.json()["error"]["code"] == "capture_in_dataset"

    def test_a_capture_with_no_local_copy_cannot_be_archived(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            store = client.app.state.capture_store
            capture_id = new_capture_id()
            store.create_capture(
                Capture(
                    capture_id=capture_id,
                    run_id="run_absent",
                    state=CaptureState.completed,
                    started_at="2026-08-01T00:00:00.000Z",
                )
            )
            response = client.post(
                f"/api/v1/captures/{capture_id}/archive",
                json={"destination": str(roots)},
            )
            assert response.status_code == 409
            assert response.json()["error"]["code"] == "capture_not_present"


class TestDatasetMemberArchive:
    """``archive_member`` (§6.x): the runner's dataset-scoped internal archive.

    No route reaches it. The one guard it relaxes is its own dataset's
    membership; everything else — including the §7 guard for every OTHER
    dataset — must behave exactly like the public archive.
    """

    def test_its_own_dataset_is_exempt_but_any_other_refuses(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            service = client.app.state.capture_service
            capture_id = _seed(client, layout)
            own = client.post("/api/v1/datasets", json={"name": "own"}).json()
            other = client.post("/api/v1/datasets", json={"name": "other"}).json()
            member = client.post(
                f"/api/v1/datasets/{own['dataset_id']}/members",
                json={"capture_id": capture_id},
            ).json()
            client.post(
                f"/api/v1/datasets/{other['dataset_id']}/members",
                json={"capture_id": capture_id},
            )

            with pytest.raises(ApiError) as excinfo:
                asyncio.run(
                    service.archive_member(
                        capture_id,
                        dataset_id=own["dataset_id"],
                        membership_id=member["membership_id"],
                        display_index=member["display_index"],
                        target=roots / "ds" / "001",
                    )
                )
            # The other dataset still cites these bytes; retiring "own" is no
            # licence to pull them out from under it.
            assert excinfo.value.code == "capture_in_dataset"
            assert layout.capture_dir(capture_id).is_dir()

    def test_a_member_archive_carries_its_dataset_identity(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            service = client.app.state.capture_service
            store = client.app.state.capture_store
            capture_id = _seed(client, layout)
            dataset = client.post("/api/v1/datasets", json={"name": "ds"}).json()
            member = client.post(
                f"/api/v1/datasets/{dataset['dataset_id']}/members",
                json={"capture_id": capture_id},
            ).json()
            target = roots / "ds" / "001"

            asyncio.run(
                service.archive_member(
                    capture_id,
                    dataset_id=dataset["dataset_id"],
                    membership_id=member["membership_id"],
                    display_index=member["display_index"],
                    target=target,
                )
            )

            # Same §9-1 order and effects as the public archive…
            assert (target / "bag_0.mcap").is_file()
            assert not layout.capture_dir(capture_id).exists()
            row = store.get_capture(capture_id)
            assert row.archived_at is not None
            assert row.archive_destination == str(target)
            # …plus the annotations that say which sealed dataset this
            # recording is NNN of, in the only record that survives the source.
            event = ledger_v2.archive_events(layout.data_dir)[capture_id]
            assert event["destination"] == str(target)
            assert event["dataset_id"] == dataset["dataset_id"]
            assert event["membership_id"] == member["membership_id"]
            assert event["display_index"] == member["display_index"]


class TestDestinationOverlap:
    """A destination that overlaps our own data is archive-that-deletes (A)."""

    def _archive_to(
        self, client: TestClient, capture_id: str, destination: Path
    ) -> httpx.Response:
        return client.post(
            f"/api/v1/captures/{capture_id}/archive",
            json={"destination": str(destination)},
        )

    def test_archiving_into_the_data_dir_is_refused(
        self, data_dir: Path, fake_recorder: FakeRecorder
    ) -> None:
        # The allow-list authorises writing here, and an operator setting
        # KAIROS_ARCHIVE_ROOTS=/data is doing something perfectly reasonable.
        # It is still the one destination that must not be used: the source
        # deletion afterwards would take the verified copy with it.
        with _archive_client(data_dir, data_dir, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)

            response = self._archive_to(client, capture_id, data_dir / "archive")
            assert response.status_code == 400
            assert response.json()["error"]["code"] == "destination_inside_data_dir"
            # Nothing was copied and nothing was deleted.
            assert layout.capture_dir(capture_id).is_dir()
            assert not (data_dir / "archive").exists()

    def test_archiving_a_capture_onto_itself_is_refused(
        self, data_dir: Path, fake_recorder: FakeRecorder
    ) -> None:
        with _archive_client(data_dir, data_dir, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)
            # destination/<capture_id> resolves to the capture's own directory.
            response = self._archive_to(client, capture_id, layout.objects)
            assert response.status_code == 400
            assert response.json()["error"]["code"] == "destination_inside_data_dir"
            assert (layout.capture_dir(capture_id) / "bag_0.mcap").is_file()

    def test_a_target_containing_the_data_dir_is_refused(
        self, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        """The same disaster from the other end: the target ENCLOSES data_dir.

        Contrived to construct — the data directory has to sit under a path
        named like a capture — but it is the direction a one-sided check
        misses, and the copy would land on top of the store itself.

        Note what is deliberately NOT refused: a destination *root* that merely
        contains data_dir. Archiving lands in ``<destination>/<capture_id>``, a
        sibling of the data directory, so nothing overlaps and the operator's
        layout is their business.
        """
        known = "01920000-0000-7000-8000-0000000000ff"
        root = tmp_path / "root"
        nested_data = root / known / "data"
        nested_data.mkdir(parents=True)

        with _archive_client(nested_data, root, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout, capture_id=known)
            # target == root/<known>, which contains data_dir.
            response = self._archive_to(client, capture_id, root)
            assert response.status_code == 400
            assert response.json()["error"]["code"] == "destination_inside_data_dir"
            assert layout.capture_dir(capture_id).is_dir()

    def test_a_symlink_cannot_disguise_the_overlap(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        # A path that LOOKS outside but resolves inside. Comparing the literal
        # strings would pass this; realpath on both sides is what catches it.
        disguise = tmp_path / "looks-external"
        disguise.symlink_to(data_dir)
        with _archive_client(data_dir, tmp_path, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)
            response = self._archive_to(client, capture_id, disguise / "archive")
            assert response.status_code == 400
            assert response.json()["error"]["code"] == "destination_inside_data_dir"
            assert layout.capture_dir(capture_id).is_dir()

    def test_a_genuinely_separate_destination_is_allowed(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)
            # The guard must not become a blanket refusal — the ordinary case
            # still has to work.
            progress = _archive_and_wait(client, capture_id, roots)
            assert progress["state"] == "complete", progress
            assert not layout.capture_dir(capture_id).exists()


class TestDestinationNotEmpty:
    def test_a_destination_holding_files_is_refused(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)
            # Debris from an earlier failed attempt.
            leftover = roots / capture_id
            leftover.mkdir(parents=True)
            (leftover / "bag_0.mcap").write_bytes(b"truncated remains")

            response = client.post(
                f"/api/v1/captures/{capture_id}/archive",
                json={"destination": str(roots)},
            )
            assert response.status_code == 409
            assert response.json()["error"]["code"] == "destination_not_empty"
            # Verification only ever inspects what THIS copy wrote, so debris
            # would ride along unexamined inside a "successful" archive.
            assert (leftover / "bag_0.mcap").read_bytes() == b"truncated remains"
            assert layout.capture_dir(capture_id).is_dir()

    def test_an_empty_destination_directory_is_fine(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)
            (roots / capture_id).mkdir(parents=True)  # pre-created, but empty

            progress = _archive_and_wait(client, capture_id, roots)
            assert progress["state"] == "complete", progress


class TestArchiveDigests:
    """The ledger alone must be able to audit the archive (C)."""

    def test_per_file_hashes_reach_the_ledger_and_the_response(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)
            progress = _archive_and_wait(client, capture_id, roots)
            assert progress["state"] == "complete", progress
            body = progress["result"]

        assert body["file_count"] == 3
        by_path = {entry["path"]: entry for entry in body["files"]}
        assert set(by_path) == {"metadata.yaml", "bag_0.mcap", "task.json"}

        event = ledger_v2.archive_events(data_dir)[capture_id]
        # Once the source is deleted the manifest goes with it. Without these
        # the event could say only "N bytes went to /mnt/nas", which cannot
        # answer "is the copy still intact?" years later.
        assert event["files"] == body["files"]

        # And the hashes are real: they match the bytes actually at the target.
        archived = roots / capture_id / "bag_0.mcap"
        expected, size = fileops.sha256_file(archived)
        assert by_path["bag_0.mcap"]["sha256"] == expected
        assert by_path["bag_0.mcap"]["size"] == size

    def test_the_digests_survive_into_a_rebuilt_catalog(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)
            _archive_and_wait(client, capture_id, roots)
        (data_dir / "kairos.db").unlink()

        with _archive_client(data_dir, roots, fake_recorder) as restarted:
            # The row comes back from the archive event alone (§8), and the
            # audit record it carries is still readable from the ledger.
            body = restarted.get(f"/api/v1/captures/{capture_id}").json()
            assert body["archive_destination"] == str(roots / capture_id)
        event = ledger_v2.archive_events(data_dir)[capture_id]
        assert len(event["files"]) == 3


class TestTaskSidecarProjection:
    """§6: the destination gains a rosbag2lerobot ``task.json`` projection.

    The archive is the boundary where the bytes stop being readable through
    kairos, so the task label travels with them in the converter's own format —
    and is audited like any copied file, because a self-describing tree whose
    description is unverifiable would be worse than none.
    """

    def test_the_destination_carries_the_task_label(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)
            progress = _archive_and_wait(client, capture_id, roots)
            assert progress["state"] == "complete", progress
            body = progress["result"]

        sidecar = roots / capture_id / "task.json"
        assert json.loads(sidecar.read_text(encoding="utf-8")) == {"task": "pick"}

        # Audited exactly like the copied bytes: the entry's digest matches
        # what is actually on the destination disk.
        by_path = {entry["path"]: entry for entry in body["files"]}
        digest, size = fileops.sha256_file(sidecar)
        assert by_path["task.json"] == {
            "path": "task.json",
            "size": size,
            "sha256": digest,
        }

    def test_a_capture_without_a_task_gets_no_sidecar(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        # Imported bags (§3.3) have no task; an empty sidecar would only make
        # the converter fall back anyway, so the file is omitted entirely.
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout, task=None)
            progress = _archive_and_wait(client, capture_id, roots)
            assert progress["state"] == "complete", progress
            body = progress["result"]

        assert not (roots / capture_id / "task.json").exists()
        assert body["file_count"] == 2

    def test_a_source_with_its_own_sidecar_keeps_it_verbatim(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        # An imported bag — including a re-imported archive — may already
        # carry a task.json, possibly with subtasks that exist nowhere else.
        # The projection must not overwrite it, and must not put a second
        # entry in the audit list whose hash matches nothing on disk.
        original = json.dumps(
            {
                "task": "from_the_bag",
                "subtasks": [{"start": 0.0, "end": 3.5, "subtask": "reach"}],
            }
        )
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout)
            (layout.capture_dir(capture_id) / "task.json").write_text(
                original, encoding="utf-8"
            )
            progress = _archive_and_wait(client, capture_id, roots)
            assert progress["state"] == "complete", progress
            body = progress["result"]

        copied = roots / capture_id / "task.json"
        assert copied.read_text(encoding="utf-8") == original

        entries = [e for e in body["files"] if e["path"] == "task.json"]
        digest, size = fileops.sha256_file(copied)
        assert entries == [{"path": "task.json", "size": size, "sha256": digest}]
        assert body["file_count"] == 3
        assert body["bytes"] == sum(e["size"] for e in body["files"])

    def test_the_label_comes_from_the_sidecars_not_the_row_cache(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        # The row can transiently lag a §4.3 edit (adopt_manifest_facts has no
        # record.json overlay). The projection reads the sidecars — the
        # store's source of truth — so the frozen file carries the edit.
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout, task="stale_row_value")
            capture_dir = layout.capture_dir(capture_id)
            (capture_dir / "object_manifest.json").write_text(
                json.dumps(
                    {
                        "schema_version": 2,
                        "capture_id": capture_id,
                        "source_instance_id": "inst",
                        "run_id": f"run_{capture_id}",
                        "state": "completed",
                        "started_at": "2026-08-01T00:00:00.000Z",
                        "task": "as_recorded",
                    }
                ),
                encoding="utf-8",
            )
            write_record(
                capture_dir,
                RecordV2(
                    capture_id=capture_id,
                    revision=1,
                    labels={"task": "edited_after_recording"},
                ),
            )
            progress = _archive_and_wait(client, capture_id, roots)
            assert progress["state"] == "complete", progress

        sidecar = roots / capture_id / "task.json"
        assert json.loads(sidecar.read_text(encoding="utf-8")) == {
            "task": "edited_after_recording"
        }
