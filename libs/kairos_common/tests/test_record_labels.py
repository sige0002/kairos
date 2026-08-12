# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The §4.3 ``labels`` block: its schema, and the order rebuild applies it in.

``record.json`` gains one optional block. The rule it encodes is that the
recorder's ``object_manifest.json`` is never rewritten, so an operator's
correction to ``operator``/``task``/``robot`` has to live somewhere else and be
laid over the manifest every time the catalog is rebuilt.

Two things are pinned here rather than only at the API level, because both are
properties of the data format and would outlive any particular endpoint:

* an absent key means "not overridden", so clearing an edit is spelled by
  removing the key rather than by writing a null;
* :func:`_capture_row` reads the manifest FIRST and lets the labels correct it.
  Reversed, an edit is silently discarded on the next rebuild.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from kairos_common.capture_sidecars import (
    LABEL_FIELDS,
    ObjectManifestV2,
    RecordV2,
    SidecarStatus,
    read_record,
    record_from_json,
    write_object_manifest,
    write_record,
)
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import rebuild


def _record(capture_id: str, **kwargs) -> RecordV2:
    return RecordV2(capture_id=capture_id, revision=1, **kwargs)


class TestTheBlockIsOptional:
    def test_a_record_without_labels_reads_as_no_overrides(self) -> None:
        record = record_from_json(
            {"schema_version": 2, "capture_id": new_capture_id(), "revision": 1}
        )
        assert record.labels == {}

    def test_an_empty_block_is_not_written(self, tmp_path: Path) -> None:
        """An unlabelled capture's file is what it would have been before §4.3."""
        capture_id = new_capture_id()
        write_record(tmp_path, _record(capture_id))
        assert "labels" not in json.loads(
            (tmp_path / "record.json").read_text(encoding="utf-8")
        )

    def test_a_block_round_trips_through_the_file(self, tmp_path: Path) -> None:
        capture_id = new_capture_id()
        write_record(tmp_path, _record(capture_id, labels={"operator": "bob"}))

        read = read_record(tmp_path)

        assert read.status is SidecarStatus.ok
        assert read.record is not None
        assert read.record.labels == {"operator": "bob"}


class TestWhatTheBlockWillAccept:
    @pytest.mark.parametrize("name", LABEL_FIELDS)
    def test_each_label_field_is_allowed(self, name: str) -> None:
        record = record_from_json(
            {
                "schema_version": 2,
                "capture_id": new_capture_id(),
                "revision": 1,
                "labels": {name: "x"},
            }
        )
        assert record.labels == {name: "x"}

    def test_an_unknown_key_is_rejected(self) -> None:
        """A closed set, so this cannot quietly become a general annotation store."""
        with pytest.raises(ValueError, match="site"):
            record_from_json(
                {
                    "schema_version": 2,
                    "capture_id": new_capture_id(),
                    "revision": 1,
                    "labels": {"site": "warehouse"},
                }
            )

    def test_a_non_string_value_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="operator"):
            record_from_json(
                {
                    "schema_version": 2,
                    "capture_id": new_capture_id(),
                    "revision": 1,
                    "labels": {"operator": 7},
                }
            )

    def test_a_non_object_block_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="labels"):
            record_from_json(
                {
                    "schema_version": 2,
                    "capture_id": new_capture_id(),
                    "revision": 1,
                    "labels": ["operator"],
                }
            )

    def test_a_null_value_is_read_as_absence(self) -> None:
        """Accepted, not refused: it carries no information a reader could lose.

        A client whose PATCH body spells "cleared" as ``null`` should not be
        able to make a capture's sidecar CORRUPT by writing the same word here.
        """
        record = record_from_json(
            {
                "schema_version": 2,
                "capture_id": new_capture_id(),
                "revision": 1,
                "labels": {"operator": None, "task": "pick"},
            }
        )
        assert record.labels == {"task": "pick"}


class TestRebuildAppliesLabelsOverTheManifest:
    def _capture(self, root: Path, capture_id: str, **labels) -> None:
        capture_dir = root / "objects" / capture_id
        capture_dir.mkdir(parents=True)
        (capture_dir / "bag_0.mcap").write_bytes(b"\x89MCAP0\r\n")
        write_object_manifest(
            capture_dir,
            ObjectManifestV2(
                capture_id=capture_id,
                source_instance_id="inst",
                run_id=f"run_{capture_id}",
                state="completed",
                started_at="2026-08-01T00:00:00.000Z",
                operator="alice",
                task="pick",
                robot="myrobot",
            ),
        )
        if labels:
            write_record(capture_dir, _record(capture_id, labels=labels))

    def _row(self, root: Path, capture_id: str):
        result = rebuild(
            root,
            instance_id="inst",
            recorder_reachable=True,
            live_exclusions=(),
        )
        return {row.capture_id: row for row in result.captures}[capture_id]

    def test_the_manifest_stands_when_nothing_overrides_it(
        self, tmp_path: Path
    ) -> None:
        capture_id = new_capture_id()
        self._capture(tmp_path, capture_id)

        row = self._row(tmp_path, capture_id)

        assert (row.operator, row.task, row.robot) == ("alice", "pick", "myrobot")

    def test_an_override_wins(self, tmp_path: Path) -> None:
        capture_id = new_capture_id()
        self._capture(tmp_path, capture_id, operator="bob")

        row = self._row(tmp_path, capture_id)

        assert row.operator == "bob", (
            "the manifest was applied after the labels, so the operator's edit "
            "is discarded every time the catalog is rebuilt"
        )
        # The fields nobody edited still come from the manifest: this is an
        # overlay, not a replacement.
        assert (row.task, row.robot) == ("pick", "myrobot")

    def test_every_label_field_can_be_overridden(self, tmp_path: Path) -> None:
        capture_id = new_capture_id()
        self._capture(
            tmp_path, capture_id, operator="bob", task="place", robot="otherbot"
        )

        row = self._row(tmp_path, capture_id)

        assert (row.operator, row.task, row.robot) == ("bob", "place", "otherbot")
