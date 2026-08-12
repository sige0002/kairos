"""What ``POST /exports`` refuses, and with which code."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path

from conftest import episode, exporter_client, new_export_id, wait_for_state
from fastapi.testclient import TestClient
from kairos_common import Settings
from kairos_common.ids import new_capture_id
from lerobot_exporter.main import create_exporter_app


def _client(data_dir: Path) -> TestClient:
    return TestClient(create_exporter_app(Settings(data_dir=str(data_dir))))


def _request(profile_path: str, **overrides) -> dict:
    body = {
        "export_id": new_export_id(),
        "output_name": "alice_default_x",
        "profile_path": profile_path,
        "task_fallback": None,
        "episodes": [episode(new_capture_id(), "001", None)],
    }
    body.update(overrides)
    return body


def _post(client: TestClient, profile_path: str, **overrides):
    return client.post("/exports", json=_request(profile_path, **overrides))


def test_a_non_empty_destination_is_refused(data_dir: Path, profile_path: str) -> None:
    """Exports are never merged into or overwritten."""
    existing = data_dir / "exports" / "alice_default_x"
    existing.mkdir(parents=True)
    (existing / "meta").mkdir()

    response = _post(_client(data_dir), profile_path)

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "destination_not_empty"


def test_an_empty_destination_directory_is_not_a_conflict(
    data_dir: Path, profile_path: str, exporter_env: Callable[..., None]
) -> None:
    """A previous run that died before writing must not block the retry."""
    exporter_env()
    (data_dir / "exports" / "alice_default_x").mkdir(parents=True)

    assert _post(_client(data_dir), profile_path).status_code == 202


def test_a_second_export_to_the_same_name_is_refused_while_one_is_live(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    exporter_env(FAKE_MODE="hang")
    capture = make_capture()

    async def scenario() -> None:
        async with exporter_client(
            create_exporter_app(Settings(data_dir=str(data_dir)))
        ) as client:
            first = _request(profile_path, episodes=[episode(capture, "001", None)])
            assert (await client.post("/exports", json=first)).status_code == 202
            second = _request(
                profile_path,
                output_name=first["output_name"],
                episodes=[episode(capture, "001", None)],
            )
            response = await client.post("/exports", json=second)
            assert response.status_code == 409
            assert response.json()["error"]["code"] == "export_in_progress"

    asyncio.run(scenario())


def test_a_reused_export_id_is_refused(
    data_dir: Path,
    make_capture: Callable[..., str],
    profile_path: str,
    exporter_env: Callable[..., None],
) -> None:
    """Even after the first one finished: the id is the status key."""
    exporter_env()
    capture = make_capture()
    export_id = new_export_id()

    async def scenario() -> None:
        async with exporter_client(
            create_exporter_app(Settings(data_dir=str(data_dir)))
        ) as client:
            first = _request(
                export_id=export_id,
                profile_path=profile_path,
                output_name="alice_default_one",
                episodes=[episode(capture, "001", None)],
            )
            assert (await client.post("/exports", json=first)).status_code == 202
            await wait_for_state(client, export_id, {"complete", "failed"})
            second = _request(
                export_id=export_id,
                profile_path=profile_path,
                output_name="alice_default_two",
                episodes=[episode(capture, "001", None)],
            )
            response = await client.post("/exports", json=second)
            assert response.status_code == 409
            assert response.json()["error"]["code"] == "export_in_progress"

    asyncio.run(scenario())


def test_a_non_uuid7_export_id_is_a_bad_request(
    data_dir: Path, profile_path: str
) -> None:
    response = _post(_client(data_dir), profile_path, export_id="export-1")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_export_id"


def test_an_output_name_that_escapes_the_export_root_is_refused(
    data_dir: Path, profile_path: str
) -> None:
    for name in ("../escape", "nested/name", ".staging", ""):
        response = _post(_client(data_dir), profile_path, output_name=name)
        assert response.status_code == 400, name
        assert response.json()["error"]["code"] == "invalid_output_name"


def test_an_episode_directory_that_escapes_staging_is_refused(
    data_dir: Path, profile_path: str
) -> None:
    response = _post(
        _client(data_dir),
        profile_path,
        episodes=[episode(new_capture_id(), "../001", None)],
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_episode_dir"


def test_two_episodes_cannot_claim_one_directory(
    data_dir: Path, profile_path: str
) -> None:
    response = _post(
        _client(data_dir),
        profile_path,
        episodes=[
            episode(new_capture_id(), "001", None),
            episode(new_capture_id(), "001", None),
        ],
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "duplicate_episode_dir"


def test_an_export_without_episodes_is_refused(
    data_dir: Path, profile_path: str
) -> None:
    response = _post(_client(data_dir), profile_path, episodes=[])
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "no_episodes"


def test_a_missing_profile_is_refused_at_submit(data_dir: Path) -> None:
    """A profile that is not there can only fail — say so before queueing."""
    response = _post(_client(data_dir), "/config/myrobot/lerobot/gone.yaml")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "profile_not_found"


def test_an_existing_file_outside_the_library_is_refused(
    data_dir: Path, tmp_path: Path
) -> None:
    """The F6 case: an unauthenticated caller cannot hand us any readable file.

    ``is_file()`` alone would accept ``/etc/hosts`` (or any config the host
    can read) and parse it through the converter, returning its content in the
    error — an arbitrary-file-read surface. Membership in the scanned library
    is what closes it.
    """
    victim = tmp_path / "secret.yaml"
    victim.write_text("robot_type: x\n", encoding="utf-8")
    response = _post(_client(data_dir), str(victim))
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "profile_not_found"


def test_a_non_uuid7_capture_id_is_a_bad_request(
    data_dir: Path, profile_path: str
) -> None:
    response = _post(
        _client(data_dir), profile_path, episodes=[episode("run_1", "001", None)]
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_capture_id"
