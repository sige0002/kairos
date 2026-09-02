# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""E-38: a recording that ends at its own cap, and what the catalog calls it.

``MAX_RECORD_SECONDS`` / ``MAX_RECORD_BYTES`` are the recorder's disk-protection
backstops. Reaching one is a *successful* recording that stopped where it was
told to — the recorder says so in its own code ("no error occurred") and
``rosbag2_recorder.md`` says the orchestrator settles it "as a normal
completed". It carries the reason in the manifest's ``error`` field because
that is the only free-text field a manifest has, not because anything failed.

Three things end a recording and only one of them is a fault:

    operator stop  -> completed, no error
    cap reached    -> completed, the note saying which cap
    crash / kill   -> interrupted (or failed), the recorder's account of it

These pin that the three stay TELLABLE APART on the wire, through every route
that writes the field: the stop path, the status poll that finds an auto-stop
nobody asked for, the digest re-reading the sealed manifest, and a catalog
rebuilt from the sidecar after the database is gone.
"""

from __future__ import annotations

import time

import httpx
import pytest
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.store import CaptureStore
from conftest import FakeRecorder, run_digests, stop_owned
from fastapi.testclient import TestClient

SECONDS_NOTE = "auto-stopped: recording ran 600s, reaching MAX_RECORD_SECONDS=600"
BYTES_NOTE = "auto-stopped: recorded 1048576 bytes reached MAX_RECORD_BYTES=1048576"


def _store(client: TestClient) -> CaptureStore:
    return client.app.state.capture_store


def _start(client: TestClient, **body: object) -> dict:
    payload = {"topics": ["/joint_states"], **body}
    response = client.post("/api/v1/record/start", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def _await_settlement(client: TestClient, *, timeout_s: float = 10.0) -> None:
    """Block until every in-flight quick-check settlement has finished."""
    service = client.app.state.record_service
    deadline = time.monotonic() + timeout_s
    while service._settlement_tasks and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not service._settlement_tasks, "the quick-check settlement never finished"


@pytest.mark.parametrize("note", [SECONDS_NOTE, BYTES_NOTE])
def test_a_cap_stop_is_not_filed_as_a_recorder_failure(
    client: TestClient,
    fake_recorder: FakeRecorder,
    digests_stay_queued: list[str],
    note: str,
) -> None:
    # Both caps write the same shape of note, and a fix that only recognises
    # one of them leaves the other lying.
    fake_recorder.final_state = "completed"
    fake_recorder.final_error = note
    _start(client)
    stopped = stop_owned(client).json()

    assert stopped["state"] == "completed"
    error = stopped["error"]
    # `recorder_failed` is the code for "the recorder's account of a fault".
    # Reaching a cap is not one, and calling it that tells an operator their
    # good take is broken data — in Review, in a red panel, under a code that
    # says the recorder failed.
    assert error["code"] == "auto_stopped"
    # The note itself is the only place the *reason* survives, so it must not
    # be swallowed in the course of reclassifying it.
    assert error["message"] == note


def test_a_crash_is_still_a_recorder_failure(
    client: TestClient, fake_recorder: FakeRecorder, digests_stay_queued: list[str]
) -> None:
    # The discriminator has to REFUSE something, or it is just a blanket
    # "nothing is ever wrong" and the cap case proves nothing.
    fake_recorder.final_state = "interrupted"
    fake_recorder.final_error = "recording ended abnormally (rc=-9)"
    _start(client)
    stopped = stop_owned(client).json()

    assert stopped["state"] == "interrupted"
    assert stopped["error"]["code"] == "recorder_failed"


def test_an_operator_stop_carries_no_error_at_all(
    client: TestClient, digests_stay_queued: list[str]
) -> None:
    # The third ending, pinned beside the other two: silence is what "I stopped
    # it myself" looks like, so the cap note must not be silence too.
    _start(client)
    stopped = stop_owned(client).json()
    assert stopped["state"] == "completed"
    assert stopped.get("error") is None


def test_a_cap_stop_the_status_poll_finds_is_not_a_failure(
    client: TestClient, fake_recorder: FakeRecorder, digests_stay_queued: list[str]
) -> None:
    # The route this actually arrives by. A cap stop bypasses `/record/stop`
    # entirely — the recorder just ends — and the catalog only learns about it
    # from the status poll's lazy reconciliation.
    started = _start(client)
    fake_recorder.state = "completed"
    fake_recorder.finalized = True
    fake_recorder.final_state = "completed"
    fake_recorder.final_error = SECONDS_NOTE

    client.get("/api/v1/record/status")
    _await_settlement(client)

    capture = _store(client).get_capture(started["capture_id"])
    assert capture is not None
    assert str(capture.state) == "completed"
    assert capture.error is not None
    assert capture.error.code == "auto_stopped"
    # The settlement bundles the same note as `backstop` (informational, not a
    # verdict trigger). Asserted here because it is the field the API contract
    # names for this, and a change that moved the note out of `error` without
    # it would leave the cap invisible everywhere.
    assert capture.quick_check is not None
    assert capture.quick_check.layer0.backstop == SECONDS_NOTE


def test_the_digest_does_not_relabel_a_cap_stop_as_a_failure(
    client: TestClient, fake_recorder: FakeRecorder, digests_stay_queued: list[str]
) -> None:
    # `stop` classifies from the recorder's HTTP answer; the digest that runs
    # moments later re-reads the SEALED MANIFEST and rewrites the row from it
    # (`adopt_manifest_facts`). Two readers, one field — so the row must not
    # settle correctly and then flip back a second later.
    fake_recorder.final_state = "completed"
    fake_recorder.final_error = SECONDS_NOTE
    _start(client)
    stopped = stop_owned(client).json()
    capture_id = stopped["capture_id"]
    assert digests_stay_queued == [capture_id]

    run_digests(client)

    capture = _store(client).get_capture(capture_id)
    assert capture is not None
    assert capture.error is not None
    assert capture.error.code == "auto_stopped"


def test_a_rebuilt_catalog_still_knows_the_cap_was_not_a_failure(
    client: TestClient,
    fake_recorder: FakeRecorder,
    settings,
    data_dir,
) -> None:
    # §8: the database is an index. After it is thrown away the classification
    # has to come back out of the sidecar the same way, or a rebuild turns
    # every past cap stop into a recorder failure.
    fake_recorder.final_state = "completed"
    fake_recorder.final_error = SECONDS_NOTE
    _start(client)
    capture_id = stop_owned(client).json()["capture_id"]
    run_digests(client)
    client.close()
    (data_dir / "kairos.db").unlink()

    rebuilt = create_orchestrator_app(
        settings,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(fake_recorder.handler)
        ),
    )
    with TestClient(rebuilt) as reopened:
        detail = reopened.get(f"/api/v1/captures/{capture_id}").json()
    assert detail["state"] == "completed"
    assert detail["error"]["code"] == "auto_stopped"
    assert detail["error"]["message"] == SECONDS_NOTE
