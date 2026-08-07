"""A capture the recorder finalised by itself, found by something other than a poll.

``stop()`` is not the only way a recording reaches a terminal state, but for a
long time it was the only place that settled a quick check. Every other route
into the catalog goes through ``_interrupt_all``, and a capture reconciled there
was left with ``quick_check: null`` for good — no verdict, no integrity, and no
``backstop``, which is the field the API contract names for the auto-stop note
(``api_orchestrator.md`` §"quick_check").

The five routes, and which of them settled:

    status poll, recorder idle + still naming it   -> stop()          settled
    a new start finding a stale live row           -> _interrupt_all  NOT settled
    orchestrator restart                           -> _interrupt_all  NOT settled
    the recorder armed for the next take           -> _interrupt_all  NOT settled
    the periodic reconciliation pass               -> the reconciler  NOT settled

That split is worst exactly where it matters. ``MAX_RECORD_SECONDS`` exists for
the UNATTENDED case (``config.md``: "the safety net when unattended"), and
unattended means nobody is polling — so the console's poll, which is what
reaches the settling route, is the thing that is missing. Attended, the poll
wins the race and hides it; unattended, the recording that most needs a verdict
is the one that never gets one.

The fifth route is the one the unattended case actually takes. With the
orchestrator up and nobody touching it, no poll, no start and no restart ever
happens — the 120s reconciliation pass is what reaches the capture first, and it
adopted the manifest's facts (§8) without settling anything.

It is also a spec deviation: ``api_orchestrator.md`` §record says a capture the
recorder REPORTS AS FINISHED settles through the normal stop path, but
``_interrupt_all`` only consults ``_capture_id_of`` when the recorder is
*active*, so it never asks about the capture the recorder is actively reporting
as completed.

Every test here uses the same recording sealed the same way; only the route that
discovers it differs. The status-poll case is carried along as the positive
control so a green run proves the ROUTE was the variable.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime
from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.models import Capture, CaptureState
from api_orchestrator.reconciler import ReconcileResult
from api_orchestrator.store import CaptureStore
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import Settings

CAP_NOTE = "auto-stopped: recording ran 600s, reaching MAX_RECORD_SECONDS=600"
# What the fake stamps into a finalised manifest.
SEALED_ENDED_AT = "2026-08-01T00:05:00.000Z"
# The same instant in epoch ns, which is what a settlement windows incidents on.
# Years in the past, so a settlement that reached for the clock instead cannot
# land on it by accident.
SEALED_ENDED_NS = int(
    datetime.fromisoformat(SEALED_ENDED_AT.replace("Z", "+00:00")).timestamp()
    * 1_000_000_000
)


def _store(client: TestClient) -> CaptureStore:
    return client.app.state.capture_store


def _start(client: TestClient, **body: object) -> dict:
    payload = {"topics": ["/joint_states"], **body}
    response = client.post("/api/v1/record/start", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def _recorder_hits_its_cap(fake: FakeRecorder, *, note: str = CAP_NOTE) -> None:
    """The recorder's own watcher tripped: it sealed the bag and went idle.

    No ``/record/stop`` was sent and none will be — this is the whole point of
    the wall-clock cap. What is left behind is a terminal manifest on disk and a
    recorder reporting nothing live.
    """
    fake.state = "completed"
    fake.finalized = True
    fake.final_state = "completed"
    fake.final_error = note
    fake.integrity = "ok"
    fake.message_count = 1234
    fake.bytes = 567890
    fake._write_bag()
    fake._write_manifest("completed")


def _await_settlement(client: TestClient, *, timeout_s: float = 20.0) -> None:
    service = client.app.state.record_service
    deadline = time.monotonic() + timeout_s
    while service._settlement_tasks and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not service._settlement_tasks, "a quick-check settlement never finished"


def _one_periodic_pass(client: TestClient) -> ReconcileResult:
    """Drive ``run_once()`` and nothing else, then let what it fired finish.

    The pass runs on a private loop, the way ``conftest.reconcile`` does, so the
    settlement it schedules is drained inside that same loop: a task belonging
    to a loop that has already closed can never be awaited from anywhere else.
    That is also why ``_await_settlement`` above is not used here — it polls the
    task set from the outside, and by the time this returns the set is empty
    because the work is done, not because it was never scheduled.
    """

    async def pass_and_drain() -> ReconcileResult:
        result = await client.app.state.reconciler.run_once()
        await client.app.state.record_service.drain_settlements()
        return result

    return asyncio.run(pass_and_drain())


def _assert_settled(client: TestClient, capture_id: str) -> None:
    capture = _store(client).get_capture(capture_id)
    assert capture is not None
    # The classification first: if THIS is what broke, the failure should say so
    # rather than being reported as a missing quick check.
    assert str(capture.state) == "completed"
    assert capture.error is not None
    assert capture.error.code == "auto_stopped"

    assert capture.quick_check is not None, (
        "the capture was reconciled but never settled: no verdict, no integrity, "
        "and no backstop — permanently, since nothing re-settles it later"
    )
    assert capture.quick_check.layer0.backstop == CAP_NOTE
    assert capture.quick_check.layer0.integrity == "ok"
    assert capture.quick_check.verdict is not None


class TestEveryRouteSettles:
    def test_the_status_poll_settles_it(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        # POSITIVE CONTROL. This is the one route that always settled, and it is
        # here so the others are known to differ by route and nothing else.
        started = _start(client)
        _recorder_hits_its_cap(fake_recorder)
        client.get("/api/v1/record/status")
        _await_settlement(client)
        _assert_settled(client, started["capture_id"])

    def test_the_next_start_settles_the_take_it_reconciles(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        # The attended-but-unlucky case: the cap tripped and the operator
        # pressed Start again before any poll landed. The stale live row is
        # reconciled by `_verify_no_active_recording`.
        started = _start(client)
        _recorder_hits_its_cap(fake_recorder)

        _start(client)  # the next take; reconciles the previous row on the way

        _await_settlement(client)
        _assert_settled(client, started["capture_id"])

    def test_an_arming_for_the_next_take_settles_the_previous_one(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        # Pre-arm is a standing prepare, so this is the ordinary console at
        # rest: the cap trips, the console arms for the next take, and the
        # status poll now finds the recorder ARMED — which is not "active", so
        # reconciliation goes the non-settling way.
        started = _start(client)
        _recorder_hits_its_cap(fake_recorder)

        armed = client.post("/api/v1/record/prepare", json={"topics": ["/tf"]})
        assert armed.status_code == 200, armed.text
        assert fake_recorder.state == "armed"
        client.get("/api/v1/record/status")

        _await_settlement(client)
        _assert_settled(client, started["capture_id"])

    def test_a_restart_settles_the_take_it_finds_left_recording(
        self, settings: Settings, fake_recorder: FakeRecorder, data_dir: Path
    ) -> None:
        # The unattended case in full: the cap tripped overnight, nobody
        # polled, and the orchestrator was restarted before anyone looked.
        with TestClient(
            create_orchestrator_app(
                settings,
                http_client=httpx.AsyncClient(
                    transport=httpx.MockTransport(fake_recorder.handler)
                ),
            )
        ) as first:
            started = _start(first)
            _recorder_hits_its_cap(fake_recorder)

        reopened_app = create_orchestrator_app(
            settings,
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(fake_recorder.handler)
            ),
        )
        with TestClient(reopened_app) as reopened:
            _await_settlement(reopened)
            _assert_settled(reopened, started["capture_id"])

    def test_the_periodic_pass_settles_the_take_it_adopts(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        # The unattended case as it really happens: the orchestrator stays up,
        # the cap trips at 3am, and nobody polls, starts or restarts anything.
        # None of the four routes above is even reachable — the 120s pass is
        # what gets there first, and it adopted the manifest's facts (§8)
        # without settling a quick check, so the capture the backstop exists
        # for was the one left without a verdict.
        started = _start(client)
        _recorder_hits_its_cap(fake_recorder)

        result = _one_periodic_pass(client)

        assert result.settled == 1
        _assert_settled(client, started["capture_id"])


class TestWhatThePassIsAllowedToSkip:
    def test_a_take_with_no_auto_stop_note_settles_just_the_same(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        # The auto-stop note is what made this defect VISIBLE, not what the
        # settlement is for. Narrowing the pass to "captures carrying a
        # backstop" would leave every other capture the reconciler adopts
        # without a verdict — a recorder killed mid-take writes its own
        # recovery manifest with a reason of its own, and that recording needs
        # a quick check at least as much as a capped one does.
        started = _start(client)
        # Killed and restarted rather than capped: a terminal manifest, real
        # counters, and a reason that is not an auto-stop note.
        fake_recorder.state = "idle"
        fake_recorder.finalized = True
        fake_recorder.final_state = "interrupted"
        fake_recorder.final_error = "recorder restarted; the take was recovered"
        fake_recorder.integrity = "ok"
        fake_recorder.message_count = 1234
        fake_recorder.bytes = 567890
        fake_recorder._write_bag()
        fake_recorder._write_manifest("interrupted")

        assert _one_periodic_pass(client).settled == 1

        capture = _store(client).get_capture(started["capture_id"])
        assert capture is not None
        assert capture.state == CaptureState.interrupted
        assert capture.quick_check is not None, (
            "the pass settled only the captures that carry an auto-stop note; "
            "every terminal manifest it adopts gets a verdict"
        )
        assert capture.quick_check.verdict is not None
        assert capture.quick_check.layer0.integrity == "ok"
        # No note, so no backstop — reported as absent, never invented.
        assert capture.quick_check.layer0.backstop is None


class TestThePassRunsEveryTwoMinutes:
    """Whatever the pass does to a settled capture, it does 720 times a day."""

    def test_a_second_pass_does_not_settle_the_same_capture_again(
        self, client: TestClient, fake_recorder: FakeRecorder, monkeypatch
    ) -> None:
        # Re-settling is not a harmless repeat. It rewrites `quick_check` from
        # scratch and re-runs `reconcile_quality`, which can bump a review's
        # revision — so a capture nobody touched would churn its way through
        # every operator's open Review tab as a 409 on the next save.
        service = client.app.state.record_service
        settled: list[str] = []
        original = service._schedule_settlement

        def spy(capture, **kwargs):
            settled.append(capture.capture_id)
            return original(capture, **kwargs)

        monkeypatch.setattr(service, "_schedule_settlement", spy)

        started = _start(client)
        _recorder_hits_its_cap(fake_recorder)

        _one_periodic_pass(client)
        second = _one_periodic_pass(client)

        assert settled == [started["capture_id"]], (
            "the periodic pass settled the same capture more than once; only "
            "the pass that ADOPTS a terminal manifest has anything to settle"
        )
        assert second.settled == 0
        _assert_settled(client, started["capture_id"])


class TestWhatTheSettlementIsAllowedToRead:
    def test_the_verdict_is_built_from_this_captures_own_sidecar(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        # On this route the recorder has MOVED ON — by the time anything
        # reconciles the capped take, the recorder may be recording something
        # else. Asking the live recorder for `integrity` would attribute the
        # NEXT recording's health to this one, so the settlement must read the
        # sealed sidecar of the capture it is settling.
        started = _start(client)
        _recorder_hits_its_cap(fake_recorder)

        # The next take starts and is going badly. Its integrity and its lack
        # of an auto-stop note are the live recorder's current answers.
        fake_recorder.integrity = "dropped"
        fake_recorder.final_error = None
        _start(client)

        _await_settlement(client)
        capture = _store(client).get_capture(started["capture_id"])
        assert capture is not None
        assert capture.quick_check is not None
        # Both fields come from the sealed sidecar, not from the live session.
        assert capture.quick_check.layer0.integrity == "ok"
        assert capture.quick_check.layer0.backstop == CAP_NOTE

    def test_the_incident_window_closes_when_the_recording_did(
        self, client: TestClient, fake_recorder: FakeRecorder, monkeypatch
    ) -> None:
        # `stop_ns` bounds which monitor incidents are attributed to this
        # recording. Reconciliation can happen minutes or hours after the
        # recorder capped itself, so using now() would sweep in incidents that
        # fired long after the bag was closed and report them as this take's.
        # The honest bound is the capture's own end stamp.
        seen: dict[str, int | None] = {}
        service = client.app.state.record_service
        original = service._schedule_settlement

        def spy(capture, **kwargs):
            seen["stop_ns"] = kwargs.get("stop_ns")
            return original(capture, **kwargs)

        monkeypatch.setattr(service, "_schedule_settlement", spy)

        started = _start(client)
        _recorder_hits_its_cap(fake_recorder)
        _start(client)
        _await_settlement(client)

        assert _store(client).get_capture(started["capture_id"]) is not None
        ended_ns = int(
            __import__("datetime")
            .datetime.fromisoformat(SEALED_ENDED_AT.replace("Z", "+00:00"))
            .timestamp()
            * 1_000_000_000
        )
        assert seen["stop_ns"] == ended_ns, (
            "the settlement windowed incidents on wall-clock now() rather than "
            "on when this recording actually ended"
        )

    def test_the_periodic_pass_reads_the_same_two_things(
        self, client: TestClient, fake_recorder: FakeRecorder, monkeypatch
    ) -> None:
        # Both rules above, pinned on the route that reaches them last. The two
        # tests before this one drive the START route, so a settlement written
        # separately for the periodic pass — one that asks the live recorder, or
        # windows on now() — satisfies them both and fails only here. That is
        # not a hypothetical: this route is the one where the delay between the
        # recording ending and anything noticing is measured in hours, which is
        # exactly when a now() window sweeps in incidents from a different take.
        seen: dict[str, object] = {}
        service = client.app.state.record_service
        original = service._schedule_settlement

        def spy(capture, **kwargs):
            seen.update(kwargs)
            return original(capture, **kwargs)

        monkeypatch.setattr(service, "_schedule_settlement", spy)

        started = _start(client)
        _recorder_hits_its_cap(fake_recorder)
        # The recorder has moved on, and its live answers now disagree with the
        # sidecar this capture sealed. Whichever of the two the settlement read
        # is therefore visible in the result.
        fake_recorder.integrity = "dropped"
        fake_recorder.final_error = None

        _one_periodic_pass(client)

        assert seen.get("stop_ns") == SEALED_ENDED_NS, (
            "the pass windowed incidents on wall-clock now() rather than on when "
            "this recording ended; unattended, that is hours of another take's "
            "incidents reported as this one's"
        )
        capture = _store(client).get_capture(started["capture_id"])
        assert capture is not None
        assert capture.quick_check is not None
        assert capture.quick_check.layer0.integrity == "ok"
        assert capture.quick_check.layer0.backstop == CAP_NOTE


def test_a_capture_with_no_terminal_manifest_is_still_just_interrupted(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    # The other half of `_interrupt_all`, unchanged: nothing sealed this bag and
    # nothing ever will. There is no recording to settle a verdict about, and
    # inventing one would be the fabrication this whole file is about.
    fake_recorder.writes_sidecars = False
    started = _start(client)
    # The recorder was restarted and has no memory of the session, so it no
    # longer names this capture. Without that the status poll correlates the
    # two and takes the stop() path, which is a different route entirely.
    fake_recorder.state = "idle"
    fake_recorder.capture_id = None

    client.get("/api/v1/record/status")
    _await_settlement(client)

    capture = _store(client).get_capture(started["capture_id"])
    assert capture is not None
    assert capture.state == CaptureState.interrupted
    assert capture.error is not None
    assert capture.error.code == "interrupted"
    assert capture.quick_check is None


def test_a_row_the_recorder_is_actively_recording_is_left_alone(
    client: TestClient, fake_recorder: FakeRecorder, data_dir: Path
) -> None:
    # The skip at the top of `_interrupt_all`: a live row the recorder confirms
    # must be neither interrupted nor settled — it has not ended.
    #
    # Reached through the START route on purpose. The status poll returns early
    # while the recorder is active and never calls `_interrupt_all` at all, so
    # only a start drives a pass that has something to skip.
    started = _start(client)
    stale = Capture(
        capture_id="01920000-0000-7000-8000-0000000000dd",
        run_id="run_stale",
        state=CaptureState.recording,
        started_at="2026-08-01T00:00:00.000Z",
    )
    _store(client).create_capture(stale)

    refused = client.post("/api/v1/record/start", json={"topics": ["/joint_states"]})
    assert refused.status_code == 409
    _await_settlement(client)

    live = _store(client).get_capture(started["capture_id"])
    assert live is not None
    assert live.state == CaptureState.recording
    assert live.quick_check is None
    # The stale row beside it WAS reconciled, so the pass really ran.
    gone = _store(client).get_capture(stale.capture_id)
    assert gone is not None
    assert gone.state == CaptureState.interrupted
