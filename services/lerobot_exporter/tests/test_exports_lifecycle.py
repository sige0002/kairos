"""An export end to end: staging, the converter's argv, and every terminal path.

The converter is the stub in ``fake_converter.py``, which snapshots what it was
handed into ``meta/fake_input.json``. Staging is deleted the moment an export
finishes, so the converter's own view is the only place the staging tree can
honestly be asserted from.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path

from conftest import episode, exporter_client, new_export_id, wait_for_state
from kairos_common import Settings
from lerobot_exporter.main import create_exporter_app


def _app(data_dir: Path):
    return create_exporter_app(Settings(data_dir=str(data_dir)))


def _fake_input(data_dir: Path, output_name: str) -> dict:
    path = data_dir / "exports" / output_name / "meta" / "fake_input.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _staging_entries(data_dir: Path) -> list[Path]:
    staging = data_dir / "exports" / ".staging"
    return sorted(staging.iterdir()) if staging.is_dir() else []


def test_happy_path(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    """Two episodes convert; staging, task labels and provenance arrive intact."""
    exporter_env()
    labelled = make_capture()
    unlabelled = make_capture()
    export_id = new_export_id()

    async def scenario() -> None:
        async with exporter_client(_app(data_dir)) as client:
            response = await client.post(
                "/exports",
                json={
                    "export_id": export_id,
                    "output_name": "alice_default_beta1",
                    "profile_path": profile_path,
                    "task_fallback": "pick the cup",
                    "episodes": [
                        episode(labelled, "001", "press the button"),
                        episode(unlabelled, "002", None),
                    ],
                },
            )
            assert response.status_code == 202, response.text
            assert response.json()["state"] == "queued"
            body = await wait_for_state(client, export_id, {"complete", "failed"})

        assert body["state"] == "complete", body
        assert body["done"] == 2
        assert body["failed"] == 0
        assert body["total"] == 2
        # Data-root relative: /data in the container and $DATA_DIR on the host
        # name the same bytes, and only this key resolves from both.
        assert body["output_path"] == "exports/alice_default_beta1"

    asyncio.run(scenario())

    seen = _fake_input(data_dir, "alice_default_beta1")
    first = seen["bags"]["001"]
    assert sorted(first["links"]) == [f"{labelled}.mcap", "metadata.yaml"]
    assert first["links"]["metadata.yaml"].endswith(f"objects/{labelled}/metadata.yaml")
    # Relative, like views/: the tree resolves from the host and the container.
    assert not first["links"]["metadata.yaml"].startswith("/")
    # An injected task.json is a real file; only bag bytes are linked.
    assert first["real_files"] == ["task.json"]
    assert first["task_json"] == {"task": "press the button"}
    assert seen["bags"]["002"]["task_json"] is None
    assert seen["manifest_extra"]["kairos"] == {
        "export_id": export_id,
        "captures": [
            {"capture_id": labelled, "dir": "001", "task": "press the button"},
            {"capture_id": unlabelled, "dir": "002", "task": None},
        ],
    }
    assert seen["task"] == "pick the cup"
    assert seen["workers"] == 1
    assert "--json" in seen["argv"]
    # CPU encoding is the default: NVENC auto-detection lies in a GPU-less
    # container (ffmpeg lists the encoder, then cannot load libcuda), so the
    # exporter pins the choice unless the deployment opted in.
    assert "--no-gpu" in seen["argv"]
    assert _staging_entries(data_dir) == []


def test_source_owned_task_json_is_preserved_not_replaced(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    """A bag that arrived with its own task.json keeps it (archive's rule)."""
    exporter_env()
    capture = make_capture(task_json="its own task")
    export_id = new_export_id()

    async def scenario() -> None:
        async with exporter_client(_app(data_dir)) as client:
            await client.post(
                "/exports",
                json={
                    "export_id": export_id,
                    "output_name": "alice_default_own",
                    "profile_path": profile_path,
                    "task_fallback": None,
                    "episodes": [episode(capture, "001", "kairos label")],
                },
            )
            await wait_for_state(client, export_id, {"complete", "failed"})

    asyncio.run(scenario())

    staged = _fake_input(data_dir, "alice_default_own")["bags"]["001"]
    assert staged["task_json"] == {"task": "its own task"}
    # Linked, not written: the source file is what the converter reads.
    assert "task.json" in staged["links"]
    assert staged["real_files"] == []


def test_task_fallback_is_omitted_when_every_episode_is_labelled(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    """No --task: it would override the per-episode task.json files."""
    exporter_env()
    capture = make_capture()
    export_id = new_export_id()

    async def scenario() -> None:
        async with exporter_client(_app(data_dir)) as client:
            await client.post(
                "/exports",
                json={
                    "export_id": export_id,
                    "output_name": "alice_default_labelled",
                    "profile_path": profile_path,
                    "task_fallback": None,
                    "episodes": [episode(capture, "001", "press the button")],
                },
            )
            await wait_for_state(client, export_id, {"complete", "failed"})

    asyncio.run(scenario())

    seen = _fake_input(data_dir, "alice_default_labelled")
    assert seen["task"] is None
    assert "--task" not in seen["argv"]


def test_failure_removes_the_partial_output(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    """A failed export leaves nothing behind — debris would 409 the retry."""
    exporter_env(FAKE_MODE="fail")
    capture = make_capture()
    export_id = new_export_id()

    async def scenario() -> dict:
        async with exporter_client(_app(data_dir)) as client:
            await client.post(
                "/exports",
                json={
                    "export_id": export_id,
                    "output_name": "alice_default_boom",
                    "profile_path": profile_path,
                    "task_fallback": None,
                    "episodes": [episode(capture, "001", None)],
                },
            )
            return await wait_for_state(client, export_id, {"complete", "failed"})

    body = asyncio.run(scenario())

    assert body["state"] == "failed"
    assert "exploding on purpose" in body["message"]
    assert body["output_path"] is None
    assert not (data_dir / "exports" / "alice_default_boom").exists()
    assert _staging_entries(data_dir) == []


def test_a_capture_without_bytes_fails_before_the_converter_runs(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    """The message names the capture, not the converter's empty input dir."""
    exporter_env()
    empty = make_capture(mcap=False)
    export_id = new_export_id()

    async def scenario() -> dict:
        async with exporter_client(_app(data_dir)) as client:
            await client.post(
                "/exports",
                json={
                    "export_id": export_id,
                    "output_name": "alice_default_nobytes",
                    "profile_path": profile_path,
                    "task_fallback": None,
                    "episodes": [episode(empty, "001", None)],
                },
            )
            return await wait_for_state(client, export_id, {"complete", "failed"})

    body = asyncio.run(scenario())

    assert body["state"] == "failed"
    assert empty in body["message"]
    assert "MCAP" in body["message"]
    assert _staging_entries(data_dir) == []


def test_a_symlinked_staging_root_does_not_delete_a_capture_over_http(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    """N1 end to end: the worker's own staging rmtree must be guarded too.

    build_staging refusing a symlinked root is not enough — the registry
    resolves its own staging path and its finally rmtree's it on every terminal
    path. With .staging symlinked at objects/ and export_id set to a victim
    capture's UUIDv7 (which the API accepts), an unguarded worker deletes the
    capture. This drives the REAL POST path; a build_staging-only test cannot
    reach the rmtree that does the damage.
    """
    import os

    exporter_env()
    victim = make_capture()
    exports = data_dir / "exports"
    exports.mkdir(parents=True, exist_ok=True)
    os.symlink(data_dir / "objects", exports / ".staging")

    async def scenario() -> dict:
        async with exporter_client(_app(data_dir)) as client:
            await client.post(
                "/exports",
                json={
                    "export_id": victim,  # a real UUIDv7 that also names a capture
                    "output_name": "alice_default_symlink",
                    "profile_path": profile_path,
                    "task_fallback": None,
                    "episodes": [episode(make_capture(), "001", None)],
                },
            )
            return await wait_for_state(client, victim, {"complete", "failed"})

    body = asyncio.run(scenario())

    assert body["state"] == "failed"
    assert (data_dir / "objects" / victim / "metadata.yaml").is_file(), (
        "the victim capture was deleted through the symlinked staging root"
    )


def test_an_orphan_holding_the_pipes_does_not_hang_the_export(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    """The converter's children inherit its pipes, so EOF can outlive it.

    Found by mutating the process-group kill: with a child still holding
    stdout/stderr, waiting for EOF pinned the export in ``running`` for as long
    as that orphan lived. The drain is bounded now — the output we already have
    beats a complete tail that never arrives.
    """
    exporter_env(FAKE_CHILD="1", FAKE_CHILD_SLEEP_S="20", KAIROS_LEROBOT_DRAIN_S="0.3")
    capture = make_capture()
    export_id = new_export_id()

    async def scenario() -> dict:
        async with exporter_client(_app(data_dir)) as client:
            await client.post(
                "/exports",
                json={
                    "export_id": export_id,
                    "output_name": "alice_default_orphan",
                    "profile_path": profile_path,
                    "task_fallback": None,
                    "episodes": [episode(capture, "001", None)],
                },
            )
            return await wait_for_state(
                client, export_id, {"complete", "failed"}, timeout=5.0
            )

    assert asyncio.run(scenario())["state"] == "complete"


def test_a_stale_heartbeat_is_reported_without_killing_the_conversion(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    """stalled is a statement, not an action: the export stays running."""
    exporter_env(
        FAKE_MODE="hang", FAKE_HEARTBEAT_AGE_S="600", KAIROS_LEROBOT_STALL_S="1"
    )
    capture = make_capture()
    export_id = new_export_id()

    async def scenario() -> dict:
        async with exporter_client(_app(data_dir)) as client:
            await client.post(
                "/exports",
                json={
                    "export_id": export_id,
                    "output_name": "alice_default_stall",
                    "profile_path": profile_path,
                    "task_fallback": None,
                    "episodes": [episode(capture, "001", None)],
                },
            )
            deadline = asyncio.get_running_loop().time() + 5.0
            body: dict = {}
            while asyncio.get_running_loop().time() < deadline:
                body = (await client.get(f"/exports/{export_id}")).json()
                if body["stalled"]:
                    return body
                await asyncio.sleep(0.02)
            raise AssertionError(f"never reported a stall: {body}")

    body = asyncio.run(scenario())

    assert body["state"] == "running"
    assert body["stalled"] is True
