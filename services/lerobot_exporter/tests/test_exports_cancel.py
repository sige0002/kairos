# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Cancel actually stops the work — and only then says so.

A status that reads ``canceled`` while ffmpeg is still writing into the output
tree is the failure this discipline exists to prevent (dora_runner learned the
same lesson with its threadpool jobs): the endpoint REQUESTS the stop, the
worker writes the terminal state once the process group is confirmed dead.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Callable
from pathlib import Path

import httpx
from conftest import episode, exporter_client, new_export_id, wait_for_state
from kairos_common import Settings
from lerobot_exporter.main import create_exporter_app


async def _submit(
    client: httpx.AsyncClient, capture: str, profile_path: str, name: str
) -> str:
    export_id = new_export_id()
    response = await client.post(
        "/exports",
        json={
            "export_id": export_id,
            "output_name": name,
            "profile_path": profile_path,
            "task_fallback": None,
            "episodes": [episode(capture, "001", None)],
        },
    )
    assert response.status_code == 202, response.text
    return export_id


async def _wait_for_file(path: Path, *, timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if path.is_file():
            return
        await asyncio.sleep(0.02)
    raise AssertionError(f"{path} never appeared")


def test_canceling_a_queued_export_is_immediate(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    """Nothing has started, so nothing has to be stopped — or undone."""
    exporter_env(FAKE_MODE="hang")
    capture = make_capture()

    async def scenario() -> None:
        async with exporter_client(
            create_exporter_app(Settings(data_dir=str(data_dir)))
        ) as client:
            await _submit(client, capture, profile_path, "alice_default_running")
            queued = await _submit(
                client, capture, profile_path, "alice_default_queued"
            )

            response = await client.post(f"/exports/{queued}/cancel")

            assert response.status_code == 200
            assert response.json()["state"] == "canceled"
            assert (await client.get(f"/exports/{queued}")).json()[
                "state"
            ] == "canceled"
            assert not (data_dir / "exports" / "alice_default_queued").exists()

    asyncio.run(scenario())


def test_canceling_a_running_export_kills_the_process_group(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    """The converter's own children (ffmpeg, in production) go with it."""
    exporter_env(FAKE_MODE="hang", FAKE_CHILD="1")
    capture = make_capture()
    output = data_dir / "exports" / "alice_default_kill"

    async def scenario() -> int:
        async with exporter_client(
            create_exporter_app(Settings(data_dir=str(data_dir)))
        ) as client:
            export_id = await _submit(
                client, capture, profile_path, "alice_default_kill"
            )
            await _wait_for_file(output / "meta" / "fake_child.json")
            child_pid = json.loads(
                (output / "meta" / "fake_child.json").read_text(encoding="utf-8")
            )["pid"]

            response = await client.post(f"/exports/{export_id}/cancel")
            assert response.status_code == 202
            # Still running: the label follows the kill, it does not lead it.
            assert response.json()["state"] == "running"

            body = await wait_for_state(client, export_id, {"canceled", "failed"})
            assert body["state"] == "canceled", body
            return child_pid

    child_pid = asyncio.run(scenario())

    assert not output.exists()
    assert _staging_is_empty(data_dir)
    assert _process_gone(child_pid)


def test_a_child_that_outlives_the_parent_is_still_killed(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    """The F2 case: the parent dies on SIGTERM, a child ignores it.

    Cancel sends SIGTERM to the whole group; the parent (plain hang loop) dies,
    but the child ignores it and keeps running (and, in production, keeps
    writing the output about to be deleted). Waiting on the parent alone would
    report the cancel done with that writer still alive. Only escalating to a
    group SIGKILL — which nothing can ignore — actually stops it.

    The test waits for the child's READY file (written AFTER it installs
    SIG_IGN) before cancelling, and requires the whole thing to take at least
    the grace window — so the SIGKILL escalation MUST have run. Without those
    two, a child that merely lost a startup race and died on the plain SIGTERM
    would pass, and reverting the fix would not turn the test red (the vacuous
    test the review flagged).
    """
    grace = 0.3
    exporter_env(
        FAKE_MODE="hang",
        FAKE_CHILD="1",
        FAKE_CHILD_IGNORE_TERM="1",
        KAIROS_LEROBOT_TERM_GRACE_S=str(grace),
    )
    capture = make_capture()
    output = data_dir / "exports" / "alice_default_orphan"

    async def scenario() -> tuple[int, float]:
        async with exporter_client(
            create_exporter_app(Settings(data_dir=str(data_dir)))
        ) as client:
            export_id = await _submit(
                client, capture, profile_path, "alice_default_orphan"
            )
            # The child has installed SIG_IGN by the time this file exists, so
            # the cancel below cannot race the handler's installation.
            await _wait_for_file(output / "meta" / "fake_child_ready")
            child_pid = json.loads(
                (output / "meta" / "fake_child.json").read_text(encoding="utf-8")
            )["pid"]
            started = asyncio.get_running_loop().time()
            await client.post(f"/exports/{export_id}/cancel")
            body = await wait_for_state(client, export_id, {"canceled", "failed"})
            elapsed = asyncio.get_running_loop().time() - started
            assert body["state"] == "canceled", body
            return child_pid, elapsed

    child_pid, elapsed = asyncio.run(scenario())
    assert _process_gone(child_pid), "the orphaned child survived the cancel"
    assert not output.exists()
    # The child ignored SIGTERM, so reaching a terminal state at all proves the
    # SIGKILL escalation ran — and it cannot have before the grace elapsed.
    assert elapsed >= grace, (
        f"cancel settled in {elapsed:.3f}s, under the {grace}s grace — the "
        "SIGKILL escalation did not run, so this would pass without the fix"
    )


def test_a_converter_that_ignores_sigterm_is_killed(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    exporter_env(
        FAKE_MODE="hang", FAKE_IGNORE_TERM="1", KAIROS_LEROBOT_TERM_GRACE_S="0.3"
    )
    capture = make_capture()

    async def scenario() -> dict:
        async with exporter_client(
            create_exporter_app(Settings(data_dir=str(data_dir)))
        ) as client:
            export_id = await _submit(
                client, capture, profile_path, "alice_default_stubborn"
            )
            await _wait_for_file(
                data_dir
                / "exports"
                / "alice_default_stubborn"
                / "meta"
                / "fake_input.json"
            )
            await client.post(f"/exports/{export_id}/cancel")
            return await wait_for_state(client, export_id, {"canceled", "failed"})

    assert asyncio.run(scenario())["state"] == "canceled"


def test_canceling_a_finished_export_is_a_conflict(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    exporter_env()
    capture = make_capture()

    async def scenario() -> None:
        async with exporter_client(
            create_exporter_app(Settings(data_dir=str(data_dir)))
        ) as client:
            export_id = await _submit(
                client, capture, profile_path, "alice_default_done"
            )
            await wait_for_state(client, export_id, {"complete", "failed"})

            response = await client.post(f"/exports/{export_id}/cancel")

            assert response.status_code == 409
            assert response.json()["error"]["code"] == "export_already_terminal"

    asyncio.run(scenario())


def test_canceling_an_unknown_export_is_404(data_dir: Path) -> None:
    async def scenario() -> None:
        async with exporter_client(
            create_exporter_app(Settings(data_dir=str(data_dir)))
        ) as client:
            response = await client.post("/exports/nope/cancel")
            assert response.status_code == 404
            assert response.json()["error"]["code"] == "export_not_found"

    asyncio.run(scenario())


def _staging_is_empty(data_dir: Path) -> bool:
    staging = data_dir / "exports" / ".staging"
    return not staging.is_dir() or not any(staging.iterdir())


def _process_gone(pid: int, *, timeout: float = 5.0) -> bool:
    """Whether *pid* is gone, allowing for the reaper to get to it."""
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except (ProcessLookupError, PermissionError):
            return True
        time.sleep(0.05)
    return False
