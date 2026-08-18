# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""``GET /profiles``: the robot's profile library, and what it says without
a validator."""

from __future__ import annotations

from pathlib import Path

import pytest
from conftest import PROFILE_YAML
from fastapi.testclient import TestClient
from kairos_common import Settings
from lerobot_exporter.main import create_exporter_app

ROBOT = "myrobot"


@pytest.fixture
def config_roots(tmp_path: Path) -> tuple[Path, Path]:
    """``(config, config/local)`` with the robot's ``lerobot/`` aspect dir."""
    committed = tmp_path / "config"
    local = committed / "local"
    (committed / ROBOT / "lerobot").mkdir(parents=True)
    (local / ROBOT / "lerobot").mkdir(parents=True)
    return committed, local


def _client(data_dir: Path, config_roots: tuple[Path, Path]) -> TestClient:
    committed, local = config_roots
    return TestClient(
        create_exporter_app(
            Settings(
                data_dir=str(data_dir),
                config_dir=str(committed),
                config_local_dir=str(local),
                robot=ROBOT,
            )
        )
    )


def test_lists_committed_and_local_profiles(
    data_dir: Path, config_roots: tuple[Path, Path]
) -> None:
    committed, local = config_roots
    (committed / ROBOT / "lerobot" / "default.yaml").write_text(PROFILE_YAML)
    (local / ROBOT / "lerobot" / "arm_only.yaml").write_text(PROFILE_YAML)

    body = _client(data_dir, config_roots).get("/profiles").json()

    by_name = {item["name"]: item for item in body["profiles"]}
    assert by_name["default"]["source"] == "committed"
    assert by_name["arm_only"]["source"] == "local"
    assert by_name["default"]["path"].endswith(f"{ROBOT}/lerobot/default.yaml")


def test_reports_topics_and_fps_for_the_orchestrator_preflight(
    data_dir: Path, config_roots: tuple[Path, Path]
) -> None:
    """topics is the union of observations + actions — preflight's whole input."""
    committed, _ = config_roots
    (committed / ROBOT / "lerobot" / "default.yaml").write_text(PROFILE_YAML)

    item = _client(data_dir, config_roots).get("/profiles").json()["profiles"][0]

    assert item["topics"] == ["/myrobot/joint_states", "/myrobot/arm_command"]
    assert item["fps"] == 10


def test_validity_is_unknown_without_the_converter(
    data_dir: Path, config_roots: tuple[Path, Path]
) -> None:
    """No validator installed: `valid` is null and the reason is stated.

    An optimistic `true` here would be the difference between "we checked" and
    "we could not check" going unnoticed all the way to a failed conversion.
    """
    committed, _ = config_roots
    (committed / ROBOT / "lerobot" / "default.yaml").write_text(PROFILE_YAML)

    body = _client(data_dir, config_roots).get("/profiles").json()

    assert body["validator_unavailable"] is True
    assert body["profiles"][0]["valid"] is None
    assert body["profiles"][0]["errors"] == []


def test_unreadable_profile_is_reported_not_raised(
    data_dir: Path, config_roots: tuple[Path, Path]
) -> None:
    committed, _ = config_roots
    (committed / ROBOT / "lerobot" / "broken.yaml").write_text("::: not yaml :::")

    item = _client(data_dir, config_roots).get("/profiles").json()["profiles"][0]

    assert item["name"] == "broken"
    assert item["errors"]


def test_committed_wins_when_both_trees_define_a_name(
    data_dir: Path, config_roots: tuple[Path, Path]
) -> None:
    """One profile name must not mean two files depending on who reads it."""
    committed, local = config_roots
    (committed / ROBOT / "lerobot" / "default.yaml").write_text(PROFILE_YAML)
    (local / ROBOT / "lerobot" / "default.yaml").write_text(PROFILE_YAML)

    items = _client(data_dir, config_roots).get("/profiles").json()["profiles"]

    assert [item["source"] for item in items] == ["committed"]


def test_no_library_is_an_empty_list(
    data_dir: Path, config_roots: tuple[Path, Path]
) -> None:
    assert _client(data_dir, config_roots).get("/profiles").json()["profiles"] == []
