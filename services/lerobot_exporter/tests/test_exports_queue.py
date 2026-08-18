# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Submission is unbounded; execution is not.

Acceptance never blocks — an operator queueing three datasets should not have to
wait at the dialog — but only ``KAIROS_LEROBOT_MAX_CONCURRENCY`` conversions run
at a time, in submission order, because parallel ffmpeg runs mostly take work
away from each other (and from the recorder, when one is running).
"""

from __future__ import annotations

import asyncio
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


def test_queue_is_fifo_and_runs_one_at_a_time(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    exporter_env(FAKE_EPISODE_DELAY_S="0.2")
    capture = make_capture()

    async def scenario() -> None:
        async with exporter_client(
            create_exporter_app(Settings(data_dir=str(data_dir)))
        ) as client:
            ids = [
                await _submit(client, capture, profile_path, f"alice_default_{n}")
                for n in ("a", "b", "c")
            ]
            positions = [
                (await client.get(f"/exports/{export_id}")).json()["queue_position"]
                for export_id in ids
            ]
            # Whether the head has been admitted yet is a scheduling detail; the
            # ORDER is the contract.
            queued = [p for p in positions if p is not None]
            assert queued == sorted(queued)
            assert len(set(queued)) == len(queued)

            # Sampled while the queue drains: a second slot would show up here.
            for _ in range(60):
                states = [
                    (await client.get(f"/exports/{export_id}")).json()["state"]
                    for export_id in ids
                ]
                assert states.count("running") <= 1, states
                if all(state == "complete" for state in states):
                    break
                await asyncio.sleep(0.05)

            for export_id in ids:
                body = await wait_for_state(client, export_id, {"complete", "failed"})
                assert body["state"] == "complete", body
                assert body["queue_position"] is None

    asyncio.run(scenario())


def test_queue_position_advances_as_the_queue_drains(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    exporter_env(FAKE_EPISODE_DELAY_S="0.2")
    capture = make_capture()

    async def scenario() -> None:
        async with exporter_client(
            create_exporter_app(Settings(data_dir=str(data_dir)))
        ) as client:
            first = await _submit(client, capture, profile_path, "alice_default_1")
            last = await _submit(client, capture, profile_path, "alice_default_2")
            await wait_for_state(client, first, {"complete", "failed"})
            body = await wait_for_state(client, last, {"running", "complete", "failed"})
            assert body["queue_position"] is None

    asyncio.run(scenario())
