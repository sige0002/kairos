# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Batches survive "delete kairos.db and restart" (§8), via the ledger.

A batch used to live only in the database: no sidecar, no ledger line. So the
one thing `capture_store.md` promises — that the index can be thrown away and
rebuilt from disk — was not true of batches, while the recordings that belonged
to them came back still naming one. These tests drive the real restart path and
pin what has to come back, what must NOT come back wrong, and what happens to
the installations whose ledgers predate the event.
"""

from __future__ import annotations

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import DataLayout
from conftest import FakeRecorder
from fastapi.testclient import TestClient


def _restart(settings, fake_recorder: FakeRecorder) -> TestClient:
    app = create_orchestrator_app(
        settings,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(fake_recorder.handler)
        ),
    )
    return TestClient(app)


def _create(client: TestClient, **body) -> dict:
    payload = {"project": "p", "task": "pick"}
    payload.update(body)
    response = client.post("/api/v1/batches", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


class TestBatchesSurviveARebuild:
    def test_every_field_comes_back_including_the_daily_number(
        self,
        client: TestClient,
        layout: DataLayout,
        settings,
        fake_recorder: FakeRecorder,
    ) -> None:
        first = _create(
            client,
            project="grasping",
            task="pick",
            condition="daylight",
            project_id="project-grasping",
            task_id="task-pick",
            condition_id="condition-daylight",
            operator="alice",
            target_episodes=42,
        )
        second = _create(client, project="other")
        assert (first["batch_seq"], second["batch_seq"]) == (1, 2)
        client.__exit__(None, None, None)

        layout.db.unlink()
        with _restart(settings, fake_recorder) as restarted:
            back = restarted.get(f"/api/v1/batches/{first['batch_id']}").json()
            for field in (
                "batch_id",
                "robot",
                "project_id",
                "task_id",
                "condition_id",
                "project",
                "task",
                "condition",
                "operator",
                "target_episodes",
                "created_at",
                "batch_seq",
            ):
                assert back[field] == first[field], field
            # The daily numbering continues rather than restarting, because the
            # rows it is derived from are back.
            assert _create(restarted, project="third")["batch_seq"] == 3

    def test_a_relabelled_batch_comes_back_relabelled(
        self,
        client: TestClient,
        layout: DataLayout,
        settings,
        fake_recorder: FakeRecorder,
    ) -> None:
        """Creation is not the whole story: the labels are patchable."""
        batch = _create(client, project="draft", task="pick", condition="dim")
        patched = client.patch(
            f"/api/v1/batches/{batch['batch_id']}",
            json={
                "project": "final",
                "project_id": "project-final",
                "condition": "bright",
                "condition_id": "condition-bright",
                "target_episodes": 7,
            },
        )
        assert patched.status_code == 200, patched.text
        client.__exit__(None, None, None)

        layout.db.unlink()
        with _restart(settings, fake_recorder) as restarted:
            back = restarted.get(f"/api/v1/batches/{batch['batch_id']}").json()
        assert back["project"] == "final"
        assert back["project_id"] == "project-final"
        assert back["condition"] == "bright"
        assert back["condition_id"] == "condition-bright"
        assert back["target_episodes"] == 7

    def test_a_finished_batch_does_not_come_back_open(
        self,
        client: TestClient,
        layout: DataLayout,
        settings,
        fake_recorder: FakeRecorder,
    ) -> None:
        """The reason ``status`` is not a field of ``batch_created``.

        It is ``active`` at creation for every batch that ever existed, so a
        creation event carrying it says nothing — and a replay that trusted it
        would reconstruct a finished batch as open, which is a new wrong answer
        rather than a fix. The transition gets its own event, the same way a
        dataset's terminal move does.
        """
        batch = _create(client, project="done")
        ended = client.patch(
            f"/api/v1/batches/{batch['batch_id']}",
            json={"status": "completed", "ended_reason": "target reached"},
        )
        assert ended.status_code == 200, ended.text
        assert ended.json()["ended_at"] is not None
        client.__exit__(None, None, None)

        layout.db.unlink()
        with _restart(settings, fake_recorder) as restarted:
            back = restarted.get(f"/api/v1/batches/{batch['batch_id']}").json()
        assert back["status"] == "completed"
        assert back["ended_reason"] == "target reached"
        assert back["ended_at"] == ended.json()["ended_at"]

    def test_replaying_the_same_ledger_again_changes_nothing(
        self,
        client: TestClient,
        layout: DataLayout,
        settings,
        fake_recorder: FakeRecorder,
    ) -> None:
        """``KAIROS_REBUILD=1`` replays onto a live database (E-29's lesson).

        Every value the replay writes is read from the ledger rather than
        computed from the row it is about to overwrite, so a second pass lands
        on the same numbers. A ``batch_seq`` that were re-allocated per pass
        would drift upward on every forced rebuild.
        """
        batch = _create(client, project="stable")
        client.__exit__(None, None, None)

        layout.db.unlink()
        with _restart(settings, fake_recorder) as restarted:
            service = restarted.app.state.batch_service
            store = restarted.app.state.capture_store
            marks = [store.get_batch(batch["batch_id"]).batch_seq]
            for _ in range(3):
                service.restore_from_ledger()
                marks.append(store.get_batch(batch["batch_id"]).batch_seq)
            assert marks == [1, 1, 1, 1], marks
            # And the next batch still continues from there, once.
            assert _create(restarted, project="next")["batch_seq"] == 2


class TestALedgerThatPredatesTheEvent:
    def test_an_old_ledger_still_rebuilds_and_still_reports_its_orphans(
        self,
        client: TestClient,
        layout: DataLayout,
        settings,
        fake_recorder: FakeRecorder,
        capsys,
    ) -> None:
        """The path every existing installation takes on its next restart.

        Their ledgers hold no ``batch_created`` at all, so the replay has
        nothing to rebuild from — and must degrade to exactly what it did
        before: recordings return, the batch does not, and the loss is
        reported. Raising, or inventing a batch from the ids the recordings
        carry, would both be worse than the honest gap.
        """
        from kairos_common.capture_sidecars import RecordV2, write_record
        from test_rebuild_startup import _write_capture

        batch_id = "batch_20260805_224346"
        capture_id = _write_capture(layout, client.app.state.instance_id)
        write_record(
            layout.capture_dir(capture_id),
            RecordV2(capture_id=capture_id, revision=1, batch_id=batch_id),
        )
        client.__exit__(None, None, None)

        layout.db.unlink()
        with _restart(settings, fake_recorder) as restarted:
            assert restarted.get(f"/api/v1/captures/{capture_id}").status_code == 200
            assert restarted.get("/api/v1/batches").json()["items"] == []
            assert restarted.get(f"/api/v1/batches/{batch_id}").status_code == 404
        emitted = capsys.readouterr().out
        assert "no longer exist" in emitted
        assert f"{batch_id} x1" in emitted


class TestTheEventShapeIsEnforced:
    def test_batch_created_may_not_carry_a_status(self, layout: DataLayout) -> None:
        """The split is enforced by the ledger, not just by convention.

        Nothing stops a future caller from adding ``status`` back into the
        creation event, and it would look harmless — the field is right there
        on the model. The replay would then restore whatever the creation
        moment said, which for a batch ended weeks ago is "active". Refusing
        the payload is what keeps that from being a one-line regression.
        """
        import pytest
        from kairos_common import ledger_v2

        with pytest.raises(ValueError, match="may not carry status"):
            ledger_v2.append(
                layout.data_dir,
                "batch_created",
                instance_id="11111111-2222-3333-4444-555555555555",
                payload={"batch_id": "batch_1", "status": "completed"},
            )

    def test_a_batch_line_must_say_which_batch(self, layout: DataLayout) -> None:
        import pytest
        from kairos_common import ledger_v2

        with pytest.raises(ValueError, match="requires a non-empty batch_id"):
            ledger_v2.append(
                layout.data_dir,
                "batch_ended",
                instance_id="11111111-2222-3333-4444-555555555555",
                payload={"status": "completed"},
            )


class TestTheCounterResetIsAnnounced:
    def test_a_rebuild_says_which_batches_lost_their_episode_count(
        self,
        client: TestClient,
        layout: DataLayout,
        settings,
        fake_recorder: FakeRecorder,
        capsys,
    ) -> None:
        """`12 / 30` becoming `0 / 30` is a number going backwards on screen.

        `episodes_recorded` counts review saves — events, not facts — so the
        ledger does not carry it and a rebuild restores the batch without it.
        That is the right call for the ledger and the wrong thing to leave
        silent: an operator sees the counter drop and has nothing telling them
        why. A spec line reaches a developer; this reaches the person looking
        at the counter.
        """
        batch = _create(client, project="counted")
        store = client.app.state.capture_store
        for _ in range(12):
            store.increment_episodes_recorded(batch["batch_id"])
        assert store.get_batch(batch["batch_id"]).episodes_recorded == 12
        client.__exit__(None, None, None)

        layout.db.unlink()
        with _restart(settings, fake_recorder) as restarted:
            back = restarted.get(f"/api/v1/batches/{batch['batch_id']}").json()
            # The batch itself is fully restored...
            assert back["project"] == "counted"
            assert back["batch_seq"] == 1
            # ...and the one field that cannot be is back at zero.
            assert back["episodes_recorded"] == 0
            health = restarted.get("/api/v1/store/health").json()
            surfaced = health["warnings"]

        assert any("recorded-episode" in warning for warning in surfaced), surfaced
        assert any(batch["batch_id"] in warning for warning in surfaced), surfaced
        assert health["dismissible_warnings"] == surfaced


class TestALostCreationLine:
    def test_an_edit_whose_creation_line_is_gone_invents_nothing(
        self,
        client: TestClient,
        layout: DataLayout,
        settings,
        fake_recorder: FakeRecorder,
    ) -> None:
        """A truncated head leaves edits pointing at a batch nobody created.

        The tempting reading is that an edit proves the batch existed, so the
        replay could mint it from what the edit carries. It must not: the edit
        has no `batch_seq`, so the invented batch would hold a daily number
        nobody allocated — and the next real batch that day would collide with
        it. Dropping the edit leaves the honest state instead, which the orphan
        report already describes.
        """
        from kairos_common import ledger_v2

        orphan_id = "batch_20260805_120000"
        for kind, payload in (
            ("batch_updated", {"batch_id": orphan_id, "project": "ghost"}),
            ("batch_ended", {"batch_id": orphan_id, "status": "completed"}),
        ):
            ledger_v2.append(
                layout.data_dir,
                kind,
                instance_id=client.app.state.instance_id,
                payload=payload,
            )
        # A real batch created afterwards, so the numbering is observable.
        real = _create(client, project="real")
        assert real["batch_seq"] == 1
        client.__exit__(None, None, None)

        layout.db.unlink()
        with _restart(settings, fake_recorder) as restarted:
            # The batch the edits name was never created and is not invented.
            assert restarted.get(f"/api/v1/batches/{orphan_id}").status_code == 404
            listed = restarted.get("/api/v1/batches").json()["items"]
            assert [b["batch_id"] for b in listed] == [real["batch_id"]]
            # And the number it never held is still free for the next batch.
            assert (
                restarted.get(f"/api/v1/batches/{real['batch_id']}").json()["batch_seq"]
                == 1
            )
            assert _create(restarted, project="after")["batch_seq"] == 2


class TestTwoCreationLinesOneId:
    def test_a_second_different_batch_on_one_id_is_not_dropped_in_silence(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """No live path can write this; the point is that a future one cannot hide.

        The replay inserts and ignores a taken id, which is exactly right when
        the same ledger is replayed twice — same batch, nothing to do. If two
        creation lines ever described DIFFERENT batches under one id, that same
        ignore would drop the second without a word and the catalog would be
        short one batch that the ledger plainly records.
        """
        from kairos_common import ledger_v2

        service = client.app.state.batch_service
        shared = "batch_20260805_090000"
        for project, seq in (("first", 1), ("second", 2)):
            ledger_v2.append(
                layout.data_dir,
                "batch_created",
                instance_id=client.app.state.instance_id,
                payload={
                    "batch_id": shared,
                    "batch_seq": seq,
                    "project": project,
                    "task": "pick",
                    "target_episodes": 30,
                },
            )

        report = service.restore_from_ledger()

        assert report.restored == 1
        assert any(shared in warning for warning in report.warnings)
        assert any("disagree about" in warning for warning in report.warnings)
        # The disagreement is in the ledger, so it is still true on the next
        # rebuild and is reported again — a condition, not a one-off event.
        # What must not drift is the outcome: still one batch, still one id.
        again = service.restore_from_ledger()
        assert again.restored == 0  # already there; nothing re-inserted
        assert any("disagree about" in w for w in again.warnings if shared in w)
        assert client.app.state.capture_store.get_batch(shared).project == "first"
