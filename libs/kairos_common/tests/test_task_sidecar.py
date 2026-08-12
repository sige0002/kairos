"""The task.json projection (rosbag2lerobot's per-bag sidecar format)."""

from __future__ import annotations

import json
from pathlib import Path

from kairos_common.task_sidecar import TASK_SIDECAR_FILENAME, write_task_sidecar


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
