# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The task.json projection (rosbag2lerobot's per-bag sidecar format)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from kairos_common import atomic_io
from kairos_common.capture_sidecars import RecordV2, write_record
from kairos_common.task_sidecar import (
    TASK_SIDECAR_FILENAME,
    effective_task,
    write_task_sidecar,
)

CAPTURE_ID = "01890000-0000-7000-8000-000000000001"


def _manifest(capture_dir: Path, task: str | None) -> None:
    payload = {
        "schema_version": 2,
        "capture_id": CAPTURE_ID,
        "source_instance_id": "inst",
        "run_id": "run_x",
        "state": "completed",
        "started_at": "2026-08-01T00:00:00.000Z",
        "task": task,
    }
    (capture_dir / "object_manifest.json").write_text(
        json.dumps(payload), encoding="utf-8"
    )


class TestWriteTaskSidecar:
    def test_writes_the_converter_format(self, tmp_path: Path) -> None:
        written = write_task_sidecar(tmp_path, "pick_and_place")

        assert written == tmp_path / TASK_SIDECAR_FILENAME
        assert json.loads(written.read_text(encoding="utf-8")) == {
            "task": "pick_and_place"
        }

    def test_non_ascii_tasks_survive_verbatim(self, tmp_path: Path) -> None:
        # Operators label tasks in their own language; the sidecar must not
        # escape that into \uXXXX soup the converter would still accept but
        # a human reading the archive could not.
        written = write_task_sidecar(tmp_path, "コップを掴む")

        text = written.read_text(encoding="utf-8")
        assert "コップを掴む" in text
        assert json.loads(text) == {"task": "コップを掴む"}

    def test_leaves_no_temp_debris(self, tmp_path: Path) -> None:
        write_task_sidecar(tmp_path, "pick")

        assert [p.name for p in tmp_path.iterdir()] == [TASK_SIDECAR_FILENAME]

    def test_directory_fsync_refusal_does_not_fail_the_write(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # copy_tree_verified tolerates network filesystems that refuse
        # directory fsync; a sidecar written right after that copy must not
        # fail the archive those bytes just passed.
        def refuse(path: Path) -> None:
            raise OSError(22, "Invalid argument")

        monkeypatch.setattr(atomic_io, "fsync_dir", refuse)

        written = write_task_sidecar(tmp_path, "pick")

        assert json.loads(written.read_text(encoding="utf-8")) == {"task": "pick"}

    def test_a_write_that_never_landed_still_raises(self, tmp_path: Path) -> None:
        # bag_dir is a FILE: nothing can be written, and the tolerance must
        # not swallow that — only a landed write may survive an OSError.
        not_a_dir = tmp_path / "bag"
        not_a_dir.write_text("x", encoding="utf-8")

        with pytest.raises(OSError):
            write_task_sidecar(not_a_dir, "pick")


class TestEffectiveTask:
    def test_the_record_override_wins(self, tmp_path: Path) -> None:
        _manifest(tmp_path, "manifest_task")
        write_record(
            tmp_path,
            RecordV2(capture_id=CAPTURE_ID, revision=1, labels={"task": "edited"}),
        )

        assert effective_task(tmp_path, "row_task") == "edited"

    def test_without_an_override_the_manifest_answers(self, tmp_path: Path) -> None:
        _manifest(tmp_path, "manifest_task")
        write_record(tmp_path, RecordV2(capture_id=CAPTURE_ID, revision=1))

        assert effective_task(tmp_path, "row_task") == "manifest_task"

    def test_a_manifest_with_no_task_means_no_task(self, tmp_path: Path) -> None:
        # A readable manifest saying "no task" (imports, §3.3) is an answer,
        # not an error — the fallback must not resurrect a label.
        _manifest(tmp_path, None)

        assert effective_task(tmp_path, "row_task") is None

    def test_unreadable_sidecars_fall_back_to_the_row(self, tmp_path: Path) -> None:
        assert effective_task(tmp_path, "row_task") == "row_task"

    def test_a_corrupt_record_falls_back_to_the_row(self, tmp_path: Path) -> None:
        # The override is unknowable; the row may still carry it, while the
        # manifest definitely predates it.
        _manifest(tmp_path, "manifest_task")
        (tmp_path / "record.json").write_text("{not json", encoding="utf-8")

        assert effective_task(tmp_path, "row_task") == "row_task"
