"""The digest adopts a terminal manifest but never settles — and may not have to.

E-38's rule is that every route which adopts a terminal manifest also schedules
the quick check, because nothing re-settles a capture later: one adopted without
a verdict has none for good. ``DigestJob._run`` adopts (``digest.py``, right
after the manifest is sealed) and does *not* settle, which reads like a sixth
unsettled route beside the five in ``test_reconcile_settlement.py``.

It is not one, and the reason is a single guard: ``_run`` refuses any capture
whose row is not already in a terminal state. Whatever put the row there —
``stop()``, ``_interrupt_all`` or the reconciliation pass — settled it on the
way through, so the digest only ever meets captures that have already been past
a settling route.

That makes the guard load-bearing for a reason nothing near it mentions, which
is what this test exists to say. Relax it and the digest becomes the first
adopter of a capped recording; the row then matches its manifest, the
reconciler's ``_facts_diverge`` scan stops offering the capture as settleable,
and the verdict is lost permanently — with no other test failing.
"""

from __future__ import annotations

from api_orchestrator.captures import CaptureService
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from test_reconcile_settlement import (
    _assert_settled,
    _await_settlement,
    _one_periodic_pass,
    _recorder_hits_its_cap,
    _start,
    _store,
)


def _spy_on_adoption(monkeypatch) -> list[str]:
    """Record every capture the digest tries to adopt facts for."""
    adopted: list[str] = []
    real = CaptureService.adopt_manifest_facts

    def spy(self, capture_id):
        adopted.append(capture_id)
        return real(self, capture_id)

    monkeypatch.setattr(CaptureService, "adopt_manifest_facts", spy)
    return adopted


class TestTheStateGuardIsWhatKeepsItHonest:
    def test_a_row_still_recording_never_reaches_adoption(
        self, client: TestClient, fake_recorder: FakeRecorder, monkeypatch
    ) -> None:
        """The sealed bag is on disk, but the catalog has not caught up yet.

        This is the window in which the digest could become the first adopter:
        the recorder capped itself and wrote a terminal manifest, and no route
        has reconciled the row. The guard has to refuse here.
        """
        started = _start(client)
        capture_id = started["capture_id"]
        _recorder_hits_its_cap(fake_recorder)
        adopted = _spy_on_adoption(monkeypatch)

        row = _store(client).get_capture(capture_id)
        assert str(row.state) == "recording", (
            "the row was already reconciled, so this no longer tests the "
            "window the guard exists for"
        )

        outcome = _run_digest(client, capture_id)

        # The consequence first, so a regression reports what it costs rather
        # than which flag changed.
        assert adopted == [], (
            "the digest adopted a terminal manifest before any settling route "
            "had seen the capture; that is E-38's sixth route, and the verdict "
            "is now lost for good — the reconciler will not offer a row that "
            "already matches its manifest as settleable again"
        )
        assert _store(client).get_capture(capture_id).quick_check is None
        assert outcome.completed is False
        # Names the guard that did the refusing: the entry check, not the
        # re-check under the lease. Losing the entry check alone still fails
        # here, which is the point — the second one is a lease guard and was
        # never meant to be what keeps this job off an unsettled capture.
        assert outcome.reason == "state is recording"

    def test_once_a_settling_route_has_been_through_the_digest_adopts(
        self, client: TestClient, fake_recorder: FakeRecorder, monkeypatch
    ) -> None:
        """The positive control: the refusal above is the guard, not a dead job.

        Without this, the assertion that nothing was adopted would also pass if
        the digest had simply stopped working.
        """
        started = _start(client)
        capture_id = started["capture_id"]
        _recorder_hits_its_cap(fake_recorder)

        # The periodic pass is the route that reaches an unattended cap first.
        # It adopts AND settles, which is what earns the digest its guard.
        _one_periodic_pass(client)
        _assert_settled(client, capture_id)

        adopted = _spy_on_adoption(monkeypatch)
        outcome = _run_digest(client, capture_id)

        assert outcome.completed is True, outcome.reason
        assert adopted == [capture_id], (
            "the digest no longer refreshes the manifest's facts; a capture "
            "whose counters the catalog never learned would be verified while "
            "the UI still calls it empty"
        )


def test_a_capture_reconciled_by_a_status_poll_is_settled_before_the_digest(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    """The ordering the guard depends on, stated as an ordering.

    ``stop()`` schedules the settlement and only then queues the digest, so the
    verdict is never waiting on bytes being hashed.
    """
    started = _start(client)
    capture_id = started["capture_id"]
    _recorder_hits_its_cap(fake_recorder)

    client.get("/api/v1/record/status")
    _await_settlement(client)

    settled = _store(client).get_capture(capture_id)
    assert settled.quick_check is not None
    assert str(settled.state) in ("completed", "interrupted")

    outcome = _run_digest(client, capture_id)
    assert outcome.completed is True, outcome.reason
    # The digest did not disturb the verdict it found.
    after = _store(client).get_capture(capture_id)
    assert after.quick_check == settled.quick_check


def _run_digest(client: TestClient, capture_id: str):
    import asyncio

    return asyncio.run(client.app.state.digest_job.run(capture_id))
