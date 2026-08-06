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
from conftest import FakeRecorder
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
