"""E-17(B): the stop-time verdict must survive "delete kairos.db and restart".

§8's central promise is that the database is an index: throw it away, restart,
and the catalog comes back from the sidecars. ``quick_check`` was an unrecorded
exception to that. It existed in exactly one place — the ``captures.quick_check``
column — with no sidecar and no ledger event behind it, so the documented
recovery erased every integrity result, backstop and incident in the store.

What made it silent rather than merely lossy: ``review_status`` comes back from
``record.json``, so a capture returns still marked ``adopted`` while the
evidence for that adoption is gone. ``QuickCheckVerdict.tsx`` renders nothing at
all when the field is absent, so the screen does not say "lost" — it says
nothing, and an adoption with no visible basis looks like an adoption nobody
should question.

The reconciler cannot repair it either: its settle step only runs for captures
that same pass ADOPTED (`reconciler.py`), and a capture restored by the rebuild
was never adopted, so it is out of scope forever.
"""

from __future__ import annotations

from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import DataLayout
from conftest import FakeRecorder, reconcile, run_digests
from fastapi.testclient import TestClient
from kairos_common import Settings


def _start(client: TestClient, **body: object) -> dict:
    payload = {"topics": ["/joint_states"], **body}
    response = client.post("/api/v1/record/start", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def _await_settlement(client: TestClient, *, timeout_s: float = 10.0) -> None:
    import time

    service = client.app.state.record_service
    deadline = time.monotonic() + timeout_s
    while service._settlement_tasks and time.monotonic() < deadline:
        time.sleep(0.02)


def _reopen(settings: Settings, fake_recorder: FakeRecorder) -> TestClient:
    app = create_orchestrator_app(
        settings,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(fake_recorder.handler)
        ),
    )
    return TestClient(app)


def _record_and_settle(client: TestClient) -> str:
    _start(client)
    capture_id = client.post("/api/v1/record/stop").json()["capture_id"]
    _await_settlement(client)
    run_digests(client)
    return capture_id


class TestTheVerdictComesBack:
    def test_a_settled_quick_check_survives_a_deleted_index(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        settings: Settings,
        data_dir: Path,
    ) -> None:
        capture_id = _record_and_settle(client)
        before = client.get(f"/api/v1/captures/{capture_id}").json()["quick_check"]
        assert before is not None, "premise: the capture settled before the deletion"

        client.close()
        (data_dir / "kairos.db").unlink()

        with _reopen(settings, fake_recorder) as reopened:
            after = reopened.get(f"/api/v1/captures/{capture_id}").json()["quick_check"]
            assert after is not None, "the stop-time verdict was lost by the rebuild"
            # The whole verdict, not a shape that merely parses: these are what
            # the screen reads, and a restored husk would render an empty card.
            assert after["verdict"] == before["verdict"]
            assert after["layer0"] == before["layer0"]
            assert after["layer1"] == before["layer1"]

    def test_the_evidence_and_the_review_come_back_together(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        settings: Settings,
        data_dir: Path,
    ) -> None:
        """The pairing is the point: `adopted` with no verdict is the lie.

        ``review_status`` always came back (record.json). Restoring the verdict
        beside it is what stops a rebuild from producing an adoption whose
        basis has vanished.
        """
        capture_id = _record_and_settle(client)
        saved = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={
                "base_revision": 0,
                "task_result": "success",
                "review_status": "adopted",
            },
        )
        assert saved.status_code == 200, saved.text

        client.close()
        (data_dir / "kairos.db").unlink()

        with _reopen(settings, fake_recorder) as reopened:
            detail = reopened.get(f"/api/v1/captures/{capture_id}").json()
            assert detail["review_status"] == "adopted"
            assert detail["quick_check"] is not None

    def test_a_reconcile_pass_does_not_undo_the_restored_verdict(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        settings: Settings,
        data_dir: Path,
    ) -> None:
        """The periodic pass rewrites rows from manifests; it must not blank this."""
        capture_id = _record_and_settle(client)
        client.close()
        (data_dir / "kairos.db").unlink()

        with _reopen(settings, fake_recorder) as reopened:
            reconcile(reopened)
            detail = reopened.get(f"/api/v1/captures/{capture_id}").json()
            assert detail["quick_check"] is not None


class TestWhatIsHonestlyAbsent:
    def test_a_capture_settled_before_this_rule_comes_back_empty_not_invented(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        settings: Settings,
        data_dir: Path,
    ) -> None:
        """No migration (§8 absorbs schema change by rebuild, not by upgrade).

        A capture recorded before the sidecar existed has nothing on disk to
        restore from, and the only honest answer is the one an unsettled
        capture gets. Manufacturing a verdict from the bag at rebuild time
        would be a fresh measurement wearing the timestamp of an old one.
        """
        capture_id = _record_and_settle(client)
        # Exactly the state an older installation is in: bag, manifest and the
        # row's verdict, but no verdict sidecar.
        from kairos_common.capture_sidecars import QUICK_CHECK_FILENAME

        (data_dir / "objects" / capture_id / QUICK_CHECK_FILENAME).unlink()

        client.close()
        (data_dir / "kairos.db").unlink()

        with _reopen(settings, fake_recorder) as reopened:
            detail = reopened.get(f"/api/v1/captures/{capture_id}")
            assert detail.status_code == 200
            assert detail.json()["quick_check"] is None

    def test_an_unreadable_verdict_sidecar_does_not_take_the_capture_with_it(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        settings: Settings,
        data_dir: Path,
    ) -> None:
        """A capture is a bag and a manifest; the verdict is an accessory.

        Losing the whole recording because one derived sidecar was truncated
        mid-write would be the rebuild abandoning data it can plainly read.
        """
        capture_id = _record_and_settle(client)
        from kairos_common.capture_sidecars import QUICK_CHECK_FILENAME

        (data_dir / "objects" / capture_id / QUICK_CHECK_FILENAME).write_text(
            '{"verdict": {', encoding="utf-8"
        )

        client.close()
        (data_dir / "kairos.db").unlink()

        with _reopen(settings, fake_recorder) as reopened:
            detail = reopened.get(f"/api/v1/captures/{capture_id}")
            assert detail.status_code == 200
            assert detail.json()["state"] == "completed"
            assert detail.json()["quick_check"] is None


class TestWhenTheSidecarCannotBeWritten:
    """The trade this file's §4.2 promises, pinned so it cannot be reversed.

    Writing the sidecar first is §8's ordering, but it must not become a
    *precondition* for settling: the row is what the screen reads, and an
    operator waiting on a verdict should not lose it because the disk hiccuped.
    What is lost is durability across a rebuild — real, and strictly smaller.

    Without this test, tightening the handler to re-raise leaves all 644 other
    tests green while every disk error silently becomes a capture with no
    verdict at all.
    """

    def test_a_failed_sidecar_write_still_lets_the_verdict_reach_the_row(
        self, client: TestClient, layout: DataLayout, monkeypatch
    ) -> None:
        import logging

        from api_orchestrator import record_service as record_service_mod

        def boom(*args: object, **kwargs: object) -> None:
            raise OSError(28, "No space left on device")

        # Collected through a handler on the app's own logger rather than
        # capsys: ``configure_logging`` binds ``sys.stdout`` once, at whichever
        # app creation ran first, so what capsys sees depends on test order.
        records: list[logging.LogRecord] = []

        class _Collect(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                records.append(record)

        collector = _Collect()
        logging.getLogger("kairos").addHandler(collector)
        monkeypatch.setattr(record_service_mod, "write_quick_check", boom)
        try:
            _start(client)
            capture_id = client.post("/api/v1/record/stop").json()["capture_id"]
            _await_settlement(client)
        finally:
            logging.getLogger("kairos").removeHandler(collector)

        detail = client.get(f"/api/v1/captures/{capture_id}").json()
        assert detail["quick_check"] is not None, (
            "the verdict was withheld because its sidecar could not be written"
        )
        # And the file really is absent — the assertion above must not be
        # satisfiable by the write having quietly succeeded.
        from kairos_common.capture_sidecars import QUICK_CHECK_FILENAME

        assert not (layout.capture_dir(capture_id) / QUICK_CHECK_FILENAME).exists()

        # Degrading silently is the other way to fail this. The log has to name
        # the consequence, not just the errno, because "this verdict will not
        # survive a rebuild" is the part an operator can act on.
        messages = [record.getMessage() for record in records]
        assert any("will not survive a catalog rebuild" in m for m in messages), (
            f"the degradation was not reported; logged: {messages}"
        )
