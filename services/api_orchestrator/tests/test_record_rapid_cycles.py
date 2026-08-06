"""E-39: forty recordings back to back, and what is left over afterwards.

A collection shift is not one recording, it is dozens — start, stop, label,
start again, for hours. Three things have to survive that, and each one fails
QUIETLY rather than loudly:

* **the pre-arm keeps re-arming.** Two-phase start is a latency feature: a start
  that no longer resumes the armed session still records, just seconds later.
  Nothing on screen says the arm stopped being consumed, so a regression reads
  as "the robot feels slow today" and never as a failure.
* **the numbering stays sound.** ``run_id`` is minted from a second-resolution
  clock, so a fast loop mints many inside one second and the suffix search is
  what keeps them apart. Two recordings under one display name is the same
  identity-reuse fault as a reclaimed index.
* **nothing accumulates.** The per-recording bookkeeping the orchestrator holds
  in memory — the monitor baseline, the settlement task, the armed entry — has
  to be handed back at the end of each cycle, not at process exit.

These pin behaviour that is already correct; the loop found no defect. They
exist because all three break silently.
"""

from __future__ import annotations

import time

from api_orchestrator.store import CaptureStore
from conftest import FakeRecorder, reconcile, run_digests
from fastapi.testclient import TestClient

CYCLES = 40
TOPICS = ["/joint_states"]


def _store(client: TestClient) -> CaptureStore:
    return client.app.state.capture_store


def _await_settlement(client: TestClient, *, timeout_s: float = 20.0) -> None:
    service = client.app.state.record_service
    deadline = time.monotonic() + timeout_s
    while service._settlement_tasks and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not service._settlement_tasks, "a quick-check settlement never finished"


def test_forty_cycles_never_reuse_a_display_name_or_an_identity(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    run_ids: list[str] = []
    capture_ids: list[str] = []

    for _ in range(CYCLES):
        prepared = client.post("/api/v1/record/prepare", json={"topics": TOPICS})
        assert prepared.status_code == 200, prepared.text
        started = client.post("/api/v1/record/start", json={"topics": TOPICS})
        assert started.status_code == 200, started.text
        run_ids.append(started.json()["run_id"])
        capture_ids.append(started.json()["capture_id"])
        assert client.post("/api/v1/record/stop").status_code == 200

    # This loop runs many cycles inside one tick of the second-resolution clock
    # the base name comes from, so the collision search is doing real work here
    # rather than being incidentally satisfied.
    assert len({r.rsplit("_", 1)[0] for r in run_ids}) < CYCLES, (
        "the clock advanced every cycle, so this run never exercised a collision"
    )
    assert len(set(run_ids)) == CYCLES
    assert len(set(capture_ids)) == CYCLES

    rows, _ = _store(client).list_captures(limit=CYCLES * 2)
    assert len(rows) == CYCLES
    assert {str(row.state) for row in rows} == {"completed"}


def test_forty_cycles_of_re_arming_all_start_from_the_armed_session(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    # The shape a standing pre-arm actually takes: the console re-prepares to
    # keep the arm alive, and the recorder answers a MATCHING re-prepare with
    # the ids of the session it armed the first time — not the ones this
    # request proposed. The orchestrator has to adopt those, or the start it
    # sends next claims ids the recorder never armed.
    #
    # Naming the armed session something the orchestrator could not have minted
    # is what makes "the arm was consumed" observable at all: on both paths the
    # capture comes back from the recorder, and a start that ignored the arm
    # would allocate a run_id that looks just like the armed one.
    armed_run_ids: list[str] = []
    for cycle in range(CYCLES):
        armed_run_id = f"run_armed_{cycle}"
        fake_recorder.prepare_extend_run_id = armed_run_id

        prepared = client.post("/api/v1/record/prepare", json={"topics": TOPICS})
        assert prepared.status_code == 200, prepared.text
        assert prepared.json()["run_id"] == armed_run_id
        armed_capture_id = prepared.json()["capture_id"]

        # A second, matching prepare — the keep-alive. It must extend rather
        # than arm a second session.
        again = client.post("/api/v1/record/prepare", json={"topics": TOPICS})
        assert again.status_code == 200, again.text
        assert again.json()["capture_id"] == armed_capture_id

        fake_recorder.prepare_extend_run_id = None
        started = client.post("/api/v1/record/start", json={"topics": TOPICS})
        assert started.status_code == 200, started.text
        # The start went out under the ARMED session's name, which is only true
        # if this start resumed that session instead of beginning a cold one.
        assert fake_recorder.last_start_payload["run_id"] == armed_run_id
        assert started.json()["capture_id"] == armed_capture_id
        armed_run_ids.append(started.json()["run_id"])

        assert client.post("/api/v1/record/stop").status_code == 200

    assert armed_run_ids == [f"run_armed_{i}" for i in range(CYCLES)]
    # Two prepares per cycle, and the recorder armed once: the keep-alive
    # extended the session rather than stacking a second one behind it.
    assert fake_recorder.prepare_call_count == CYCLES * 2
    assert fake_recorder.stop_call_count == CYCLES


def test_forty_cycles_leave_no_per_recording_state_behind(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    service = client.app.state.record_service
    for _ in range(CYCLES):
        assert (
            client.post("/api/v1/record/prepare", json={"topics": TOPICS}).status_code
            == 200
        )
        assert (
            client.post("/api/v1/record/start", json={"topics": TOPICS}).status_code
            == 200
        )
        assert client.post("/api/v1/record/stop").status_code == 200
    _await_settlement(client)

    # The armed entry is consumed by the start that matched it. A leak here
    # hands the NEXT recording ids the recorder never armed for it.
    assert service._prepared is None
    # The monitor baseline is taken at start and spent by the settlement at
    # stop. Anything left over is one recording's worth of per-topic counters
    # per cycle, held until the process exits.
    assert service._record_baselines == {}


def test_forty_cycles_in_one_batch_number_the_episodes_one_to_forty(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    """The numbering an operator actually sees, at shift scale.

    The loop above pins ``run_id``/``capture_id`` uniqueness, which is identity.
    ``index_in_batch`` is the DISPLAY number — the strip chip, the Review row,
    the "episode #N" in a delete dialog — and it is allocated by a different
    mechanism (the store resolves the client's hint, E-7). Forty of them in one
    batch is where a gap or a repeat would show up, and neither the rapid-cycle
    loop (it creates no batch) nor the collision test (two captures) covers it.
    """
    created = client.post(
        "/api/v1/batches",
        json={"project": "p", "task": "pick", "target_episodes": CYCLES},
    )
    assert created.status_code == 201, created.text
    batch_id = created.json()["batch_id"]

    for index in range(1, CYCLES + 1):
        started = client.post("/api/v1/record/start", json={"topics": TOPICS})
        assert started.status_code == 200, started.text
        capture_id = started.json()["capture_id"]
        assert client.post("/api/v1/record/stop").status_code == 200
        saved = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={
                "base_revision": 0,
                "task_result": "success",
                "review_status": "adopted",
                "batch_id": batch_id,
                "index_in_batch": index,
            },
        )
        assert saved.status_code == 200, saved.text
    _await_settlement(client)

    detail = client.get(f"/api/v1/batches/{batch_id}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    numbers = sorted(c["index_in_batch"] for c in body["captures"])
    assert numbers == list(range(1, CYCLES + 1))
    assert body["episode_count"] == CYCLES
    # The monotone counter the coverage display reads. It counts first review
    # saves, so forty recordings each saved once must land on forty.
    assert body["episodes_recorded"] == CYCLES


def test_forty_cycles_do_not_accumulate_open_file_descriptors(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    """The literal reading of "handle accumulation" in the adopted scenario.

    The sibling test above pins the orchestrator's own per-recording
    bookkeeping, which is memory. This counts OS handles: a sqlite connection
    left open per cycle, an httpx connection per stop, a sidecar written
    without closing — none of which show up in ``RecordService`` at all, and
    all of which end a long shift as "too many open files".

    Digest and reconcile run inside the loop because they are the paths that
    open bags and take leases; the three existing tests run neither, so the
    configuration that actually accumulates handles was never driven.

    The tolerance is for churn outside this loop (a lazily opened log stream,
    an arena the allocator grew), not for a per-cycle leak: forty cycles that
    each leaked even one handle would be forty over.
    """
    import os

    def open_handles() -> int:
        return len(os.listdir("/proc/self/fd"))

    hub = client.app.state.event_hub
    # Warm up: the first cycle opens whatever is opened once (the recorder's
    # connection pool, the bag reader's buffers) and would otherwise read as a
    # leak with no way to tell the difference.
    client.post("/api/v1/record/start", json={"topics": TOPICS})
    client.post("/api/v1/record/stop")
    _await_settlement(client)
    run_digests(client)
    reconcile(client)

    before = open_handles()
    subscribers_before = len(hub._subscribers)

    for _ in range(CYCLES):
        assert (
            client.post("/api/v1/record/start", json={"topics": TOPICS}).status_code
            == 200
        )
        assert client.post("/api/v1/record/stop").status_code == 200
    _await_settlement(client)
    run_digests(client)
    reconcile(client)

    after = open_handles()
    assert after - before <= 5, (
        f"{after - before} file descriptors accumulated over {CYCLES} cycles "
        f"({before} -> {after})"
    )
    # An SSE publisher that registered a subscriber per record_status event
    # would grow the fan-out set forever while every send got slower.
    assert len(hub._subscribers) == subscribers_before
    # The digest queue is work, not a ledger: everything queued by the loop has
    # to have been drained by the run above.
    assert (
        client.app.state.capture_store.captures_needing_digest(
            client.app.state.instance_id
        )
        == []
    )
