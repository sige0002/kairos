# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""§4.3: editing a capture's operator, task and robot.

The case that forced this is the imported bag. It is born with no operator and
no task — nobody was there to record them — so the only way it can ever have
them is for a person to say so afterwards. Ordinary recordings get the same
edit, because "the operator field was wrong" is not a different problem.

The design turns on one distinction, which ``schema.REVIEW_COLUMNS`` now spells
out: a review may write a LABEL and may never write a MEASUREMENT. Bytes,
counters, topics and timestamps are what the recorder observed, and editing one
would make the catalog disagree with the sealed manifest that §8 rebuilds from —
the edit would silently revert. A label is a human's statement, and it survives
precisely because it is stored somewhere the rebuild reads.

**The manifest is never rewritten.** The override lives in ``record.json``'s
``labels`` block, which is what makes "this was edited" a durable fact rather
than an indistinguishable one, and what lets clearing an edit return the capture
to what was actually recorded.

The load-bearing test in this file is
``TestTheEditSurvivesARebuild::test_a_label_edit_outlives_the_database`` — the
whole design is only worth anything if the edit is still there after the index
is thrown away.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import Settings
from kairos_common.capture_sidecars import (
    RECORD_FILENAME,
    ObjectManifestV2,
    read_record,
    write_object_manifest,
)
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import ReplicaState


def _seed(
    client: TestClient,
    layout: DataLayout,
    *,
    operator: str | None = "alice",
    task: str | None = "pick",
    robot: str | None = "myrobot",
) -> str:
    """A completed capture whose manifest records the given labels.

    Written as a real sidecar rather than only a row: these tests are about the
    relationship between the manifest and ``record.json``, so the manifest has
    to actually be on disk.
    """
    capture_id = new_capture_id()
    capture_dir = layout.capture_dir(capture_id)
    capture_dir.mkdir(parents=True)
    (capture_dir / "bag_0.mcap").write_bytes(b"\x89MCAP0\r\n" + b"payload" * 10)
    write_object_manifest(
        capture_dir,
        ObjectManifestV2(
            capture_id=capture_id,
            source_instance_id=client.app.state.instance_id,
            run_id=f"run_{capture_id}",
            state="completed",
            started_at="2026-08-01T00:00:00.000Z",
            ended_at="2026-08-01T00:05:00.000Z",
            operator=operator,
            task=task,
            robot=robot,
        ),
    )
    store = client.app.state.capture_store
    store.create_capture(
        Capture(
            capture_id=capture_id,
            run_id=f"run_{capture_id}",
            state=CaptureState.completed,
            operator=operator,
            task=task,
            robot=robot,
            started_at="2026-08-01T00:00:00.000Z",
            ended_at="2026-08-01T00:05:00.000Z",
        )
    )
    store.upsert_replica(
        capture_id,
        client.app.state.instance_id,
        ReplicaState.present_unverified,
        path=str(capture_dir),
    )
    return capture_id


def _patch(client: TestClient, capture_id: str, **body: object) -> httpx.Response:
    return client.patch(f"/api/v1/captures/{capture_id}/review", json=body)


def _capture(client: TestClient, capture_id: str) -> dict:
    response = client.get(f"/api/v1/captures/{capture_id}")
    assert response.status_code == 200, response.text
    return response.json()


def _tree(data_dir: Path) -> list[str]:
    views = data_dir / "views"
    if not views.exists():
        return []
    return sorted(str(p.relative_to(views)) for p in views.rglob("*"))


def _record_on_disk(layout: DataLayout, capture_id: str) -> dict:
    path = layout.capture_dir(capture_id) / RECORD_FILENAME
    return json.loads(path.read_text(encoding="utf-8"))


class TestTheEditReachesTheRowAndTheSidecar:
    def test_all_three_labels_can_be_set(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _seed(client, layout)

        response = _patch(
            client,
            capture_id,
            base_revision=0,
            operator="bob",
            task="place",
            robot="otherbot",
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert (body["operator"], body["task"], body["robot"]) == (
            "bob",
            "place",
            "otherbot",
        )
        assert _capture(client, capture_id)["operator"] == "bob"

    def test_the_override_lands_in_record_json_and_not_in_the_manifest(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """The separation the whole design rests on."""
        capture_id = _seed(client, layout)

        _patch(client, capture_id, base_revision=0, operator="bob")

        assert _record_on_disk(layout, capture_id)["labels"] == {"operator": "bob"}
        manifest = json.loads(
            (layout.capture_dir(capture_id) / "object_manifest.json").read_text()
        )
        assert manifest["operator"] == "alice", (
            "the recorder's sealed account was rewritten; the manifest is the "
            "record of what was RECORDED and an edit must not be able to "
            "restate it"
        )

    def test_an_unset_label_is_absent_from_the_block_not_null(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        # One spelling of "not overridden" — otherwise a null and a missing key
        # would both have to be read as the same thing, forever.
        capture_id = _seed(client, layout)

        _patch(client, capture_id, base_revision=0, task="place")

        assert _record_on_disk(layout, capture_id)["labels"] == {"task": "place"}

    def test_a_capture_with_no_labels_writes_no_labels_block(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """An ordinary review is byte-identical to one written before §4.3."""
        capture_id = _seed(client, layout)

        _patch(client, capture_id, base_revision=0, review_status="adopted")

        assert "labels" not in _record_on_disk(layout, capture_id)

    def test_an_imported_bag_can_be_given_the_labels_it_was_born_without(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """The case the feature exists for."""
        capture_id = _seed(client, layout, operator=None, task=None, robot=None)
        assert _capture(client, capture_id)["operator"] is None

        response = _patch(
            client, capture_id, base_revision=0, operator="alice", task="pick"
        )

        assert response.status_code == 200, response.text
        assert response.json()["operator"] == "alice"
        assert response.json()["task"] == "pick"


class TestClearing:
    def test_null_returns_the_capture_to_what_the_recorder_recorded(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _seed(client, layout)
        _patch(client, capture_id, base_revision=0, operator="bob")

        cleared = _patch(client, capture_id, base_revision=1, operator=None)

        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["operator"] == "alice", (
            "clearing an override left the field empty instead of restoring the "
            "manifest's value; the edit is a correction of a recorded fact, so "
            "removing it must reveal that fact again"
        )
        assert "operator" not in _record_on_disk(layout, capture_id).get("labels", {})

    def test_clearing_on_an_imported_bag_leaves_null(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        # Nothing was recorded, so there is nothing to fall back to. Null is the
        # honest answer rather than a retained guess.
        capture_id = _seed(client, layout, operator=None, task=None, robot=None)
        _patch(client, capture_id, base_revision=0, operator="alice")

        cleared = _patch(client, capture_id, base_revision=1, operator=None)

        assert cleared.json()["operator"] is None

    def test_an_empty_string_clears_rather_than_storing_a_blank_label(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _seed(client, layout)
        _patch(client, capture_id, base_revision=0, operator="bob")

        cleared = _patch(client, capture_id, base_revision=1, operator="   ")

        assert cleared.json()["operator"] == "alice"
        assert "operator" not in _record_on_disk(layout, capture_id).get("labels", {})

    def test_an_unsupplied_label_keeps_its_override(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """A later review save must not quietly drop an earlier label edit."""
        capture_id = _seed(client, layout)
        _patch(client, capture_id, base_revision=0, operator="bob", task="place")

        _patch(client, capture_id, base_revision=1, review_status="adopted")

        assert _record_on_disk(layout, capture_id)["labels"] == {
            "operator": "bob",
            "task": "place",
        }
        assert _capture(client, capture_id)["operator"] == "bob"


class TestPathSafety:
    def test_a_separator_is_refused(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _seed(client, layout)

        for bad in ("a/b", "a\\b"):
            response = _patch(client, capture_id, base_revision=0, operator=bad)
            assert response.status_code == 400, response.text
            assert response.json()["error"]["code"] == "unsafe_label"

    def test_dot_names_are_refused(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        # ".." as a path component would climb out of views/ entirely.
        capture_id = _seed(client, layout)

        response = _patch(client, capture_id, base_revision=0, task="..")

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "unsafe_label"

    def test_a_control_character_is_refused(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _seed(client, layout)

        response = _patch(client, capture_id, base_revision=0, robot="a\nb")

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "unsafe_label"

    def test_an_over_long_label_is_refused(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _seed(client, layout)

        response = _patch(client, capture_id, base_revision=0, operator="ら" * 200)

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "label_too_long"

    def test_a_refused_label_changes_nothing(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _seed(client, layout)

        _patch(client, capture_id, base_revision=0, operator="a/b", task="place")

        after = _capture(client, capture_id)
        assert after["operator"] == "alice"
        assert after["task"] == "pick", (
            "the request was refused but its other fields were applied; a 400 "
            "must leave the capture exactly as it was"
        )
        assert after["review_revision"] == 0


class TestTheCompareAndSwapStillHolds:
    def test_a_stale_base_revision_is_refused(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _seed(client, layout)
        _patch(client, capture_id, base_revision=0, operator="bob")

        stale = _patch(client, capture_id, base_revision=0, operator="carol")

        assert stale.status_code == 409
        assert _capture(client, capture_id)["operator"] == "bob"

    def test_a_label_edit_advances_the_revision(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _seed(client, layout)

        response = _patch(client, capture_id, base_revision=0, robot="otherbot")

        assert response.json()["review_revision"] == 1


class TestTheEditSurvivesARebuild:
    def test_a_label_edit_outlives_the_database(
        self,
        settings: Settings,
        data_dir: Path,
        fake_recorder: FakeRecorder,
    ) -> None:
        """Delete kairos.db, restart, and the edit is still there.

        This is the test the whole design exists to pass. ``record.json`` is
        authoritative and the manifest is never rewritten, so the ONLY thing
        that can carry a label edit across a rebuild is ``labels`` being
        re-applied over the manifest's values — in that order. Reverse them and
        this test reports the recorder's original value.
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
            _patch(
                client, capture_id, base_revision=0, operator="bob", robot="otherbot"
            )
            assert _capture(client, capture_id)["operator"] == "bob"

        (data_dir / "kairos.db").unlink()

        with boot() as reopened:
            after = _capture(reopened, capture_id)

        assert after["operator"] == "bob", (
            "the label edit did not survive a rebuild: the catalog went back to "
            "the manifest's operator, so every edit is silently undone the "
            "first time somebody drops kairos.db"
        )
        assert after["robot"] == "otherbot"
        # Untouched fields still come from the manifest, which is what makes
        # this an overlay rather than a replacement.
        assert after["task"] == "pick"

    def test_a_cleared_label_stays_cleared_across_a_rebuild(
        self,
        settings: Settings,
        data_dir: Path,
        fake_recorder: FakeRecorder,
    ) -> None:
        """The other direction: absence must rebuild as absence, not as the edit."""

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
            _patch(client, capture_id, base_revision=0, operator="bob")
            _patch(client, capture_id, base_revision=1, operator=None)

        (data_dir / "kairos.db").unlink()

        with boot() as reopened:
            assert _capture(reopened, capture_id)["operator"] == "alice"


class TestALostRaceDoesNotDropAnOverride:
    """The restamp after a lost CAS has to carry the labels, or it erases them.

    When the database CAS loses, ``_restore_record_from_row`` rewrites
    ``record.json`` from the winning row so the file cannot disagree with the
    catalog. The row holds the EFFECTIVE label and cannot say on its own which
    values were edited — so a restamp that wrote no ``labels`` block would drop
    a real override, and §8 would revert the edit the next time somebody deleted
    ``kairos.db``. Silently, and long after the request that caused it.
    """

    def test_the_winners_override_survives_the_restamp(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        store = client.app.state.capture_store
        capture_id = _seed(client, layout)
        real_cas = store.save_review_cas

        def losing_cas(cid: str, **kwargs: object) -> bool:
            # The other terminal's save commits between our sidecar write and
            # our CAS — and ITS save is the label edit that must survive.
            store.save_review_cas = real_cas
            real_cas(cid, base_revision=0, fields={"operator": "carol"})
            return real_cas(cid, **kwargs)  # type: ignore[arg-type]

        store.save_review_cas = losing_cas  # type: ignore[method-assign]
        conflict = _patch(client, capture_id, base_revision=0, review_status="adopted")

        assert conflict.status_code == 409
        assert store.get_capture(capture_id).operator == "carol"
        assert _record_on_disk(layout, capture_id).get("labels") == {
            "operator": "carol"
        }, (
            "the restamp dropped the winner's label override; record.json now "
            "disagrees with the row, and a rebuild would put the manifest's "
            "operator back over a decision the database accepted"
        )

    def test_a_restamp_does_not_freeze_the_manifests_own_values_as_overrides(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """Only a real difference is an override.

        Writing all three back would turn the recorder's own values into
        "decisions", and a later correction to the manifest would then be
        shadowed by one nobody made.
        """
        store = client.app.state.capture_store
        capture_id = _seed(client, layout)
        real_cas = store.save_review_cas

        def losing_cas(cid: str, **kwargs: object) -> bool:
            store.save_review_cas = real_cas
            real_cas(cid, base_revision=0, fields={"review_status": "excluded"})
            return real_cas(cid, **kwargs)  # type: ignore[arg-type]

        store.save_review_cas = losing_cas  # type: ignore[method-assign]
        _patch(client, capture_id, base_revision=0, review_status="adopted")

        assert _record_on_disk(layout, capture_id).get("labels", {}) == {}


class TestTheBrowsableTreeFollowsTheEdit:
    """``views/`` groups by operator/task, and falls back to the CAPTURE's.

    ``list_view_entries`` selects ``COALESCE(d.operator, c.operator)``, so a
    dataset that names neither is filed under its members' labels. Editing one
    therefore moves a folder, and an edit that did not schedule a regeneration
    would leave the tree filed under the label the capture used to have — with
    nothing on either side to say the two had diverged.
    """

    def test_renaming_an_operator_moves_the_folder(
        self, client: TestClient, data_dir: Path, layout: DataLayout
    ) -> None:
        capture_id = _seed(client, layout)
        dataset = client.post("/api/v1/datasets", json={"name": "ds"}).json()
        client.post(
            f"/api/v1/datasets/{dataset['dataset_id']}/members",
            json={"capture_id": capture_id},
        )
        assert client.post("/api/v1/views/refresh").status_code == 200
        assert any(entry.startswith("alice") for entry in _tree(data_dir))

        _patch(client, capture_id, base_revision=0, operator="bob")
        # The regeneration the save scheduled runs in the background; asking for
        # one synchronously is how the assertion stops depending on timing. The
        # claim under test is that the tree AGREES with the row, not how quickly.
        assert client.post("/api/v1/views/refresh").status_code == 200

        tree = _tree(data_dir)
        assert any(entry.startswith("bob") for entry in tree), tree
        assert not any(entry.startswith("alice") for entry in tree), (
            f"the old operator's folder is still there: {tree}"
        )

    def test_a_label_edit_schedules_a_regeneration(
        self, client: TestClient, layout: DataLayout, monkeypatch
    ) -> None:
        """The scheduling itself, so the test above cannot pass on its refresh."""
        capture_id = _seed(client, layout)
        scheduled: list[int] = []
        monkeypatch.setattr(
            client.app.state.capture_service,
            "_on_views_change",
            lambda: scheduled.append(1),
        )

        _patch(client, capture_id, base_revision=0, operator="bob")

        assert scheduled, (
            "a label edit did not ask for a views regeneration, so the tree "
            "keeps the previous operator until something unrelated changes"
        )

    def test_a_review_that_touched_no_label_schedules_nothing(
        self, client: TestClient, layout: DataLayout, monkeypatch
    ) -> None:
        # A regeneration is a filesystem walk. Every ordinary Save firing one
        # would put that walk on the recording loop for no reason.
        capture_id = _seed(client, layout)
        scheduled: list[int] = []
        monkeypatch.setattr(
            client.app.state.capture_service,
            "_on_views_change",
            lambda: scheduled.append(1),
        )

        _patch(client, capture_id, base_revision=0, review_status="adopted")

        assert scheduled == []

    def test_editing_only_the_robot_schedules_nothing(
        self, client: TestClient, layout: DataLayout, monkeypatch
    ) -> None:
        """``robot`` is not a path component; the tree cannot have moved."""
        capture_id = _seed(client, layout)
        scheduled: list[int] = []
        monkeypatch.setattr(
            client.app.state.capture_service,
            "_on_views_change",
            lambda: scheduled.append(1),
        )

        _patch(client, capture_id, base_revision=0, robot="otherbot")

        assert scheduled == []


class TestTheSidecarSchema:
    def test_a_label_block_round_trips(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = _seed(client, layout)
        _patch(client, capture_id, base_revision=0, operator="bob", task="place")

        record = read_record(layout.capture_dir(capture_id)).record

        assert record is not None
        assert record.labels == {"operator": "bob", "task": "place"}

    def test_an_unknown_label_key_makes_the_file_corrupt(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """``labels`` is a closed set, not an annotation store.

        Reported as corrupt rather than ignored: §8 rule 4 requires a sidecar
        that cannot be read as written to be surfaced, and silently dropping a
        key would lose whatever a newer version meant by it.
        """
        capture_id = _seed(client, layout)
        _patch(client, capture_id, base_revision=0, operator="bob")
        path = layout.capture_dir(capture_id) / RECORD_FILENAME
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["labels"] = {"site": "warehouse"}
        path.write_text(json.dumps(payload), encoding="utf-8")

        read = read_record(layout.capture_dir(capture_id))

        assert str(read.status) == "corrupt"
        assert "site" in (read.error or "")

    def test_a_null_label_value_is_read_as_no_override(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """A client's spelling of "cleared" must not make the file unreadable."""
        capture_id = _seed(client, layout)
        _patch(client, capture_id, base_revision=0, operator="bob")
        path = layout.capture_dir(capture_id) / RECORD_FILENAME
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["labels"] = {"operator": None}
        path.write_text(json.dumps(payload), encoding="utf-8")

        read = read_record(layout.capture_dir(capture_id))

        assert str(read.status) == "ok"
        assert read.record is not None
        assert read.record.labels == {}
