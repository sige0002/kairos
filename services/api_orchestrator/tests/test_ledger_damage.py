# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""A damaged ledger line, driven through the routes that read the ledger.

``ledger_v2.read_all`` raises :class:`LedgerUnreadableError` for a line that was
a complete, fsynced record until something changed it. The rebuild paths catch
it; these three did not, and nothing in this suite exercised a damaged ledger
through HTTP — which is how a new ``raise`` reached a live route unnoticed.

Every site here refuses rather than degrading, and none of them may use
``strict=False``. That hatch returns the lines that DID parse — an explicitly
incomplete history — and all three of these act on the answer rather than
showing it: a member line missing from the history re-issues a display_index,
a missing seal runs a sealed archive a second time, and a partial replay
rebuilds a never-reuse watermark that is too low. An incomplete history is not
a smaller answer here, it is a plausible wrong one arriving silently.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import ledger_v2
from kairos_common.ids import new_capture_id
from test_dataset_archive import _archive_client, _dataset, _settle


def _damage(layout: DataLayout) -> None:
    """Append a line that is damage rather than a torn write.

    The torn-tail forgiveness is exactly "no newline after it", so a line that
    ends with one was a whole record when it was written. This is the shape a
    hand-edit or a bad restore leaves behind.
    """
    path = ledger_v2.ledger_path(layout.data_dir)
    with path.open("a", encoding="utf-8") as handle:
        handle.write('{"kind": "dataset_member_a\n')


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


class TestAddMemberRefusesOnADamagedLedger:
    def test_the_route_answers_a_documented_refusal_not_a_bare_500(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """Adding a member has to read the ledger, and cannot guess.

        The number a returning capture reclaims lives only in the ledger. With
        one line unreadable there is no honest answer: allocate the next number
        and a recording that already owns one gets a second; assume the history
        is empty and a retired number goes to a stranger. So the route refuses,
        with a code the frontend catalog and the spec both know.
        """
        dataset_id = client.post("/api/v1/datasets", json={"name": "ds"}).json()[
            "dataset_id"
        ]
        capture_id = _capture(client, layout)
        _damage(layout)

        response = client.post(
            f"/api/v1/datasets/{dataset_id}/members", json={"capture_id": capture_id}
        )

        assert response.status_code == 503, response.text
        error = response.json()["error"]
        assert error["code"] == "ledger_unreadable"
        # The refusal has to name the file: repairing it is the operator's
        # only way out, and they cannot repair what nobody named.
        assert str(ledger_v2.ledger_path(layout.data_dir)) in error["message"]
        # Nothing was written on the way to refusing.
        assert client.get(f"/api/v1/datasets/{dataset_id}").json()["members"] == []


class TestTheArchiveRunHaltsOnADamagedLedger:
    def test_a_resume_stops_instead_of_re_running_the_archive(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        """The run asks the ledger whether it already sealed. It must not guess.

        ``_seal_event`` is what stops a finished archive from running twice. An
        empty history reads as "never sealed", and in ``move`` mode a second
        run deletes source bytes for a dataset that already left. So an
        unreadable ledger halts the run where it stands, which is the state a
        resume is designed for anyway.
        """
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            store = client.app.state.capture_store
            dataset = _dataset(client, layout, members=1, name="ds")
            dataset_id = dataset["dataset_id"]
            member = client.get(f"/api/v1/datasets/{dataset_id}").json()["members"][0]
            target = roots / "exports" / "alice" / "pick" / "ds"
            # A run that froze its member set and died before copying.
            assert store.begin_dataset_archive(dataset_id, destination=str(target))
            ledger_v2.append(
                layout.data_dir,
                "dataset_archive_started",
                instance_id=client.app.state.instance_id,
                payload={
                    "dataset_id": dataset_id,
                    "destination": str(target),
                    "dataset_name": "ds",
                    "members": [
                        {
                            "membership_id": member["membership_id"],
                            "capture_id": member["capture_id"],
                            "display_index": member["display_index"],
                        }
                    ],
                },
            )
            _damage(layout)

            accepted = client.post(f"/api/v1/datasets/{dataset_id}/archive", json={})
            assert accepted.status_code == 202, accepted.text
            _settle(client, dataset_id)

            progress = client.get(f"/api/v1/datasets/{dataset_id}/archive").json()
            assert progress["error"]["code"] == "ledger_unreadable"
            # Halted, not finished, and nothing was moved on the way there.
            assert progress["status"] == "archiving"
            assert layout.capture_dir(member["capture_id"]).is_dir()
            assert not (target / "001").exists()


class TestTheReplayRefusesRatherThanRebuildingNothing:
    def test_an_unreadable_ledger_stops_the_replay(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """The one place ``strict=False`` would be silently catastrophic.

        The replay builds the never-reuse watermark out of the history it
        reads, and every dropped ``dataset_member_added`` line is a number that
        never raises the floor. A partial history therefore rebuilds a
        watermark that is too LOW — not a smaller answer but a wrong one — and
        the next add hands a retired number to a different recording, the exact
        defect the floors exist to prevent. Refusing is the only safe answer,
        so this pins the raise itself: anyone who "fixes" this call by passing
        strict=False turns this test red.
        """
        dataset_id = client.post("/api/v1/datasets", json={"name": "ds"}).json()[
            "dataset_id"
        ]
        client.post(
            f"/api/v1/datasets/{dataset_id}/members",
            json={"capture_id": _capture(client, layout)},
        )
        _damage(layout)

        with pytest.raises(ledger_v2.LedgerUnreadableError):
            client.app.state.dataset_service.restore_from_ledger()
