"""E-17: ``kairos.db`` deleted while a recording is in flight, then a restart.

§8 says the database is an index that can be thrown away and rebuilt from the
sidecars. Every existing test of that deletes it while the store is at rest.
Doing it *during* a recording reaches a different branch, because rule 1 of the
rebuild excludes a capture the recorder says is live — correctly, since its
directory has no terminal manifest yet and adopting it would invent a finished
recording out of one still being written.

The consequence is that after the restart **no row claims to be active** while
the recorder is still writing. Stop then has to answer for a capture the
catalog has never heard of, and the answer it used to give was the *previous*
take, with a 200. That is the `5 cameras OK` failure: a confident wrong answer.
The recording itself was fine — the bag sealed, and the periodic reconciler
adopted it as an orphan up to 120 seconds later — but for those two minutes the
operator was shown a take they had not just recorded, and the capture_id the
browser held had no row to save a review against.
"""

from __future__ import annotations

import time
from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from conftest import FakeRecorder, reconcile
from fastapi.testclient import TestClient
from kairos_common import Settings


def _start(client: TestClient, **body: object) -> dict:
    payload = {"topics": ["/joint_states"], **body}
    response = client.post("/api/v1/record/start", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def _reopen(settings: Settings, fake_recorder: FakeRecorder) -> TestClient:
    """The orchestrator coming back up against the same recorder and data dir."""
    app = create_orchestrator_app(
        settings,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(fake_recorder.handler)
        ),
    )
    return TestClient(app)


def _await_settlement(client: TestClient, *, timeout_s: float = 10.0) -> None:
    service = client.app.state.record_service
    deadline = time.monotonic() + timeout_s
    while service._settlement_tasks and time.monotonic() < deadline:
        time.sleep(0.02)


class TestStopAfterTheIndexWasDeletedMidRecording:
    """Stop must answer for the take that is recording, or refuse by name."""

    def test_stop_does_not_return_an_earlier_take(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        settings: Settings,
        data_dir: Path,
    ) -> None:
        """The measured defect: a 200 naming a recording from minutes ago.

        The earlier take is what makes this visible rather than merely absent —
        with an empty catalog the old code produced ``404 no_captures``, which
        is at least not a lie. One completed take in the store turns the same
        code path into a confident wrong answer.
        """
        _start(client)
        earlier = client.post("/api/v1/record/stop").json()["capture_id"]
        _await_settlement(client)

        live = _start(client)["capture_id"]
        assert live != earlier
        client.close()
        (data_dir / "kairos.db").unlink()

        with _reopen(settings, fake_recorder) as reopened:
            # Rule 1 holds and is not what is under test: the live capture is
            # deliberately left out of the rebuild.
            assert reopened.get(f"/api/v1/captures/{live}").status_code == 404
            assert fake_recorder.state == "recording"

            stopped = reopened.post("/api/v1/record/stop")
            assert stopped.status_code == 200, stopped.text
            body = stopped.json()
            assert body["capture_id"] != earlier, (
                "stop returned a different take than the one that was recording"
            )
            assert body["capture_id"] == live
            assert body["state"] == "completed"

    def test_the_capture_is_reviewable_the_moment_stop_returns(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        settings: Settings,
        data_dir: Path,
    ) -> None:
        """Not merely named in the response — actually in the catalog.

        The console does not read the stop response's capture_id
        (`useBatchMachine.ts` keeps the one its own start returned), so the very
        next thing it does is save a review against that id. Returning the right
        id while the row still does not exist would move the failure one step
        later and call it fixed.
        """
        live = _start(client)["capture_id"]
        client.close()
        (data_dir / "kairos.db").unlink()

        with _reopen(settings, fake_recorder) as reopened:
            reopened.post("/api/v1/record/stop")

            detail = reopened.get(f"/api/v1/captures/{live}")
            assert detail.status_code == 200, detail.text
            assert detail.json()["state"] == "completed"

            saved = reopened.patch(
                f"/api/v1/captures/{live}/review",
                json={"base_revision": 0, "task_result": "success"},
            )
            assert saved.status_code == 200, saved.text

    def test_the_recording_is_settled_rather_than_left_without_a_verdict(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        settings: Settings,
        data_dir: Path,
    ) -> None:
        """Adopting the row is half the job; a capture with no verdict is the
        other half of the same hole (the ``settle_adopted`` lesson).

        Without the quick check the capture reaches Review as NEEDS CHECK with
        nothing to look at, which is the state E-2's boundary test already
        named as the one worth avoiding.
        """
        live = _start(client)["capture_id"]
        client.close()
        (data_dir / "kairos.db").unlink()

        with _reopen(settings, fake_recorder) as reopened:
            reopened.post("/api/v1/record/stop")
            _await_settlement(reopened)
            detail = reopened.get(f"/api/v1/captures/{live}").json()
            assert detail["quick_check"] is not None

    def test_an_empty_catalog_no_longer_answers_no_captures(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        settings: Settings,
        data_dir: Path,
    ) -> None:
        """The same path with nothing else in the store.

        It used to be ``404 no_captures`` — honest, but wrong: something WAS
        recording, and the operator pressing Stop is entitled to have it
        stopped and named.
        """
        live = _start(client)["capture_id"]
        client.close()
        (data_dir / "kairos.db").unlink()

        with _reopen(settings, fake_recorder) as reopened:
            stopped = reopened.post("/api/v1/record/stop")
            assert stopped.status_code == 200, stopped.text
            assert stopped.json()["capture_id"] == live

    def test_the_reconciler_route_still_works_and_is_now_a_no_op(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        settings: Settings,
        data_dir: Path,
    ) -> None:
        """The 120-second recovery is the safety net, not the mechanism.

        It has to keep working (a stop that never comes still has to be
        adopted) but it must no longer be the FIRST thing that files this
        capture, and it must not file a second copy of one stop already
        adopted.
        """
        live = _start(client)["capture_id"]
        client.close()
        (data_dir / "kairos.db").unlink()

        with _reopen(settings, fake_recorder) as reopened:
            reopened.post("/api/v1/record/stop")
            before = reopened.get("/api/v1/captures").json()["items"]
            reconcile(reopened)
            after = reopened.get("/api/v1/captures").json()["items"]
            assert [c["capture_id"] for c in after] == [c["capture_id"] for c in before]
            assert [c["capture_id"] for c in after] == [live]


class TestWhenTheCaptureCannotBeAdopted:
    def test_stop_names_the_capture_it_could_not_file(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        settings: Settings,
        data_dir: Path,
    ) -> None:
        """No manifest on disk means §8 rule 4 forbids inventing the capture.

        The recording is still stopped — leaving the recorder writing would be
        the worse failure — but the answer must name THIS capture_id rather
        than fall back to some other take. "I stopped it and could not file it"
        is actionable; a stranger's capture id is not.
        """
        live = _start(client)["capture_id"]
        client.close()
        (data_dir / "kairos.db").unlink()
        # The bytes are gone, which is what an operator clearing objects/ by
        # hand (E-18) leaves behind. The recorder still holds the session.
        import shutil

        shutil.rmtree(data_dir / "objects" / live)

        with _reopen(settings, fake_recorder) as reopened:
            stopped = reopened.post("/api/v1/record/stop")
            assert stopped.status_code == 409, stopped.text
            error = stopped.json()["error"]
            assert error["code"] == "stop_capture_unfiled"
            assert live in error["message"]
            assert error["details"]["capture_id"] == live
            # Stopped regardless: the bag must not keep growing.
            assert fake_recorder.state != "recording"
