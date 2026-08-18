# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""instance.json: minted once, never regenerated, never guessed at."""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest
from kairos_common import atomic_io, instance


def test_first_start_mints_the_installation_identity(tmp_path: Path) -> None:
    info = instance.load_or_create_instance(tmp_path)

    assert uuid.UUID(info.instance_id).version == 4
    assert info.created_at.endswith("Z")
    written = json.loads(instance.instance_path(tmp_path).read_text(encoding="utf-8"))
    assert written == {
        "schema_version": 2,
        "instance_id": info.instance_id,
        "created_at": info.created_at,
    }


def test_every_later_start_returns_the_same_id(tmp_path: Path) -> None:
    """Regenerating would not create a new installation — it would orphan every
    replica row and every manifest that still names the old id."""
    first = instance.load_or_create_instance(tmp_path)
    before = instance.instance_path(tmp_path).read_bytes()

    second = instance.load_or_create_instance(tmp_path)

    assert second == first
    assert instance.instance_path(tmp_path).read_bytes() == before


def test_a_concurrent_first_start_loses_gracefully(tmp_path: Path, monkeypatch) -> None:
    """Orchestrator, recorder and dora_runner can come up together on a fresh
    data_dir. Exactly one id may survive, and the loser must adopt it rather
    than keep the one it minted."""
    winner = {"schema_version": 2, "instance_id": "winner-id", "created_at": "2026Z"}

    def lose_the_race(path, obj):
        # Stand in for the other process: it claimed the name first.
        atomic_io.atomic_write_json(path, winner)
        return False

    monkeypatch.setattr(instance, "create_exclusive_json", lose_the_race)

    info = instance.load_or_create_instance(tmp_path)

    assert info.instance_id == "winner-id"


def test_a_zero_byte_instance_file_is_fatal_rather_than_re_minted(
    tmp_path: Path,
) -> None:
    """After power loss a 0-byte instance.json looks exactly like "no instance
    yet". Minting a replacement is the one outcome that cannot be undone."""
    instance.instance_path(tmp_path).write_bytes(b"")

    with pytest.raises(instance.CorruptInstanceError):
        instance.load_or_create_instance(tmp_path)


def test_unparseable_or_id_less_json_is_fatal_too(tmp_path: Path) -> None:
    path = instance.instance_path(tmp_path)

    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(instance.CorruptInstanceError):
        instance.read_instance(tmp_path)

    path.write_text(json.dumps({"schema_version": 2}), encoding="utf-8")
    with pytest.raises(instance.CorruptInstanceError):
        instance.read_instance(tmp_path)


def test_a_data_dir_with_no_instance_reads_as_none(tmp_path: Path) -> None:
    """Absent is the only case that may be read as "mint one"."""
    assert instance.read_instance(tmp_path) is None
