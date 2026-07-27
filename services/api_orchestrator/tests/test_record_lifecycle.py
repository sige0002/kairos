"""Run lifecycle: created -> recording -> completed, and failure handling."""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import httpx
from api_orchestrator.models import RecordStartRequest, Run, RunState
from api_orchestrator.recorder_client import RecorderClient
from api_orchestrator.runs import RunService
from api_orchestrator.store import RunStore
from conftest import FakeRecorder
from fastapi.testclient import TestClient


def test_start_records_and_syncs_topics(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    """A successful start lands in ``recording`` with synced topics/QoS."""
    resp = client.post(
        "/api/v1/record/start",
        json={"topics": ["/joint_states"], "compression": "none"},
    )
    assert resp.status_code == 200
    run = resp.json()

    assert run["run_id"].startswith("run_")
    assert run["state"] == "recording"
    assert run["error"] is None
    # Topic names + QoS sync from the recorder manifest at start; the per-topic
    # type is not yet resolved (filled in after finalize), so it is blank here.
    assert [t["name"] for t in run["topics"]] == ["/joint_states"]
    assert run["topics"][0]["qos"]["reliability"] == "reliable"
    assert run["topics"][0]["type"] == ""
    # The recorder was handed the orchestrator-allocated run_id.
    assert fake_recorder.last_start_payload["run_id"] == run["run_id"]


def test_start_adopts_recorder_started_at(
    client: TestClient, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    """The row's ``started_at`` is the recorder's actual-capture stamp.

    The orchestrator allocates the row (with its own stamp) BEFORE calling the
    recorder, whose start blocks through start_delay/spawn/arming — seconds in
    which no data is captured. The recorder re-stamps at capture start and the
    orchestrator must adopt that value, or the UI elapsed timer starts ahead.
    """
    run = client.post("/api/v1/record/start", json={"topics": ["/tf"]}).json()
    assert run["started_at"] == fake_recorder.started_at
    assert store.get(run["run_id"]).started_at == fake_recorder.started_at


def test_start_all_expands_via_recorder(client: TestClient) -> None:
    """``topics:"all"`` is expanded by the recorder and synced into the row."""
    resp = client.post("/api/v1/record/start", json={"topics": "all"})
    assert resp.status_code == 200
    names = [t["name"] for t in resp.json()["topics"]]
    assert names == ["/joint_states", "/tf"]


def test_full_lifecycle_created_recording_completed(
    client: TestClient, store: RunStore
) -> None:
    """start -> recording, then stop -> completed with final counters.

    Regression guard: after a real record->stop the completed run row must
    reflect reality (topics with types, message_count, bytes) parsed from the
    recorder's nested metadata (manifest + finalized rosbag2_metadata), not the
    empty/null values the old flat-shape parser produced.
    """
    started = client.post("/api/v1/record/start", json={"topics": ["/tf"]}).json()
    run_id = started["run_id"]

    # The row exists and is recording.
    assert store.get(run_id).state.value == "recording"

    stopped = client.post("/api/v1/record/stop").json()
    assert stopped["run_id"] == run_id
    assert stopped["state"] == "completed"
    assert stopped["ended_at"] is not None
    # Final counters come from rosbag2_metadata (message_count + sum(files.size)).
    assert stopped["message_count"] == 1234
    assert stopped["bytes"] == 567890
    # Topics are populated with their resolved type (filled in post-finalize).
    assert [t["name"] for t in stopped["topics"]] == ["/tf"]
    assert stopped["topics"][0]["type"] == "sensor_msgs/msg/JointState"
    assert stopped["topics"][0]["qos"]["reliability"] == "reliable"

    # And the persisted row (source of truth) matches what the API returned.
    persisted = store.get(run_id)
    assert persisted.message_count == 1234
    assert persisted.bytes == 567890
    assert persisted.topics[0].type == "sensor_msgs/msg/JointState"


def test_recorder_failure_keeps_row_and_sets_failed(
    client: TestClient, fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """A recorder rejection keeps the run row and marks it ``failed``."""
    fake_recorder.start_status = 507
    fake_recorder.start_error = {
        "code": "no_space",
        "message": "Insufficient disk space.",
    }

    resp = client.post("/api/v1/record/start", json={"topics": ["/tf"]})
    assert resp.status_code == 200
    run = resp.json()

    assert run["state"] == "failed"
    assert run["error"]["code"] == "no_space"
    # The row is NOT deleted (spec: keep the row, record the reason).
    persisted = store.get(run["run_id"])
    assert persisted is not None
    assert persisted.state.value == "failed"


def test_recorder_unreachable_sets_failed(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    """If the recorder transport fails, the run is recorded as ``failed``."""
    fake_recorder.transport_down = True
    resp = client.post("/api/v1/record/start", json={"topics": ["/tf"]})
    assert resp.status_code == 200
    run = resp.json()
    assert run["state"] == "failed"
    assert run["error"]["code"] == "recorder_unreachable"


def test_stop_with_no_runs_at_all_is_404(client: TestClient) -> None:
    """Stop is idempotent; with no run ever recorded there is nothing to report."""
    resp = client.post("/api/v1/record/stop")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "no_runs"


def test_stop_is_idempotent_returns_last_run(client: TestClient) -> None:
    """A second stop (nothing active) returns the last run's state, not an error."""
    started = client.post("/api/v1/record/start", json={"topics": ["/tf"]}).json()
    first = client.post("/api/v1/record/stop").json()
    assert first["state"] == "completed"

    # Stopping again with nothing active is a no-op: 200 with the same run.
    second = client.post("/api/v1/record/stop")
    assert second.status_code == 200
    body = second.json()
    assert body["run_id"] == started["run_id"]
    assert body["state"] == "completed"


def test_stop_stops_a_recording_the_store_lost_track_of(
    client: TestClient, fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """A Stop must STOP, even when no row claims to be recording.

    Regression: the idempotent branch returned the last run whenever no row was
    active, so a recorder still holding a bag (row missing/in the wrong state)
    answered the operator's Stop with SUCCESS while it kept writing. The console
    then walked on to labelling a take that was still recording, and only the
    MAX_RECORD_SECONDS backstop ever ended it.
    """
    started = client.post("/api/v1/record/start", json={"topics": ["/tf"]}).json()
    run_id = started["run_id"]
    # Drift the DB away from reality: the row is no longer 'recording', but the
    # recorder still is (what a lost/raced row looks like from here).
    store.update(run_id, state=RunState.created)
    assert fake_recorder.state == "recording"

    resp = client.post("/api/v1/record/stop")

    assert resp.status_code == 200
    assert fake_recorder.state != "recording", "the recorder must actually be stopped"
    body = resp.json()
    assert body["run_id"] == run_id
    assert body["state"] == "completed"


def test_stop_stops_an_orphan_recording_with_no_row_at_all(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    """The recorder is recording a run this orchestrator has never seen.

    There is nothing to finalize, but leaving it running would be the same
    silent failure — so it is stopped, and the response stays the idempotent
    last-run answer.
    """
    client.post("/api/v1/record/start", json={"topics": ["/tf"]})
    client.post("/api/v1/record/stop")
    # A recording appears that belongs to no row (another client, a restart...).
    fake_recorder.state = "recording"
    fake_recorder.run_id = "run_not_in_this_store"

    resp = client.post("/api/v1/record/stop")

    assert resp.status_code == 200
    assert fake_recorder.state != "recording"


def test_start_omitted_topics_without_defaults_is_400(client: TestClient) -> None:
    """Omitting topics with no default_topics configured is a clear 400."""
    resp = client.post("/api/v1/record/start", json={})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "no_default_topics"


def test_metadata_sync_failure_keeps_recording_with_error(
    client: TestClient, fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """If post-start metadata sync fails, stay ``recording`` and note the error."""
    fake_recorder.metadata_status = 503
    resp = client.post("/api/v1/record/start", json={"topics": ["/tf"]})
    assert resp.status_code == 200
    run = resp.json()
    assert run["state"] == "recording"
    assert run["error"]["code"] == "metadata_sync_failed"


def test_stop_reflects_recorder_failed_state(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    """If the recorder finished ``failed``, the run row must be ``failed``.

    The orchestrator must not assume ``completed`` on stop; it reads the
    recorder's real terminal state (manifest.state/error).
    """
    fake_recorder.final_state = "failed"
    fake_recorder.final_error = {"code": "disk_full", "message": "No space left."}

    client.post("/api/v1/record/start", json={"topics": ["/tf"]})
    stopped = client.post("/api/v1/record/stop").json()

    assert stopped["state"] == "failed"
    assert stopped["error"]["code"] == "disk_full"
    assert stopped["ended_at"] is not None


def test_stop_reflects_recorder_interrupted_state(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    """If the recorder finished ``interrupted``, the run row must be ``interrupted``."""
    fake_recorder.final_state = "interrupted"

    client.post("/api/v1/record/start", json={"topics": ["/tf"]})
    stopped = client.post("/api/v1/record/stop").json()

    assert stopped["state"] == "interrupted"


def test_run_id_collision_appends_suffix_no_500(
    client: TestClient, store: RunStore
) -> None:
    """A same-second run_id collision retries with a suffix instead of 500.

    ``allocate_run_id`` is second-precision; pre-seed a row with the id it will
    produce, then assert start still succeeds with a distinct, suffixed id.
    """
    colliding = "run_20260624_000000"
    with patch("api_orchestrator.runs.allocate_run_id", return_value=colliding):
        # Pre-seed the colliding id, then start: it must allocate a new one.
        store.create(Run(run_id=colliding, state=RunState.completed))

        resp = client.post("/api/v1/record/start", json={"topics": ["/tf"]})

    assert resp.status_code == 200
    run = resp.json()
    # New row is distinct (suffix appended) and recording — no IntegrityError/500.
    assert run["run_id"] != colliding
    assert run["run_id"].startswith(f"{colliding}_")
    assert run["state"] == "recording"


def test_recorder_409_passes_through_not_503(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    """A recorder 409 (e.g. already recording) surfaces as 409, not a 503.

    Genuine recorder client-errors keep their own status/code instead of being
    masked as 'recorder unavailable'. Start keeps the row as ``failed``.
    """
    fake_recorder.start_status = 409
    fake_recorder.start_error = {"code": "already_recording", "message": "busy"}

    resp = client.post("/api/v1/record/start", json={"topics": ["/tf"]})
    # The start endpoint records the failure on the run (200 with failed row),
    # but the recorder's 409 code is preserved (not remapped to unavailable).
    assert resp.status_code == 200
    assert resp.json()["state"] == "failed"
    assert resp.json()["error"]["code"] == "already_recording"


def test_start_reconciles_stale_run_when_recorder_idle(
    client: TestClient, fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """A stale ``recording`` DB row with an idle recorder must not block start.

    Reproduces the E2E "stuck forever" bug: a crash left a ``recording`` row and
    startup reconciliation was skipped (recorder was unreachable at boot). With
    the recorder now idle, start verifies the real state, reconciles the stale
    run to ``interrupted``, and proceeds — no 409.
    """
    stale = "run_20200101_000000"
    store.create(Run(run_id=stale, state=RunState.recording))
    assert fake_recorder.state == "idle"  # recorder has no active session

    resp = client.post("/api/v1/record/start", json={"topics": ["/tf"]})

    assert resp.status_code == 200
    assert resp.json()["state"] == "recording"
    assert resp.json()["run_id"] != stale
    # The stale row was reconciled, not left blocking forever.
    assert store.get(stale).state.value == "interrupted"


def test_start_409_when_recorder_genuinely_recording(
    client: TestClient, fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """If the recorder confirms an active session, start is a real 409.

    The DB's active run matches a genuinely-recording recorder, so a second
    start must be rejected (single-session) — and the active run is left alone.
    """
    active = "run_20260624_120000"
    store.create(Run(run_id=active, state=RunState.recording))
    fake_recorder.state = "recording"
    fake_recorder.run_id = active

    resp = client.post("/api/v1/record/start", json={"topics": ["/tf"]})

    assert resp.status_code == 409
    body = resp.json()
    assert body["error"]["code"] == "already_recording"
    assert body["error"]["details"]["run_id"] == active
    # The genuinely-active run is untouched.
    assert store.get(active).state.value == "recording"


def test_start_503_when_stale_run_and_recorder_unreachable(
    client: TestClient, fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """With a stale active row and an unreachable recorder, start is a safe 503.

    We cannot verify the recorder's real state, so we must not risk a second
    concurrent session; the stale row is left for a later (reachable) reconcile.
    """
    stale = "run_20200101_000000"
    store.create(Run(run_id=stale, state=RunState.recording))
    fake_recorder.transport_down = True

    resp = client.post("/api/v1/record/start", json={"topics": ["/tf"]})

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "recorder_unreachable"
    # Stale row untouched (a later start/startup with the recorder up fixes it).
    assert store.get(stale).state.value == "recording"


class _SpyHub:
    """Records every publish() so we can assert record_status emission."""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    async def publish(self, event_type: str, data: dict) -> None:
        self.events.append((event_type, data))


def test_lifecycle_emits_record_status_events(
    fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """start() and stop() must publish record_status SSE events.

    Regression: ``_emit_record_status`` was defined but never called, so the
    frontend record_status handler was dead and the Live hero only saw 5s polls.
    """
    hub = _SpyHub()

    async def run_it() -> None:
        http_client = httpx.AsyncClient(
            transport=httpx.MockTransport(fake_recorder.handler)
        )
        recorder = RecorderClient("http://recorder", http_client)
        svc = RunService(store, recorder, recording_config=None, event_hub=hub)
        await svc.start(RecordStartRequest(topics=["/tf"]))
        await svc.stop()
        # stop() settles the quick check off-path as a background task; drain it
        # so it doesn't dangle when asyncio.run closes the loop.
        await svc.drain_settlements()
        await http_client.aclose()

    asyncio.run(run_it())

    states = [d["state"] for (et, d) in hub.events if et == "record_status"]
    assert "recording" in states  # emitted on start
    assert "stopping" in states  # emitted on stop entry
    assert states[-1] in {"completed", "failed", "interrupted"}  # terminal


def test_record_status_event_carries_arming_when_start_paused(
    fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """With start_paused, start()'s record_status event passes arming through.

    The recorder reports an arming snapshot on /record/status (OL-①.4); the
    orchestrator fetches it (guarded by config.start_paused) and emits it
    additively on the ``recording`` record_status event for the Live UI.
    """
    from kairos_common import RecordingConfig, RecordingTuning

    hub = _SpyHub()
    fake_recorder.arming = {
        "active": False,
        "matched_topics": ["/tf"],
        "missing_topics": [],
        "resume_at": "2026-06-27T00:00:00.000Z",
    }
    cfg = RecordingConfig(robot_name="t", recording=RecordingTuning(start_paused=True))

    async def run_it() -> None:
        http_client = httpx.AsyncClient(
            transport=httpx.MockTransport(fake_recorder.handler)
        )
        recorder = RecorderClient("http://recorder", http_client)
        svc = RunService(store, recorder, recording_config=cfg, event_hub=hub)
        await svc.start(RecordStartRequest(topics=["/tf"]))
        await http_client.aclose()

    asyncio.run(run_it())

    recording = [
        d
        for (et, d) in hub.events
        if et == "record_status" and d["state"] == "recording"
    ]
    assert recording, "a recording record_status event must be emitted"
    arming = recording[-1].get("arming")
    assert arming is not None
    assert arming["matched_topics"] == ["/tf"]
    assert arming["missing_topics"] == []
    assert arming["resume_at"] == "2026-06-27T00:00:00.000Z"


def test_record_status_event_omits_arming_without_start_paused(
    fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """Without start_paused, no extra status fetch happens and arming is omitted."""
    hub = _SpyHub()
    # Even if the recorder *would* report arming, it must not be fetched/emitted
    # when start_paused is off (no config -> guard short-circuits).
    fake_recorder.arming = {"active": True, "matched_topics": [], "missing_topics": []}

    async def run_it() -> None:
        http_client = httpx.AsyncClient(
            transport=httpx.MockTransport(fake_recorder.handler)
        )
        recorder = RecorderClient("http://recorder", http_client)
        svc = RunService(store, recorder, recording_config=None, event_hub=hub)
        await svc.start(RecordStartRequest(topics=["/tf"]))
        await http_client.aclose()

    asyncio.run(run_it())

    recording = [
        d
        for (et, d) in hub.events
        if et == "record_status" and d["state"] == "recording"
    ]
    assert recording
    assert "arming" not in recording[-1]


def test_status_finalizes_recorder_auto_stopped_run(
    client: TestClient, fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """The status poll finalizes a run the recorder stopped on its own.

    A MAX_RECORD_BYTES auto-stop happens INSIDE the recorder (no
    POST /record/stop through the orchestrator), so the DB row stays
    ``recording``. The next GET /record/status — the UI polls it every few
    seconds — must lazily finalize the run through the normal stop path
    (metadata sync, COMPLETED, not interrupted-at-next-restart).
    """
    run_id = "run_20260714_000001"
    store.create(Run(run_id=run_id, state=RunState.recording))
    # The recorder auto-stopped this very session: terminal state, finalized bag.
    fake_recorder.run_id = run_id
    fake_recorder.state = "completed"
    fake_recorder.finalized = True
    fake_recorder.message_count = 4321
    fake_recorder.bytes = 999

    resp = client.get("/api/v1/record/status")

    assert resp.status_code == 200
    run = store.get(run_id)
    assert run.state.value == "completed"
    assert run.ended_at is not None


def test_status_interrupts_run_unknown_to_recorder(
    client: TestClient, fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """The status poll reconciles a live DB run the recorder has no session for."""
    stale = "run_20200101_000000"
    store.create(Run(run_id=stale, state=RunState.recording))
    assert fake_recorder.state == "idle"

    resp = client.get("/api/v1/record/status")

    assert resp.status_code == 200
    assert store.get(stale).state.value == "interrupted"


def test_status_leaves_genuine_recording_alone(
    client: TestClient, fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """A genuinely-active recording is never touched by the lazy reconcile."""
    active = "run_20260714_000002"
    store.create(Run(run_id=active, state=RunState.recording))
    fake_recorder.state = "recording"
    fake_recorder.run_id = active

    resp = client.get("/api/v1/record/status")

    assert resp.status_code == 200
    assert store.get(active).state.value == "recording"
