# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The capture lease around a dora_runner job (§7.1).

A job reads ``objects/<capture_id>`` for as long as it runs, and deletion
renames that directory away. The lease is what orders the two: while a job holds
it, discard and delete answer 409 ``capture_busy``; once the orchestrator sees
the job reach a terminal state, the lease goes away and the capture is deletable
again.

dora_runner itself knows nothing about this — it is the orchestrator that owns
both the catalog and the deletion path, so it takes and drops the lease on the
job's behalf. These tests therefore drive the whole thing through the HTTP API,
with a fake dora_runner whose job state the test controls.

The expiry case matters as much as the happy path: a job whose process dies
never releases anything, and a lease that outlived its job must not lock a
capture out of deletion forever. ``store.acquire_lease`` compares against *now*,
so an expired lease is simply not a lease — proven here rather than assumed.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState
from api_orchestrator.routers import jobs as jobs_router
from api_orchestrator.store import CaptureStore
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import Settings
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import ReplicaState

PIPELINE = "loss_report"


class FakeDora:
    """A dora_runner whose job state the test moves by hand.

    Records the created payloads and the cancels, so a test can assert that a
    job which lost the lease race was actually called off rather than left
    running.
    """

    def __init__(self) -> None:
        self.state = "running"
        self.created: list[dict] = []
        self.canceled: list[str] = []
        self.job_capture: dict[str, str] = {}
        self._next = 0
        # Makes GET /jobs/{id}/status fail, so a test can drive the window
        # between "the lease was taken" and "the job row exists".
        self.status_fails = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/healthz":
            return httpx.Response(200, json={"status": "ok"})
        if path == "/jobs" and request.method == "POST":
            payload = json.loads(request.content)
            self.created.append(payload)
            self._next += 1
            job_id = f"job_{self._next}"
            self.job_capture[job_id] = payload["capture_id"]
            return httpx.Response(201, json={"job_id": job_id})
        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "jobs":
            job_id, verb = parts[1], parts[2]
            if verb == "cancel":
                self.canceled.append(job_id)
                self.state = "canceled"
                return httpx.Response(200, json=self._status(job_id))
            if verb == "status":
                if self.status_fails:
                    return httpx.Response(
                        500,
                        json={"error": {"code": "boom", "message": "status exploded"}},
                    )
                return httpx.Response(200, json=self._status(job_id))
            if verb == "result":
                return httpx.Response(
                    200, json={"summary": {"result": "pass"}, "artifacts": []}
                )
        return httpx.Response(404, json={"error": {"code": "nf", "message": path}})

    def _status(self, job_id: str) -> dict:
        return {
            "job_id": job_id,
            "capture_id": self.job_capture.get(job_id, ""),
            "pipeline": PIPELINE,
            "state": self.state,
            "progress": 1.0 if self.state != "running" else 0.5,
            "logs_tail": [],
        }


@pytest.fixture
def dora() -> FakeDora:
    return FakeDora()


@pytest.fixture
def lease_client(
    settings: Settings, fake_recorder: FakeRecorder, dora: FakeDora
) -> Iterator[TestClient]:
    """The app with a fake dora_runner wired in beside the fake recorder."""

    def dispatch(request: httpx.Request) -> httpx.Response:
        if request.url.port == settings.dora_runner_port:
            return dora.handler(request)
        return fake_recorder.handler(request)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(dispatch))
    app = create_orchestrator_app(settings, http_client=http_client)
    with TestClient(app) as test_client:
        yield test_client


def seed_capture(client: TestClient) -> str:
    """A completed capture with bytes on disk, ready to run a job against."""
    store: CaptureStore = client.app.state.capture_store
    layout: DataLayout = client.app.state.capture_service.layout
    capture_id = new_capture_id()
    store.create_capture(
        Capture(
            capture_id=capture_id,
            run_id=f"run_{capture_id[:8]}",
            state=CaptureState.completed,
            operator="alice",
            task="pick",
            started_at="2026-08-01T00:00:00.000Z",
        )
    )
    store.upsert_replica(
        capture_id,
        store.instance_id or "",
        ReplicaState.present_unverified,
        path=str(layout.capture_dir(capture_id)),
    )
    capture_dir = layout.capture_dir(capture_id)
    capture_dir.mkdir(parents=True, exist_ok=True)
    (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
    return capture_id


def submit(client: TestClient, capture_id: str) -> httpx.Response:
    return client.post(
        "/api/v1/jobs",
        json={"capture_id": capture_id, "pipeline": PIPELINE, "params": {}},
    )


# ---- acquire -----------------------------------------------------------------


def test_submitting_a_job_takes_the_lease(lease_client: TestClient) -> None:
    capture_id = seed_capture(lease_client)
    created = submit(lease_client, capture_id)
    assert created.status_code == 201

    store = lease_client.app.state.capture_store
    assert store.has_live_lease(capture_id)
    capture = store.get_capture(capture_id)
    assert capture.lease_owner == f"job:{created.json()['job_id']}"
    assert capture.lease_expires_at is not None


def test_lease_ttl_covers_the_whole_job_budget(monkeypatch) -> None:
    """TTL = the per-job timeout + a margin, which is why nothing renews it.

    Reading the same env var dora_runner reads is deliberate: a TTL derived from
    a different number than the timeout it must outlast would drift the moment a
    deployment tuned one of them.
    """
    monkeypatch.delenv("KAIROS_DORA_JOB_TIMEOUT_S", raising=False)
    assert jobs_router._lease_ttl_s() == 900.0 + jobs_router._LEASE_MARGIN_S

    monkeypatch.setenv("KAIROS_DORA_JOB_TIMEOUT_S", "1800")
    assert jobs_router._lease_ttl_s() == 1800.0 + jobs_router._LEASE_MARGIN_S

    # A garbage value falls back to the default rather than producing a lease
    # that expires while its job is still reading.
    monkeypatch.setenv("KAIROS_DORA_JOB_TIMEOUT_S", "soon")
    assert jobs_router._lease_ttl_s() == 900.0 + jobs_router._LEASE_MARGIN_S


# ---- 409 while held ----------------------------------------------------------


def test_a_second_job_on_a_held_capture_is_accepted(
    lease_client: TestClient, dora: FakeDora
) -> None:
    """rev.2.15: the case the shared lease exists for.

    Was ``test_a_second_job_on_a_leased_capture_is_refused``, and its companion
    ``test_a_job_that_loses_the_lease_race_is_cancelled`` is gone with it. Both
    pinned the single-owner rule, which is exactly what stopped the N camera
    encoders of one recording running at once. The compensating cancel they
    also covered is still covered, by
    ``test_a_failure_after_the_acquire_releases_and_cancels``.
    """
    capture_id = seed_capture(lease_client)
    assert submit(lease_client, capture_id).status_code == 201

    second = submit(lease_client, capture_id)

    assert second.status_code == 201, second.text
    assert len(dora.created) == 2
    assert dora.canceled == []
    store = lease_client.app.state.capture_store
    assert [h["owner"] for h in store.lease_holders(capture_id)] == [
        "job:job_1",
        "job:job_2",
    ]


def test_many_jobs_may_hold_one_capture(
    lease_client: TestClient, dora: FakeDora
) -> None:
    """The N-encoder case at its real width (N is 2-5 in practice)."""
    capture_id = seed_capture(lease_client)

    for _ in range(5):
        assert submit(lease_client, capture_id).status_code == 201

    store = lease_client.app.state.capture_store
    assert len(store.lease_holders(capture_id)) == 5
    assert store.has_live_lease(capture_id) is True


def test_delete_is_refused_while_a_job_holds_the_lease(
    lease_client: TestClient,
) -> None:
    """The reason the lease exists: no rename under a running job (§7)."""
    capture_id = seed_capture(lease_client)
    assert submit(lease_client, capture_id).status_code == 201

    refused = lease_client.post(
        f"/api/v1/captures/{capture_id}/delete",
        json={"kind": "delete", "reason": "test"},
    )
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "capture_busy"
    # The bytes are still there — nothing was renamed into .trash.
    layout: DataLayout = lease_client.app.state.capture_service.layout
    assert layout.capture_dir(capture_id).is_dir()


# ---- release -----------------------------------------------------------------


def test_polling_a_finished_job_releases_the_lease(
    lease_client: TestClient, dora: FakeDora
) -> None:
    """Status is the hook: dora_runner never calls back, so the release happens
    the moment the orchestrator observes a terminal state."""
    capture_id = seed_capture(lease_client)
    job_id = submit(lease_client, capture_id).json()["job_id"]
    store = lease_client.app.state.capture_store

    # Still running: polling must NOT release.
    assert lease_client.get(f"/api/v1/jobs/{job_id}/status").status_code == 200
    assert store.has_live_lease(capture_id)

    dora.state = "succeeded"
    assert lease_client.get(f"/api/v1/jobs/{job_id}/status").status_code == 200
    assert not store.has_live_lease(capture_id)


def test_a_released_capture_can_be_deleted(
    lease_client: TestClient, dora: FakeDora
) -> None:
    capture_id = seed_capture(lease_client)
    job_id = submit(lease_client, capture_id).json()["job_id"]
    dora.state = "failed"
    lease_client.get(f"/api/v1/jobs/{job_id}/status")

    deleted = lease_client.post(
        f"/api/v1/captures/{capture_id}/delete",
        json={"kind": "delete", "reason": "done with it"},
    )
    assert deleted.status_code == 200


def test_fetching_a_result_releases_the_lease(
    lease_client: TestClient, dora: FakeDora
) -> None:
    """A client that jumps straight to the result must not strand the lease."""
    capture_id = seed_capture(lease_client)
    job_id = submit(lease_client, capture_id).json()["job_id"]
    dora.state = "succeeded"

    assert lease_client.get(f"/api/v1/jobs/{job_id}/result").status_code == 200
    assert not lease_client.app.state.capture_store.has_live_lease(capture_id)


def test_cancelling_a_job_releases_the_lease(lease_client: TestClient) -> None:
    capture_id = seed_capture(lease_client)
    job_id = submit(lease_client, capture_id).json()["job_id"]

    assert lease_client.post(f"/api/v1/jobs/{job_id}/cancel").status_code == 200
    assert not lease_client.app.state.capture_store.has_live_lease(capture_id)


def test_a_job_already_terminal_at_creation_keeps_no_lease(
    lease_client: TestClient, dora: FakeDora
) -> None:
    """A job that fails immediately is terminal by the time we read its status,
    and nothing else will ever observe it — so the create path releases too."""
    capture_id = seed_capture(lease_client)
    dora.state = "failed"

    assert submit(lease_client, capture_id).status_code == 201
    assert not lease_client.app.state.capture_store.has_live_lease(capture_id)


def test_releasing_only_touches_a_lease_this_job_still_owns(
    lease_client: TestClient, dora: FakeDora
) -> None:
    """A stale poll for job A must not drop job B's lease.

    Once A's lease expires and B takes one, A's terminal status can still arrive
    (a client polling an old job id). ``release_lease`` matches on the owner, so
    B keeps working undisturbed.
    """
    capture_id = seed_capture(lease_client)
    store = lease_client.app.state.capture_store
    stale_job = submit(lease_client, capture_id).json()["job_id"]

    # A's lease expires; B takes one.
    store.release_lease(capture_id, f"job:{stale_job}")
    store.acquire_lease(capture_id, "job:job_later", ttl_s=600)

    dora.state = "succeeded"
    lease_client.get(f"/api/v1/jobs/{stale_job}/status")

    capture = store.get_capture(capture_id)
    assert capture.lease_owner == "job:job_later"
    assert store.has_live_lease(capture_id)


# ---- expiry ------------------------------------------------------------------


def test_an_expired_lease_does_not_block_a_new_job(lease_client: TestClient) -> None:
    """A job whose process died leaves a lease nobody will ever release.

    TTL >= the job's own budget is what makes a renewal loop unnecessary, and an
    expired lease is not a lease — otherwise one crashed job would make its
    capture permanently unusable and undeletable.
    """
    capture_id = seed_capture(lease_client)
    store = lease_client.app.state.capture_store
    # The lease a dead job left behind: taken, then already past its expiry.
    store.acquire_lease(capture_id, "job:dead", ttl_s=-1)
    assert not store.has_live_lease(capture_id)

    created = submit(lease_client, capture_id)
    assert created.status_code == 201
    assert store.get_capture(capture_id).lease_owner == "job:job_1"


def test_an_expired_lease_does_not_block_a_delete(lease_client: TestClient) -> None:
    capture_id = seed_capture(lease_client)
    lease_client.app.state.capture_store.acquire_lease(capture_id, "job:dead", ttl_s=-1)

    deleted = lease_client.post(
        f"/api/v1/captures/{capture_id}/delete",
        json={"kind": "discard", "reason": "the job that held this is gone"},
    )
    assert deleted.status_code == 200


# ---- tombstoned captures (§7: a delete already won) --------------------------


def tombstone(client: TestClient, capture_id: str, state: CaptureState, **fields):
    client.app.state.capture_store.update_capture(capture_id, state=state, **fields)


def test_a_job_on_a_capture_being_deleted_is_refused(
    lease_client: TestClient, dora: FakeDora
) -> None:
    """``delete_pending`` is the window between the ledger append and the
    rename. A job admitted here would read bytes already on their way to
    ``.trash`` and write a report for a recording that is about to not exist."""
    capture_id = seed_capture(lease_client)
    tombstone(
        lease_client,
        capture_id,
        CaptureState.delete_pending,
        delete_kind="discard",
        deleted_at="2026-08-02T00:00:00.000Z",
    )

    refused = submit(lease_client, capture_id)
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "capture_deleting"
    # Refused before dora was ever called.
    assert dora.created == []


@pytest.mark.parametrize("state", [CaptureState.discarded, CaptureState.deleted])
def test_a_job_on_a_buried_capture_is_refused(
    lease_client: TestClient, dora: FakeDora, state: CaptureState
) -> None:
    capture_id = seed_capture(lease_client)
    tombstone(
        lease_client,
        capture_id,
        state,
        delete_kind="discard" if state == CaptureState.discarded else "delete",
        deleted_at="2026-08-02T00:00:00.000Z",
    )

    refused = submit(lease_client, capture_id)
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "capture_deleted"
    assert refused.json()["error"]["details"]["state"] == str(state)
    assert dora.created == []


def test_a_capture_whose_bytes_vanished_outside_kairos_still_accepts_a_job(
    lease_client: TestClient,
) -> None:
    """An ``rm -rf`` leaves the row saying ``completed`` — an honest claim that
    the bytes should be there (§9-2). The job is accepted and fails late with a
    clear reason, rather than the router guessing at the filesystem."""
    capture_id = seed_capture(lease_client)
    layout: DataLayout = lease_client.app.state.capture_service.layout
    shutil.rmtree(layout.capture_dir(capture_id))

    assert submit(lease_client, capture_id).status_code == 201


def test_a_capture_the_catalog_says_is_elsewhere_is_refused_up_front(
    lease_client: TestClient,
) -> None:
    """S1-5 note: no server-side replica check let a job be submitted for bytes
    this installation does not hold (still on the robot, or archived away) —
    it died minutes later inside dora_runner with a bare "no capture found".
    The replica row is a durable CATALOG claim (§8), not a filesystem guess,
    so refusing on it does not cross the rm-rf test's line above."""
    capture_id = seed_capture(lease_client)
    store = lease_client.app.state.capture_store
    store.upsert_replica(
        capture_id,
        lease_client.app.state.instance_id,
        ReplicaState.absent_managed,
    )

    response = submit(lease_client, capture_id)

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "capture_not_local"
    # Refused before anything was created: no job, no lease.
    assert not store.has_live_lease(capture_id)


# ---- renewal on observation (rev.2.6) ----------------------------------------


def _expiry(client: TestClient, capture_id: str) -> datetime:
    raw = client.app.state.capture_store.get_capture(capture_id).lease_expires_at
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


def test_polling_a_running_job_extends_its_lease(
    lease_client: TestClient, dora: FakeDora
) -> None:
    """The renewal is driven by observation, not a timer.

    A job that runs longer than one TTL is protected because the UI polls it
    while it runs, and each poll pushes the expiry out by a full TTL. Simulated
    here by shortening the lease to a few seconds and then polling once.
    """
    capture_id = seed_capture(lease_client)
    store = lease_client.app.state.capture_store
    job_id = submit(lease_client, capture_id).json()["job_id"]

    # An almost-expired lease, as if the job had been running a long time.
    store.acquire_lease(capture_id, f"job:{job_id}", ttl_s=5)
    nearly_gone = _expiry(lease_client, capture_id)

    lease_client.get(f"/api/v1/jobs/{job_id}/status")

    renewed = _expiry(lease_client, capture_id)
    assert renewed > nearly_gone
    # Pushed out by a full TTL, not merely nudged.
    assert renewed > datetime.now(UTC) + timedelta(
        seconds=jobs_router._lease_ttl_s() - 60
    )
    assert store.get_capture(capture_id).lease_owner == f"job:{job_id}"


def test_renewal_extends_only_the_polled_jobs_own_hold(
    lease_client: TestClient, dora: FakeDora
) -> None:
    """A stale poll for a job whose lease expired must not take it back off the
    job that holds the capture now."""
    capture_id = seed_capture(lease_client)
    store = lease_client.app.state.capture_store
    stale_job = submit(lease_client, capture_id).json()["job_id"]

    store.release_lease(capture_id, f"job:{stale_job}")
    store.acquire_lease(capture_id, "job:job_later", ttl_s=600)

    before = {h["owner"]: h["expires_at"] for h in store.lease_holders(capture_id)}

    # The stale job is still "running", so this poll renews ITS hold. Under a
    # shared lease that takes nothing from anyone — but it must not touch the
    # other holder's row, which is the property this test was always about.
    lease_client.get(f"/api/v1/jobs/{stale_job}/status")

    after = {h["owner"]: h["expires_at"] for h in store.lease_holders(capture_id)}
    assert after["job:job_later"] == before["job:job_later"], (
        "renewing one job's hold moved another's expiry; a poll must only ever "
        "extend the row it names"
    )
    assert f"job:{stale_job}" in after


# ---- compensation when the create path fails after the acquire ---------------


def test_a_failure_after_the_acquire_releases_and_cancels(
    lease_client: TestClient, dora: FakeDora
) -> None:
    """The window between "lease taken" and "job row written".

    If reading the new job's status fails, the caller gets an error and no job
    id — so nothing downstream will ever observe this job, and nothing would
    ever release its lease. Both halves are undone here: the lease goes back and
    the job is called off, leaving the capture deletable.
    """
    capture_id = seed_capture(lease_client)
    dora.status_fails = True

    failed = submit(lease_client, capture_id)
    # service_client maps a downstream 5xx to a unified 503 (the downstream's
    # own code rides along in the body), so that is what the caller sees.
    assert failed.status_code == 503

    store = lease_client.app.state.capture_store
    assert not store.has_live_lease(capture_id)
    assert store.get_capture(capture_id).lease_owner is None
    assert dora.canceled == ["job_1"]


def test_the_capture_is_deletable_after_a_failed_submission(
    lease_client: TestClient, dora: FakeDora
) -> None:
    capture_id = seed_capture(lease_client)
    dora.status_fails = True
    assert submit(lease_client, capture_id).status_code == 503

    deleted = lease_client.post(
        f"/api/v1/captures/{capture_id}/delete",
        json={"kind": "delete", "reason": "the submission failed"},
    )
    assert deleted.status_code == 200
