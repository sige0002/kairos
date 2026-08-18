# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The shared atomic write: nothing half-written, and no debris either way."""

from __future__ import annotations

import errno
import json
import os
from pathlib import Path

import pytest
from kairos_common import atomic_io


def _temp_files(directory: Path) -> list[str]:
    return [p.name for p in directory.iterdir() if p.name.endswith(".tmp")]


def test_write_lands_the_content_and_leaves_no_temp_file(tmp_path: Path) -> None:
    """A leftover temp inside objects/<capture_id>/ would be scanned as capture
    content and hashed into the digest, so success must clean up after itself."""
    target = tmp_path / "object_manifest.json"

    written = atomic_io.atomic_write_text(target, "hello")

    assert written == target
    assert target.read_text(encoding="utf-8") == "hello"
    assert _temp_files(tmp_path) == []


def test_write_creates_missing_parent_directories(tmp_path: Path) -> None:
    target = tmp_path / "objects" / "abc" / "record.json"

    atomic_io.atomic_write_text(target, "x")

    assert target.read_text(encoding="utf-8") == "x"


def test_json_is_indented_with_a_trailing_newline(tmp_path: Path) -> None:
    """These files are read by a human during an incident as often as by code."""
    target = tmp_path / "instance.json"

    atomic_io.atomic_write_json(target, {"schema_version": 2, "operator": "田中"})

    raw = target.read_text(encoding="utf-8")
    assert raw.endswith("}\n")
    assert "\n  " in raw
    assert "田中" in raw  # ensure_ascii=False keeps names legible
    assert json.loads(raw)["schema_version"] == 2


def test_a_failed_write_leaves_no_file_and_no_debris(
    tmp_path: Path, monkeypatch
) -> None:
    """Power loss during the write must not create the 0-byte manifest that §8
    rule 4 then has to classify as CORRUPT."""
    target = tmp_path / "object_manifest.json"
    monkeypatch.setattr(os, "fsync", _boom)

    with pytest.raises(OSError):
        atomic_io.atomic_write_text(target, "never lands")

    assert not target.exists()
    assert _temp_files(tmp_path) == []


def test_a_failed_write_leaves_the_previous_content_intact(
    tmp_path: Path, monkeypatch
) -> None:
    """The single-writer handover in §3.3 depends on this: a digest job that
    dies mid-write must not damage the manifest the recorder finalised."""
    target = tmp_path / "object_manifest.json"
    atomic_io.atomic_write_text(target, "the finalised manifest")
    monkeypatch.setattr(os, "fsync", _boom)

    with pytest.raises(OSError):
        atomic_io.atomic_write_text(target, "the half-written replacement")

    assert target.read_text(encoding="utf-8") == "the finalised manifest"
    assert _temp_files(tmp_path) == []


def test_a_failed_replace_leaves_the_previous_content_intact(
    tmp_path: Path, monkeypatch
) -> None:
    target = tmp_path / "record.json"
    atomic_io.atomic_write_text(target, "revision 1")
    monkeypatch.setattr(os, "replace", _boom)

    with pytest.raises(OSError):
        atomic_io.atomic_write_text(target, "revision 2")

    assert target.read_text(encoding="utf-8") == "revision 1"
    assert _temp_files(tmp_path) == []


def test_concurrent_writers_do_not_share_a_temp_file(tmp_path: Path) -> None:
    """Two writers racing on one target must not truncate each other's bytes
    and then rename the mixture into place, so the temp name is unique."""
    target = tmp_path / "object_manifest.json"

    first = atomic_io._temp_path(target)
    second = atomic_io._temp_path(target)

    assert first != second
    assert first.parent == target.parent  # same filesystem, or replace is a copy


def test_the_durability_steps_happen_in_the_only_order_that_is_safe(
    tmp_path: Path, monkeypatch
) -> None:
    """The whole point of the helper. fsync(tmp) must precede os.replace, or the
    rename can reach disk while the data behind it has not — the crash that
    leaves a correct filename pointing at zero bytes. And the parent directory's
    fsync must follow the replace, since it is the rename that has to persist.
    """
    order: list[str] = []
    real_fsync, real_replace = os.fsync, os.replace

    def record_fsync(fd):
        order.append("fsync(tmp)")
        return real_fsync(fd)

    def record_replace(src, dst):
        order.append("replace")
        return real_replace(src, dst)

    def record_fsync_dir(path):
        # Recorded but not performed: the real one calls os.fsync itself, which
        # is patched above and would log a second "fsync(tmp)".
        order.append("fsync(dir)")

    monkeypatch.setattr(os, "fsync", record_fsync)
    monkeypatch.setattr(os, "replace", record_replace)
    monkeypatch.setattr(atomic_io, "fsync_dir", record_fsync_dir)

    atomic_io.atomic_write_text(tmp_path / "object_manifest.json", "durable")

    assert order == ["fsync(tmp)", "replace", "fsync(dir)"]


def test_create_exclusive_claims_the_name_only_once(tmp_path: Path) -> None:
    """Identity files need "claim this name", not "make this file say X": two
    services starting together must agree on one id, not overwrite in turn."""
    target = tmp_path / "instance.json"

    assert atomic_io.create_exclusive_json(target, {"instance_id": "first"}) is True
    assert atomic_io.create_exclusive_json(target, {"instance_id": "second"}) is False

    assert json.loads(target.read_text(encoding="utf-8"))["instance_id"] == "first"
    assert _temp_files(tmp_path) == []


def test_without_hard_links_the_claim_still_refuses_to_overwrite(
    tmp_path: Path, monkeypatch
) -> None:
    """On a filesystem that refuses os.link the fallback must keep the property
    that matters: the first id written is the installation's id, and a later
    caller adopts it instead of replacing it."""

    def no_links(*args, **kwargs):
        raise OSError(errno.EPERM, "Operation not permitted")

    monkeypatch.setattr(os, "link", no_links)
    target = tmp_path / "instance.json"

    assert atomic_io.create_exclusive_json(target, {"instance_id": "winner"}) is True
    assert atomic_io.create_exclusive_json(target, {"instance_id": "loser"}) is False

    assert json.loads(target.read_text(encoding="utf-8"))["instance_id"] == "winner"
    assert _temp_files(tmp_path) == []


def test_fsync_dir_accepts_a_directory(tmp_path: Path) -> None:
    """Callers that rename or unlink themselves (trash moves, slack release)
    need this step without reimplementing it."""
    atomic_io.fsync_dir(tmp_path)


def _boom(*args, **kwargs):
    raise OSError("simulated I/O failure")
