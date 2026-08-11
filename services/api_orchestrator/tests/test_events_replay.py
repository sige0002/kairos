"""EventHub replay/resync decisions (``_replay_since`` + overflow gaps).

The contract (api_orchestrator.md): a reconnecting client whose
``Last-Event-ID`` names a position the hub cannot vouch for MUST get a
``resync`` sentinel, because it will otherwise keep every stale cache
silently. The restart case (found 2026-08-12 by editing a config while
restarting the orchestrator) is covered by seeding the id counter from
wall-clock milliseconds: a previous boot's id can never be mistaken for a
position in this boot's ring, even after the new process gets busy.
"""

from __future__ import annotations

import asyncio

from api_orchestrator.events import EventHub


def _hub() -> EventHub:
    # The monitor client is only used by the background bridge tasks, which
    # these tests never start.
    return EventHub(monitor=None)  # type: ignore[arg-type]


def _publish(hub: EventHub, n: int) -> None:
    async def go() -> None:
        for i in range(n):
            await hub.publish("record_status", {"seq": i})

    asyncio.run(go())


def _kinds(events: list) -> list[str]:
    return [e.event for e in events]


def test_first_connect_gets_no_replay() -> None:
    hub = _hub()
    _publish(hub, 3)
    assert hub._replay_since(None) == []


def test_in_range_replays_the_tail() -> None:
    hub = _hub()
    base = hub._next_id - 1  # highest id "already seen" before publishing
    _publish(hub, 5)
    replay = hub._replay_since(base + 2)
    assert _kinds(replay) == ["record_status"] * 3
    assert [e.id for e in replay] == [base + 3, base + 4, base + 5]


def test_caught_up_client_replays_nothing() -> None:
    hub = _hub()
    base = hub._next_id - 1
    _publish(hub, 5)
    assert hub._replay_since(base + 5) == []


def test_id_older_than_the_ring_resyncs() -> None:
    hub = _hub()
    base = hub._next_id - 1
    _publish(hub, 3)
    hub._ring.popleft()  # base+1 fell out of the buffer
    hub._ring.popleft()  # base+2 too — a client at base+1 now has a hole
    assert _kinds(hub._replay_since(base + 1)) == ["resync"]


def test_restart_empty_ring_resyncs() -> None:
    """The restart shape: fresh process (no events yet), old browser id.

    A previous boot's id is far below this boot's millisecond-seeded counter,
    so it can never look caught-up.
    """
    hub = _hub()
    old_boot_id = hub._next_id - 1_000_000  # what an earlier boot issued
    assert _kinds(hub._replay_since(old_boot_id)) == ["resync"]


def test_restart_after_new_events_resyncs() -> None:
    """A browser reconnects after the fresh process already published a lot.

    This is the id-generation collision: with a counter restarting at 1, a
    busy new process would eventually cover the old browser's id and hand it
    ANOTHER PROCESS's events as a normal tail. The millisecond seed keeps the
    old id below this boot's ring, which is a resync.
    """
    hub = _hub()
    old_boot_id = hub._next_id - 1_000_000
    _publish(hub, 100)
    assert _kinds(hub._replay_since(old_boot_id)) == ["resync"]


def test_id_ahead_of_issued_resyncs() -> None:
    """An id this process never issued (clock stepped back across a restart)."""
    hub = _hub()
    _publish(hub, 3)
    assert _kinds(hub._replay_since(hub._next_id + 10)) == ["resync"]


def test_quiet_age_out_does_not_force_a_refetch() -> None:
    """Same process, ring emptied by age, client fully caught up: no resync."""
    hub = _hub()
    base = hub._next_id - 1
    _publish(hub, 4)
    hub._ring.clear()  # everything aged out; nothing was missed
    assert hub._replay_since(base + 4) == []


def test_age_out_with_missed_events_resyncs() -> None:
    """Ring emptied by age but the client was BEHIND: its gap is gone."""
    hub = _hub()
    base = hub._next_id - 1
    _publish(hub, 4)
    hub._ring.clear()
    assert _kinds(hub._replay_since(base + 2)) == ["resync"]


def test_overflowed_subscriber_gets_a_resync_before_its_next_event() -> None:
    """A slow client whose queue dropped events must be told to refetch.

    The queue keeps flowing (drop-oldest), but the delivery stream owes the
    client a ``resync`` because events vanished without an id gap.
    """
    hub = _hub()

    async def go() -> list:
        received: list = []

        async def consume() -> None:
            async for event in hub.subscribe():
                received.append(event)
                if len(received) >= 3:
                    break

        task = asyncio.create_task(consume())
        await asyncio.sleep(0)  # let the subscriber register its queue
        queue = next(iter(hub._subscribers))
        # Fill the queue beyond capacity without draining it.
        for i in range(queue.maxsize + 5):
            await hub.publish("record_status", {"seq": i})
        assert hub._gapped, "overflow should mark the queue gapped"
        await asyncio.wait_for(task, timeout=5)
        return received

    received = asyncio.run(go())
    # The very first delivery after the overflow is the resync sentinel.
    assert received[0].event == "resync"
    assert received[0].data == {"reason": "subscriber overflow"}
    assert [e.event for e in received[1:]] == ["record_status"] * 2
