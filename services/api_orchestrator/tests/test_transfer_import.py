"""Bringing bytes in: bag import, arrival adoption, and the auto-pull (§10.6).

Everything arriving from outside lands in ``.incoming/<capture_id>`` and is
moved into ``objects/`` with one ``os.replace``. That single instant is when a
capture becomes real (§2), and the awkward case it has to survive is a split
deployment where the review — and therefore ``record.json`` — exists *before*
the bytes do.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
import yaml
from api_orchestrator import bag_import
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState
from api_orchestrator.transfer import ArrivalConflictError, adopt_incoming
from conftest import reconcile, run_digests
from fastapi.testclient import TestClient
from kairos_common.capture_sidecars import (
    ObjectManifestV2,
    RecordV2,
    read_object_manifest,
    read_record,
    write_object_manifest,
    write_record,
)
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import ReplicaState
from mcap.writer import Writer


def _make_bag(path: Path, *, topic: str = "/joint_states", count: int = 3) -> None:
    """A minimal but genuinely readable rosbag2/MCAP directory."""
    path.mkdir(parents=True, exist_ok=True)
    with (path / "bag_0.mcap").open("wb") as handle:
        writer = Writer(handle)
        writer.start()
        schema = writer.register_schema(
            name="sensor_msgs/msg/JointState", encoding="ros2msg", data=b"x"
        )
        channel = writer.register_channel(
            topic=topic, message_encoding="cdr", schema_id=schema
        )
        for index in range(count):
            writer.add_message(
                channel_id=channel,
                log_time=index * 1_000_000,
                publish_time=index * 1_000_000,
                data=b"\x00",
            )
        writer.finish()
    (path / "metadata.yaml").write_text(
        yaml.safe_dump(
            {
                "rosbag2_bagfile_information": {
                    "version": 9,
                    "message_count": count,
                    "starting_time": {
                        "nanoseconds_since_epoch": 1_754_000_000_000_000_000
                    },
                    "duration": {"nanoseconds": 3_000_000},
                    "topics_with_message_count": [
                        {
                            "topic_metadata": {
                                "name": topic,
                                "type": "sensor_msgs/msg/JointState",
                            },
                            "message_count": count,
                        }
                    ],
                }
            }
        ),
        encoding="utf-8",
    )


def _await_import(client: TestClient, import_id: str) -> dict:
    """Poll until the background copy finishes.

    The import runs as a task on the app's own loop, which only advances while a
    request is in flight — so polling IS the wait, and a sleep here would block
    the very loop it is waiting on.
    """
    for _ in range(200):
        status = client.get(f"/api/v1/imports/{import_id}").json()
        if status["state"] != "running":
            return status
    return status


class TestBagImport:
    def test_an_imported_bag_becomes_a_capture(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        source = tmp_path / "external_bag"
        _make_bag(source)

        queued = client.post(
            "/api/v1/imports", json={"source_path": str(source)}
        ).json()
        capture_id = queued["capture_id"]
        # §1: the orchestrator mints the id at claim time for an imported bag,
        # so every later step names one identity.
        assert queued["run_id"].startswith("imported_")

        status = _await_import(client, queued["import_id"])
        assert status["state"] == "succeeded", status

        body = client.get(f"/api/v1/captures/{capture_id}").json()
        assert body["state"] == "completed"
        # The two things an external bag cannot tell us are left null rather
        # than invented — a fabricated attribution on training data is worse
        # than a blank the operator fills in from Review.
        assert body["operator"] is None
        assert body["task"] is None
        assert body["manifest"]["imported_from"] == str(source)
        assert body["replica"]["state"] == ReplicaState.present_unverified

    def test_the_source_is_untouched_by_default(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        source = tmp_path / "external_bag"
        _make_bag(source)
        client.post("/api/v1/imports", json={"source_path": str(source)})
        # The operator's data belongs to them; move is opt-in.
        assert (source / "bag_0.mcap").is_file()

    def test_a_bag_without_metadata_is_rejected_with_a_remedy(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        source = tmp_path / "no_metadata"
        _make_bag(source)
        (source / "metadata.yaml").unlink()

        response = client.post("/api/v1/imports", json={"source_path": str(source)})
        assert response.status_code == 400
        error = response.json()["error"]
        assert error["code"] == "import_no_metadata"
        # A rejection that does not say what to do is a shrug.
        assert "reindex" in error["details"]["remedy"]

    def test_importing_from_inside_the_data_dir_is_refused(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        source = layout.objects / "something"
        _make_bag(source)
        response = client.post("/api/v1/imports", json={"source_path": str(source)})
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "import_source_inside_data_dir"

    def test_a_failed_import_leaves_nothing_staged(
        self, client: TestClient, layout: DataLayout, tmp_path: Path, monkeypatch
    ) -> None:
        source = tmp_path / "external_bag"
        _make_bag(source)
        monkeypatch.setattr(
            "api_orchestrator.bag_import.copy_into_staging",
            lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")),
        )
        queued = client.post(
            "/api/v1/imports", json={"source_path": str(source)}
        ).json()

        status = _await_import(client, queued["import_id"])
        assert status["state"] == "failed"
        # A caller polling until "failed" is entitled to find nothing
        # half-imported at that moment.
        assert not layout.incoming_dir(queued["capture_id"]).exists()
        assert not layout.capture_dir(queued["capture_id"]).exists()
        assert client.get(f"/api/v1/captures/{queued['capture_id']}").status_code == 404


class TestArrival:
    def test_a_staged_capture_moves_into_objects_atomically(
        self, layout: DataLayout, instance_id: str
    ) -> None:
        capture_id = new_capture_id()
        staging = layout.incoming_dir(capture_id)
        staging.mkdir(parents=True)
        (staging / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
        write_object_manifest(
            staging,
            ObjectManifestV2(
                capture_id=capture_id,
                source_instance_id=instance_id,
                run_id="run_pulled",
                state="completed",
                started_at="2026-08-01T00:00:00.000Z",
            ),
        )

        final = adopt_incoming(layout, capture_id)
        assert final == layout.capture_dir(capture_id)
        assert (final / "metadata.yaml").is_file()
        assert not staging.exists()

    def test_a_review_written_before_the_bytes_arrived_survives(
        self, layout: DataLayout, instance_id: str
    ) -> None:
        capture_id = new_capture_id()
        # A split deployment reviews on the recording PC first — the auto-pull
        # is triggered BY that save — so objects/<id> may already hold a
        # record.json and nothing else when the transfer lands.
        write_record(
            layout.capture_dir(capture_id),
            RecordV2(capture_id=capture_id, revision=2, review_status="adopted"),
        )
        staging = layout.incoming_dir(capture_id)
        staging.mkdir(parents=True)
        (staging / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")

        adopt_incoming(layout, capture_id)

        record = read_record(layout.capture_dir(capture_id))
        # os.replace refuses a non-empty destination, and clearing it would
        # destroy the review — so the sidecar is folded into staging first.
        assert record.record is not None
        assert record.record.revision == 2
        assert record.record.review_status == "adopted"
        assert (layout.capture_dir(capture_id) / "metadata.yaml").is_file()

    def test_an_arrival_onto_a_real_capture_is_refused(
        self, layout: DataLayout, instance_id: str
    ) -> None:
        capture_id = new_capture_id()
        existing = layout.capture_dir(capture_id)
        existing.mkdir(parents=True)
        (existing / "bag_0.mcap").write_bytes(b"already here")
        staging = layout.incoming_dir(capture_id)
        staging.mkdir(parents=True)
        (staging / "bag_0.mcap").write_bytes(b"newcomer")

        with pytest.raises(ArrivalConflictError):
            adopt_incoming(layout, capture_id)
        # Overwriting would replace bytes somebody already has with bytes we
        # have not compared against them.
        assert (existing / "bag_0.mcap").read_bytes() == b"already here"

    def test_the_reconciler_adopts_an_arrival_that_left_no_row(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = new_capture_id()
        staging = layout.incoming_dir(capture_id)
        staging.mkdir(parents=True)
        (staging / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
        write_object_manifest(
            staging,
            ObjectManifestV2(
                capture_id=capture_id,
                source_instance_id=client.app.state.instance_id,
                run_id="run_pulled",
                state="completed",
                started_at="2026-08-01T00:00:00.000Z",
                operator="alice",
            ),
        )
        adopt_incoming(layout, capture_id)

        # §10.6: the importer moves bytes and does not write rows; the orphan
        # adoption pass is what makes the arrival visible.
        assert client.get(f"/api/v1/captures/{capture_id}").status_code == 404
        reconcile(client)
        adopted = client.get(f"/api/v1/captures/{capture_id}").json()
        assert adopted["operator"] == "alice"


class TestTransferApi:
    def test_pull_is_keyed_by_capture_id(
        self, client: TestClient, fake_importer
    ) -> None:
        fake_importer.present = True
        capture_id = new_capture_id()
        response = client.post("/api/v1/transfer/pull", json={"capture_id": capture_id})
        assert response.status_code == 202
        assert response.json()["capture_id"] == capture_id
        # §10.6 rekeys the whole transfer path: run_id is a display name and
        # cannot address a capture across hosts.
        assert fake_importer.pulled == [capture_id]

    def test_a_pull_of_everything_is_the_explicit_all_form(
        self, client: TestClient, fake_importer
    ) -> None:
        # The importer 400s an empty body by design (a lost key must never
        # degrade a targeted pull into a sweep), so "pull everything" has to
        # travel as the explicit {"all": true} opt-in. The fake mirrors that
        # strictness — this test fails against a client that still sends {}.
        fake_importer.present = True
        response = client.post("/api/v1/transfer/pull", json={})
        assert response.status_code == 202
        assert fake_importer.pull_bodies == [{"all": True}]

    def test_an_absent_importer_reports_the_channel_as_unavailable(
        self, client: TestClient
    ) -> None:
        body = client.get("/api/v1/transfer/status").json()
        # A single-host deploy has no importer container, and `available` is the
        # frontend's split-mode signal — reporting true here would offer a
        # transfer control that can only fail.
        assert body["available"] is False
        assert body["auto_pull_on_save"] is False

    def test_a_present_importer_reports_the_channel_as_available(
        self, client: TestClient, fake_importer
    ) -> None:
        fake_importer.present = True
        assert client.get("/api/v1/transfer/status").json()["available"] is True


def _staged(layout: DataLayout, capture_id: str, instance_id: str) -> None:
    """A fully-transferred capture sitting in .incoming, as rsync leaves it."""
    staging = layout.incoming_dir(capture_id)
    staging.mkdir(parents=True, exist_ok=True)
    (staging / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
    (staging / f"{capture_id}_0.mcap").write_bytes(b"\x89MCAP0\r\n")
    write_object_manifest(
        staging,
        ObjectManifestV2(
            capture_id=capture_id,
            source_instance_id=instance_id,
            run_id="run_pulled",
            state="completed",
            started_at="2026-08-01T00:00:00.000Z",
            operator="alice",
            task="pick",
        ),
    )


class TestRecordMergeByRevision:
    """§4.1-4: the higher REVISION wins, not whichever side we stand on (M2)."""

    def _local_review(self, layout: DataLayout, capture_id: str, revision: int) -> None:
        write_record(
            layout.capture_dir(capture_id),
            RecordV2(
                capture_id=capture_id,
                revision=revision,
                review_status="adopted",
                quality="good",
            ),
        )

    def _staged_review(
        self, layout: DataLayout, capture_id: str, revision: int
    ) -> None:
        write_record(
            layout.incoming_dir(capture_id),
            RecordV2(
                capture_id=capture_id,
                revision=revision,
                review_status="excluded",
                quality="not_usable",
            ),
        )

    def test_a_lower_staged_revision_does_not_clobber_the_local_one(
        self, layout: DataLayout, instance_id: str
    ) -> None:
        capture_id = new_capture_id()
        _staged(layout, capture_id, instance_id)
        self._local_review(layout, capture_id, revision=3)
        self._staged_review(layout, capture_id, revision=1)

        adopt_incoming(layout, capture_id)

        record = read_record(layout.capture_dir(capture_id)).record
        # The operator edited here three times; a transfer carrying an older
        # review must not silently undo that.
        assert record.revision == 3
        assert record.review_status == "adopted"

    def test_a_higher_staged_revision_wins(
        self, layout: DataLayout, instance_id: str
    ) -> None:
        capture_id = new_capture_id()
        _staged(layout, capture_id, instance_id)
        self._local_review(layout, capture_id, revision=1)
        self._staged_review(layout, capture_id, revision=4)

        adopt_incoming(layout, capture_id)

        record = read_record(layout.capture_dir(capture_id)).record
        assert record.revision == 4
        assert record.review_status == "excluded"

    def test_equal_revisions_with_different_content_keep_the_local_copy(
        self, layout: DataLayout, instance_id: str, caplog
    ) -> None:
        capture_id = new_capture_id()
        _staged(layout, capture_id, instance_id)
        self._local_review(layout, capture_id, revision=2)
        self._staged_review(layout, capture_id, revision=2)

        with caplog.at_level("WARNING"):
            adopt_incoming(layout, capture_id)

        record = read_record(layout.capture_dir(capture_id)).record
        assert record.review_status == "adopted"
        # A genuine divergence is a fact worth surfacing, not a silent pick.
        assert "share revision 2" in caplog.text

    def test_a_local_review_with_no_staged_one_survives(
        self, layout: DataLayout, instance_id: str
    ) -> None:
        capture_id = new_capture_id()
        _staged(layout, capture_id, instance_id)
        self._local_review(layout, capture_id, revision=2)
        # The split-deploy flow: reviewed here, then the bytes arrive carrying
        # no review of their own.
        adopt_incoming(layout, capture_id)
        assert read_record(layout.capture_dir(capture_id)).record.revision == 2

    def test_a_corrupt_local_review_does_not_beat_a_readable_one(
        self, layout: DataLayout, instance_id: str
    ) -> None:
        capture_id = new_capture_id()
        _staged(layout, capture_id, instance_id)
        layout.capture_dir(capture_id).mkdir(parents=True, exist_ok=True)
        (layout.capture_dir(capture_id) / "record.json").write_text("{ broken")
        self._staged_review(layout, capture_id, revision=1)

        adopt_incoming(layout, capture_id)
        record = read_record(layout.capture_dir(capture_id)).record
        assert record is not None and record.revision == 1


class TestPullToAdopt:
    """The landing half of §10.6, end to end from a staged transfer."""

    def test_the_reconciler_publishes_a_staged_capture_and_files_it(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = new_capture_id()
        _staged(layout, capture_id, client.app.state.instance_id)

        # Nothing is visible until the capture leaves staging (§2's invariant).
        assert client.get(f"/api/v1/captures/{capture_id}").status_code == 404

        result = reconcile(client)
        assert result.arrived == (capture_id,)

        body = client.get(f"/api/v1/captures/{capture_id}").json()
        # One pass: published AND catalogued, not published now and catalogued
        # two minutes later.
        assert body["operator"] == "alice"
        assert body["replica"]["state"] == ReplicaState.present_unverified
        assert (layout.capture_dir(capture_id) / "metadata.yaml").is_file()
        assert not layout.incoming_dir(capture_id).exists()

    def test_an_incomplete_staging_dir_is_left_alone(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = new_capture_id()
        staging = layout.incoming_dir(capture_id)
        staging.mkdir(parents=True)
        (staging / f"{capture_id}_0.mcap").write_bytes(b"half a bag")

        result = reconcile(client)
        # A transfer still in flight: publishing it would put an incomplete
        # directory under objects/, which §2 reserves for live recordings.
        assert result.arrived == ()
        assert staging.is_dir()
        assert not layout.capture_dir(capture_id).exists()

    def test_a_staged_capture_that_is_not_terminal_is_left_alone(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = new_capture_id()
        _staged(layout, capture_id, client.app.state.instance_id)
        write_object_manifest(
            layout.incoming_dir(capture_id),
            ObjectManifestV2(
                capture_id=capture_id,
                source_instance_id=client.app.state.instance_id,
                run_id="run_pulled",
                state="recording",
                started_at="2026-08-01T00:00:00.000Z",
            ),
        )
        assert reconcile(client).arrived == ()
        assert not layout.capture_dir(capture_id).exists()

    def test_a_review_saved_before_the_pull_survives_the_landing(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = new_capture_id()
        store.create_capture(
            Capture(
                capture_id=capture_id,
                run_id=f"run_{capture_id}",
                state=CaptureState.completed,
                started_at="2026-08-01T00:00:00.000Z",
            )
        )
        # Reviewed on the recording PC first — that save is what triggers the
        # auto-pull, so it necessarily precedes the bytes.
        client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 0, "review_status": "adopted"},
        )
        _staged(layout, capture_id, client.app.state.instance_id)

        assert reconcile(client).arrived == (capture_id,)

        body = client.get(f"/api/v1/captures/{capture_id}").json()
        assert body["review_status"] == "adopted"
        assert body["record"]["revision"] == 1
        assert (layout.capture_dir(capture_id) / "metadata.yaml").is_file()


class TestScanFolder:
    """The folder scan: look before you copy, and never crawl forever."""

    def test_it_scans_one_level_and_ignores_unrelated_folders(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        # ONE level by decision (2026-08-05): the bags directly inside the
        # named folder. A deeper tree is imported by naming the subfolder.
        _make_bag(tmp_path / "bag_a")
        _make_bag(tmp_path / "bag_b")
        _make_bag(tmp_path / "2026-08-04" / "session1")  # nested: not listed
        (tmp_path / "notes").mkdir()
        (tmp_path / "notes" / "readme.txt").write_text("not a bag", encoding="utf-8")

        body = client.get(f"/api/v1/imports/scan?path={tmp_path}").json()

        names = sorted(b["name"] for b in body["bags"])
        assert names == ["bag_a", "bag_b"]
        assert body["importable"] == 2
        # Depth is the policy, not a truncation — the flag stays clean.
        assert body["truncated"] is False
        # A folder that is not a bag is not a FAILED import: neither the plain
        # notes/ nor the date folder holding a nested bag may be reported as
        # broken, or the rows that really are broken get buried.
        assert all(b["name"] not in {"notes", "2026-08-04"} for b in body["bags"])

    def test_a_folder_holding_nested_bags_is_hinted_not_silently_empty(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        # The dead end this closes: point at incoming/, get an empty list, and
        # be unable to tell "this folder is empty" from "your bags are one step
        # further down". The list stays one level deep; the hint is the way in.
        _make_bag(tmp_path / "2026-08-04" / "session1")
        _make_bag(tmp_path / "2026-08-04" / "session2")
        (tmp_path / "notes").mkdir()  # holds nothing: must NOT be hinted

        body = client.get(f"/api/v1/imports/scan?path={tmp_path}").json()

        assert body["bags"] == []
        assert [(n["name"], n["bags"]) for n in body["nested"]] == [("2026-08-04", 2)]

    def test_a_nested_bag_is_found_by_naming_its_parent(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        _make_bag(tmp_path / "2026-08-04" / "session1")
        body = client.get(f"/api/v1/imports/scan?path={tmp_path / '2026-08-04'}").json()
        assert [b["name"] for b in body["bags"]] == ["session1"]
        assert body["importable"] == 1

    def test_a_rejected_bag_is_reported_with_its_remedy(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        _make_bag(tmp_path / "good")
        broken = tmp_path / "broken"
        broken.mkdir()
        (broken / "x.mcap").write_bytes(b"not really an mcap")

        body = client.get(f"/api/v1/imports/scan?path={tmp_path}").json()

        rows = {b["name"]: b for b in body["bags"]}
        assert rows["good"]["importable"] is True
        # Reported, never silently skipped: the operator must know the folder
        # held something that will not come in.
        assert rows["broken"]["importable"] is False
        assert rows["broken"]["reason"]

    def test_the_store_is_never_scanned_into(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        # objects/ can hold thousands of capture dirs, and importing from it is
        # refused anyway — the walk must not descend into kairos's own store.
        _make_bag(layout.objects / "some-capture")
        body = client.get(f"/api/v1/imports/scan?path={layout.data_dir}").json()
        assert all("objects" not in b["name"] for b in body["bags"])

    def test_a_single_bag_directory_scans_as_itself(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        source = tmp_path / "one_bag"
        _make_bag(source)
        body = client.get(f"/api/v1/imports/scan?path={source}").json()
        assert len(body["bags"]) == 1
        assert body["bags"][0]["importable"] is True

    def test_a_missing_folder_is_a_useful_400(self, client: TestClient) -> None:
        resp = client.get("/api/v1/imports/scan?path=/nope/not/here")
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "import_source_missing"


class TestImportMessyFolders:
    """Operator mistakes and messy real data — not attackers, just Tuesday."""

    def test_a_bag_whose_metadata_is_absurdly_large_is_rejected_not_slurped(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        # A half-finished copy or a concatenation accident. Parsing it would
        # spend memory proportional to somebody else's mistake, and the answer
        # would be garbage — so it is refused like any unreadable metadata.
        source = tmp_path / "huge_meta"
        _make_bag(source)
        (source / "metadata.yaml").write_text("a: " + "x" * (17 * 1024 * 1024))

        resp = client.post("/api/v1/imports", json={"source_path": str(source)})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] in {
            "import_unreadable_metadata",
            "import_no_metadata",
        }

    def test_a_source_that_vanished_after_the_scan_fails_that_bag_only(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        # The scan is a snapshot; between it and the import an operator can
        # move or delete the folder. That must be a clean per-bag 400, not a
        # crash that takes the bulk run with it.
        source = tmp_path / "gone"
        _make_bag(source)
        client.get(f"/api/v1/imports/scan?path={tmp_path}")
        shutil.rmtree(source)

        resp = client.post("/api/v1/imports", json={"source_path": str(source)})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "import_source_missing"

    def test_a_symlinked_subfolder_is_not_followed(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        # A folder symlinked to its own parent is how a scan finds a cycle;
        # one symlinked elsewhere is how it silently leaves the tree.
        _make_bag(tmp_path / "real_bag")
        (tmp_path / "loop").symlink_to(tmp_path)

        body = client.get(f"/api/v1/imports/scan?path={tmp_path}").json()
        assert [b["name"] for b in body["bags"]] == ["real_bag"]

    def test_an_empty_mcap_is_reported_not_imported(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        # `ros2 bag record` interrupted at the wrong instant leaves this.
        source = tmp_path / "empty_mcap"
        _make_bag(source)
        for mcap in source.glob("*.mcap"):
            mcap.write_bytes(b"")

        body = client.get(f"/api/v1/imports/scan?path={tmp_path}").json()
        row = next(b for b in body["bags"] if b["name"] == "empty_mcap")
        assert row["importable"] is False
        assert row["reason"]

    def test_a_unicode_named_bag_round_trips(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        # Operators name folders in their own language, with spaces.
        name = "収録 2026-08-05 🎥"
        _make_bag(tmp_path / name)
        body = client.get(f"/api/v1/imports/scan?path={tmp_path}").json()
        row = next(b for b in body["bags"] if b["name"] == name)
        assert row["importable"] is True
        assert (
            client.post(
                "/api/v1/imports", json={"source_path": row["path"]}
            ).status_code
            == 202
        )

    def test_importing_the_same_folder_twice_is_reported_on_the_next_scan(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        source = tmp_path / "once"
        _make_bag(source)
        started = client.post("/api/v1/imports", json={"source_path": str(source)})
        assert started.status_code == 202
        _await_import(client, started.json()["import_id"])

        # The second scan says so instead of quietly offering a duplicate that
        # nothing downstream could tell apart from the first.
        body = client.get(f"/api/v1/imports/scan?path={tmp_path}").json()
        row = next(b for b in body["bags"] if b["name"] == "once")
        assert row["importable"] is False
        assert row["reason_code"] == "already_imported"
        assert row["capture_id"]


class TestImportRacesFoundByReview:
    """Defects a second reviewer (codex) found in the import path."""

    def test_the_same_folder_cannot_be_imported_twice_at_once(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        # The scan's already_imported reads FINISHED manifests, so it cannot
        # see work in flight: a double click or a second browser would copy the
        # same bag twice under two capture ids, indistinguishable afterwards.
        source = tmp_path / "twice"
        _make_bag(source)
        first = client.post("/api/v1/imports", json={"source_path": str(source)})
        assert first.status_code == 202

        second = client.post("/api/v1/imports", json={"source_path": str(source)})
        assert second.status_code == 409
        assert second.json()["error"]["code"] == "import_already_running"

    def test_a_failure_after_finalize_does_not_claim_nothing_arrived(
        self, client: TestClient, layout: DataLayout, tmp_path: Path, monkeypatch
    ) -> None:
        # Past the rename the bag EXISTS. Reporting a bare "failed" while the
        # recording later shows up in Review (the reconciler adopts the
        # sidecar) is the lie; and the old cleanup deleted a staging path that
        # no longer existed, so it protected nothing.
        source = tmp_path / "post_finalize"
        _make_bag(source)

        def _boom(*args: object, **kwargs: object) -> None:
            raise RuntimeError("catalog write failed")

        monkeypatch.setattr(
            "api_orchestrator.routers.imports._create_capture_row", _boom
        )
        started = client.post("/api/v1/imports", json={"source_path": str(source)})
        status = _await_import(client, started.json()["import_id"])

        assert status["state"] == "failed"
        assert status["error"]["code"] == "import_catalog_pending"
        assert "in place" in status["error"]["message"]
        # The bytes were NOT thrown away to make the failure look tidy.
        assert (layout.objects / status["capture_id"]).is_dir()


# ---- E-15: a bag that is half-written, short a shard, or lying about itself --


def _add_shard(path: Path, index: int, *, content: bytes | None = None) -> Path:
    """A second/third MCAP beside bag_0, as a split recording produces."""
    shard = path / f"bag_{index}.mcap"
    if content is not None:
        shard.write_bytes(content)
        return shard
    with shard.open("wb") as handle:
        writer = Writer(handle)
        writer.start()
        schema = writer.register_schema(
            name="sensor_msgs/msg/JointState", encoding="ros2msg", data=b"x"
        )
        channel = writer.register_channel(
            topic="/joint_states", message_encoding="cdr", schema_id=schema
        )
        writer.add_message(channel_id=channel, log_time=1, publish_time=1, data=b"\x00")
        writer.finish()
    return shard


def _declare_files(path: Path, names: list[str]) -> None:
    """Write the ``files:`` inventory rosbag2 puts in metadata.yaml."""
    metadata = yaml.safe_load((path / "metadata.yaml").read_text(encoding="utf-8"))
    info = metadata["rosbag2_bagfile_information"]
    info["relative_file_paths"] = names
    info["files"] = [{"path": name} for name in names]
    (path / "metadata.yaml").write_text(yaml.safe_dump(metadata), encoding="utf-8")


class TestPartialBagsAreRefused:
    def test_a_later_shard_still_being_written_is_refused(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        """Only the FIRST mcap was ever opened, so a split recording whose last
        shard is still growing passed inspection and imported as a complete
        capture — the index saying one thing and the bytes another."""
        source = tmp_path / "session"
        _make_bag(source)
        _add_shard(source, 1, content=b"\x89MCAP0\r\n truncated mid-write")
        _declare_files(source, ["bag_0.mcap", "bag_1.mcap"])

        body = client.get(f"/api/v1/imports/scan?path={tmp_path}").json()

        row = {b["name"]: b for b in body["bags"]}["session"]
        assert row["importable"] is False
        assert "bag_1.mcap" in row["reason"]

    def test_a_shard_missing_from_the_middle_is_refused(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        """metadata.yaml declares the shards; a copy that dropped one leaves a
        bag whose own inventory disagrees with the directory. Importing it
        lands a capture whose message_count counts messages that are not
        there."""
        source = tmp_path / "session"
        _make_bag(source)
        _add_shard(source, 1)
        _add_shard(source, 2)
        _declare_files(source, ["bag_0.mcap", "bag_1.mcap", "bag_2.mcap"])
        (source / "bag_1.mcap").unlink()  # the interrupted copy

        body = client.get(f"/api/v1/imports/scan?path={tmp_path}").json()

        row = {b["name"]: b for b in body["bags"]}["session"]
        assert row["importable"] is False
        assert "bag_1.mcap" in row["reason"]

    def test_a_truncated_MIDDLE_shard_is_refused(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        """The one that defends checking every shard rather than the ends.

        First-and-last would catch a growing tail and the inventory check would
        catch a deletion, so bounding the loop looks free — and it is not: a
        shard damaged in the middle of the sequence passes both and imports a
        capture that is short exactly where nobody looked.
        """
        source = tmp_path / "session"
        _make_bag(source)
        _add_shard(source, 1, content=b"\x89MCAP0\r\n truncated in the middle")
        _add_shard(source, 2)
        _declare_files(source, ["bag_0.mcap", "bag_1.mcap", "bag_2.mcap"])

        body = client.get(f"/api/v1/imports/scan?path={tmp_path}").json()

        row = {b["name"]: b for b in body["bags"]}["session"]
        assert row["importable"] is False
        assert "bag_1.mcap" in row["reason"]

    def test_an_unindexed_shard_abandons_the_count_check_instead_of_refusing(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        """A shard with no statistics section reports UNKNOWN, not zero.

        This is the guard that keeps the count check from becoming a
        false-refusal generator: read "unknown" as "zero" and a perfectly whole
        bag with one unindexed shard is refused for holding fewer messages than
        it declares — a bag nobody can import and nothing wrong with it.
        Nothing else in the suite builds an unindexed MCAP, so this is the only
        place that distinction is exercised.
        """
        from mcap.writer import IndexType
        from mcap.writer import Writer as RawWriter

        source = tmp_path / "session"
        _make_bag(source, count=3)
        with (source / "bag_1.mcap").open("wb") as handle:
            writer = RawWriter(handle, index_types=IndexType.NONE, use_statistics=False)
            writer.start()
            schema = writer.register_schema(
                name="sensor_msgs/msg/JointState", encoding="ros2msg", data=b"x"
            )
            channel = writer.register_channel(
                topic="/joint_states", message_encoding="cdr", schema_id=schema
            )
            for index in range(5):
                writer.add_message(
                    channel_id=channel, log_time=index, publish_time=index, data=b"\x00"
                )
            writer.finish()
        # The bag really does hold 8; only 3 of them are countable.
        metadata = yaml.safe_load((source / "metadata.yaml").read_text())
        metadata["rosbag2_bagfile_information"]["message_count"] = 8
        (source / "metadata.yaml").write_text(
            yaml.safe_dump(metadata), encoding="utf-8"
        )

        body = client.get(f"/api/v1/imports/scan?path={tmp_path}").json()

        row = {b["name"]: b for b in body["bags"]}["session"]
        assert row["importable"] is True

    def test_a_declared_path_cannot_reach_outside_the_bag(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        """metadata.yaml is operator-editable input, so its paths are joined
        under the bag directory and nowhere else.

        The collapse to a basename is what enforces that. Without it the check
        would stat ``../../outside.mcap`` — and a bag could be declared whole
        on the strength of a file belonging to something else entirely.
        """
        outside = tmp_path / "outside.mcap"
        outside.write_bytes(b"not part of any bag")
        source = tmp_path / "session"
        _make_bag(source)
        _declare_files(source, ["bag_0.mcap", "../outside.mcap"])

        body = client.get(f"/api/v1/imports/scan?path={tmp_path}").json()

        row = {b["name"]: b for b in body["bags"]}["session"]
        # Looked for as `outside.mcap` INSIDE the bag, not found, refused.
        assert row["importable"] is False
        assert "outside.mcap" in row["reason"]
        # And the real file it named is untouched.
        assert outside.read_bytes() == b"not part of any bag"

    def test_an_inventory_of_the_wrong_shape_is_damage_not_absence(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        """A malformed declaration must not read as 'declared nothing'.

        Absent inventories are common and harmless — there is nothing to check
        against. A field that is present and the wrong type is the opposite,
        and falling back to the absent branch turns a bag whose own manifest is
        broken into a bag that passed every check.
        """
        source = tmp_path / "session"
        _make_bag(source)
        metadata = yaml.safe_load((source / "metadata.yaml").read_text())
        # A string where a list belongs — one stray edit away from valid.
        metadata["rosbag2_bagfile_information"]["relative_file_paths"] = "bag_0.mcap"
        (source / "metadata.yaml").write_text(
            yaml.safe_dump(metadata), encoding="utf-8"
        )

        body = client.get(f"/api/v1/imports/scan?path={tmp_path}").json()

        row = {b["name"]: b for b in body["bags"]}["session"]
        assert row["importable"] is False
        assert "reindex" in row["reason"]

    def test_a_bag_holding_fewer_messages_than_it_declares_is_refused(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        """The missing-shard harm, with every file present.

        message_count is copied into the catalog from metadata.yaml, so a bag
        that declares far more than its MCAPs contain lands an episode whose
        count nothing on disk supports — the same 'looks complete' failure the
        shard checks exist to stop.
        """
        source = tmp_path / "session"
        _make_bag(source, count=3)
        metadata = yaml.safe_load((source / "metadata.yaml").read_text())
        metadata["rosbag2_bagfile_information"]["message_count"] = 999_999
        (source / "metadata.yaml").write_text(
            yaml.safe_dump(metadata), encoding="utf-8"
        )

        body = client.get(f"/api/v1/imports/scan?path={tmp_path}").json()

        row = {b["name"]: b for b in body["bags"]}["session"]
        assert row["importable"] is False
        assert "999999" in row["reason"].replace(",", "")


class TestMoveLeavesTheOperatorsOwnFilesAlone:
    """E-16: ``move`` means "this bag now lives in kairos", not "erase this
    directory". The boundary is drawn around the BAG, and these are what keep
    it there — the code says so in comments, which no refactor has to read.
    """

    def test_a_neighbouring_folder_survives_and_keeps_the_directory(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        source = tmp_path / "session"
        _make_bag(source)
        (source / "notes").mkdir()
        (source / "notes" / "calibration.md").write_text("mine", encoding="utf-8")

        started = client.post(
            "/api/v1/imports", json={"source_path": str(source), "move": True}
        ).json()
        _await_import(client, started["import_id"])

        # The bag's files went; the operator's folder did not, and the
        # directory holding it therefore still exists. An rmtree here would
        # destroy data that was never imported and would then exist nowhere.
        assert not (source / "bag_0.mcap").exists()
        assert (source / "notes" / "calibration.md").read_text() == "mine"
        assert source.is_dir()

    def test_a_file_dropped_during_the_copy_is_not_deleted(
        self, client: TestClient, tmp_path: Path, monkeypatch
    ) -> None:
        """``move`` deletes the exact set that was copied, not whatever a
        second ``iterdir()`` finds afterwards. A long copy is exactly when an
        operator drops something into the folder, and that file was never
        imported — deleting it would destroy the only copy."""
        source = tmp_path / "session"
        _make_bag(source)
        real_copy = bag_import.copy_into_staging

        def copy_then_drop(bag, staging):
            written = real_copy(bag, staging)
            (source / "late_note.txt").write_text("dropped mid-copy", encoding="utf-8")
            return written

        monkeypatch.setattr(bag_import, "copy_into_staging", copy_then_drop)

        started = client.post(
            "/api/v1/imports", json={"source_path": str(source), "move": True}
        ).json()
        _await_import(client, started["import_id"])

        assert not (source / "bag_0.mcap").exists()
        assert (source / "late_note.txt").read_text() == "dropped mid-copy"

    def test_a_file_beside_the_bag_travels_INTO_the_capture_and_is_tracked(
        self, client: TestClient, tmp_path: Path, layout: DataLayout
    ) -> None:
        """The other half of the boundary, stated so it is a decision rather
        than an accident: a top-level file IS taken, and it is tracked once it
        arrives — hashed into the manifest like everything else, so it can be
        found and verified rather than sitting in the capture untracked."""
        source = tmp_path / "session"
        _make_bag(source)
        (source / "calibration.yaml").write_text("k: 1\n", encoding="utf-8")

        started = client.post(
            "/api/v1/imports", json={"source_path": str(source), "move": True}
        ).json()
        record = _await_import(client, started["import_id"])
        capture_id = record["capture_id"]

        landed = layout.capture_dir(capture_id) / "calibration.yaml"
        assert landed.read_text() == "k: 1\n"
        run_digests(client)
        manifest = read_object_manifest(layout.capture_dir(capture_id)).manifest
        assert "calibration.yaml" in {f.path for f in manifest.files}
