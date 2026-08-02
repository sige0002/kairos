"""The data directory's invariants (§2) — the guards that have no HTTP surface.

These are small functions, but each one closes a specific way the capture store
could quietly stop being crash-safe: a trash directory on another mount turning
an atomic rename into a copy, a volume marker that cannot tell one disk from
another, a sibling file left behind by a deletion, or a temp file hashed into a
manifest as if it were capture content.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from unittest.mock import patch

import pytest
from api_orchestrator import layout as layout_mod
from api_orchestrator.layout import (
    VOLUME_MARKER_NAME,
    DataLayout,
    capture_siblings,
    check_same_filesystem,
    digest_input_files,
    ensure_volume_marker,
    is_reserved_name,
    move_to_trash,
    purge_from_trash,
    read_volume_marker,
    trash_remnants,
)
from kairos_common.ids import new_capture_id


@pytest.fixture
def layout(tmp_path: Path) -> DataLayout:
    made = DataLayout(data_dir=tmp_path)
    made.ensure_dirs()
    return made


class TestFilesystemGuard:
    def test_one_filesystem_passes(self, layout: DataLayout) -> None:
        assert check_same_filesystem(layout) is None

    def test_a_split_mount_is_reported_with_the_offending_pair(
        self, layout: DataLayout
    ) -> None:
        real_stat = Path.stat

        def fake_stat(self: Path, **kwargs: object):
            result = real_stat(self, **kwargs)
            if self.name == ".trash":
                return os.stat_result(
                    (result.st_mode, result.st_ino, result.st_dev + 1)
                    + tuple(result)[3:]
                )
            return result

        with patch.object(Path, "stat", fake_stat):
            reason = check_same_filesystem(layout)

        assert reason is not None
        # The message names which pair disagreed and why it matters: an operator
        # reading "configuration error" cannot fix a mount.
        assert ".trash" in reason
        assert "atomic" in reason

    def test_directories_are_created_eagerly_so_the_check_can_stat_them(
        self, tmp_path: Path
    ) -> None:
        fresh = DataLayout(data_dir=tmp_path / "fresh")
        fresh.ensure_dirs()
        # A check that silently passes because a directory does not exist yet is
        # worse than no check.
        assert fresh.trash.is_dir()
        assert fresh.incoming.is_dir()


class TestVolumeMarker:
    def test_the_marker_is_created_once_and_kept(self, layout: DataLayout) -> None:
        first = ensure_volume_marker(layout)
        assert first is not None
        assert ensure_volume_marker(layout) == first

    def test_a_missing_marker_reads_as_unknown(self, layout: DataLayout) -> None:
        ensure_volume_marker(layout)
        (layout.data_dir / VOLUME_MARKER_NAME).unlink()
        assert read_volume_marker(layout) is None

    def test_a_corrupt_marker_reads_as_unknown_too(self, layout: DataLayout) -> None:
        ensure_volume_marker(layout)
        (layout.data_dir / VOLUME_MARKER_NAME).write_text("{ not json", "utf-8")
        # "Gone" and "unreadable" must be treated the same: neither can confirm
        # the volume in front of us is the one the catalog describes (§9-3).
        assert read_volume_marker(layout) is None


class TestTrash:
    def test_a_capture_and_its_siblings_move_together(self, layout: DataLayout) -> None:
        capture_id = new_capture_id()
        capture_dir = layout.capture_dir(capture_id)
        capture_dir.mkdir(parents=True)
        (capture_dir / "bag_0.mcap").write_bytes(b"data")
        (layout.objects / f"{capture_id}.qos.yaml").write_text("q: 1\n", "utf-8")
        (layout.objects / f"{capture_id}.failed.json").write_text("{}", "utf-8")

        assert move_to_trash(layout, capture_id) is True
        assert not capture_dir.exists()
        assert (layout.trash_dir(capture_id) / "bag_0.mcap").is_file()
        # A deletion that leaves the failed-start marker behind resurrects the
        # capture on the next rebuild (§3.4).
        assert capture_siblings(layout, capture_id) == []

    def test_moving_something_that_is_not_there_is_a_no_op(
        self, layout: DataLayout
    ) -> None:
        # The resume path calls this without checking first, so "already gone"
        # has to be a successful outcome rather than an error.
        assert move_to_trash(layout, new_capture_id()) is False

    def test_a_second_move_does_not_merge_two_copies(self, layout: DataLayout) -> None:
        capture_id = new_capture_id()
        layout.capture_dir(capture_id).mkdir(parents=True)
        (layout.capture_dir(capture_id) / "first.mcap").write_bytes(b"1")
        move_to_trash(layout, capture_id)

        layout.capture_dir(capture_id).mkdir(parents=True)
        (layout.capture_dir(capture_id) / "second.mcap").write_bytes(b"2")
        move_to_trash(layout, capture_id)

        # The trashed copy is the one the tombstone refers to, so it is kept
        # intact and the newcomer is parked beside it rather than merged in.
        assert (layout.trash_dir(capture_id) / "first.mcap").is_file()
        assert not (layout.trash_dir(capture_id) / "second.mcap").exists()

    def test_purge_confirms_absence(self, layout: DataLayout) -> None:
        capture_id = new_capture_id()
        layout.trash_dir(capture_id).mkdir(parents=True)
        (layout.trash_dir(capture_id) / "bag_0.mcap").write_bytes(b"data")

        # The return value IS the verification §7 step 5 demands: the replica
        # may only become absent_managed once the bytes are provably gone.
        assert purge_from_trash(layout, capture_id) is True
        assert not layout.trash_dir(capture_id).exists()

    def test_purge_reports_failure_when_something_survives(
        self, layout: DataLayout
    ) -> None:
        capture_id = new_capture_id()
        layout.trash_dir(capture_id).mkdir(parents=True)
        with patch("api_orchestrator.layout.shutil.rmtree"):
            assert purge_from_trash(layout, capture_id) is False


class TestDigestInputs:
    def test_the_two_sidecars_the_digest_owns_or_shares_are_excluded(
        self, layout: DataLayout
    ) -> None:
        capture_id = new_capture_id()
        capture_dir = layout.capture_dir(capture_id)
        capture_dir.mkdir(parents=True)
        for name in (
            "bag_0.mcap",
            "metadata.yaml",
            "object_manifest.json",
            "record.json",
        ):
            (capture_dir / name).write_text("x", encoding="utf-8")

        names = {p.name for p in digest_input_files(capture_dir)}
        # The manifest is the file being written (hashing it into itself is not
        # defined) and record.json is mutable — including it would make the
        # capture digest change on every review edit.
        assert names == {"bag_0.mcap", "metadata.yaml"}

    def test_an_atomic_write_in_flight_is_not_hashed(self, layout: DataLayout) -> None:
        capture_id = new_capture_id()
        capture_dir = layout.capture_dir(capture_id)
        capture_dir.mkdir(parents=True)
        (capture_dir / "bag_0.mcap").write_text("x", encoding="utf-8")
        (capture_dir / ".record.json.123-abc.tmp").write_text("x", encoding="utf-8")

        # Sealing a temp file into the manifest would record capture content
        # that is about to be renamed away.
        assert {p.name for p in digest_input_files(capture_dir)} == {"bag_0.mcap"}


class TestReservedNames:
    @pytest.mark.parametrize(
        "name", ["objects", "views", ".trash", ".incoming", "report", "kairos.db"]
    )
    def test_the_stores_own_directories_are_reserved(self, name: str) -> None:
        # An operator or task named like one of these would write captures into
        # the store's own layout (§2).
        assert is_reserved_name(name) is True

    def test_an_ordinary_name_is_not_reserved(self) -> None:
        assert is_reserved_name("alice") is False


class TestDirBytes:
    def test_a_missing_directory_reports_none_not_zero(
        self, layout: DataLayout
    ) -> None:
        # Zero would read as "an empty capture"; None says we could not look.
        assert layout_mod.dir_bytes(layout.data_dir / "nope") is None

    def test_sizes_are_summed_recursively(self, layout: DataLayout) -> None:
        target = layout.data_dir / "sized"
        (target / "nested").mkdir(parents=True)
        (target / "a").write_bytes(b"x" * 10)
        (target / "nested" / "b").write_bytes(b"y" * 5)
        assert layout_mod.dir_bytes(target) == 15


class TestDuplicateParkings:
    """``.duplicate-<pid>`` parkings are still that capture's bytes (M1)."""

    def _park_a_duplicate(self, layout: DataLayout, capture_id: str) -> Path:
        """Drive move_to_trash's salvage branch: two dirs claim one id."""
        layout.trash_dir(capture_id).mkdir(parents=True)
        (layout.trash_dir(capture_id) / "first.mcap").write_bytes(b"1")
        layout.capture_dir(capture_id).mkdir(parents=True)
        (layout.capture_dir(capture_id) / "second.mcap").write_bytes(b"2")
        move_to_trash(layout, capture_id)
        parkings = list(layout.trash.glob(f"{capture_id}.duplicate-*"))
        assert len(parkings) == 1, parkings
        return parkings[0]

    def test_a_parking_is_reported_as_a_remnant(self, layout: DataLayout) -> None:
        capture_id = new_capture_id()
        parking = self._park_a_duplicate(layout, capture_id)
        # If the verification cannot see it, the replica goes absent_managed
        # while these bytes are still on disk.
        assert parking in trash_remnants(layout, capture_id)

    def test_purge_removes_the_parking_too(self, layout: DataLayout) -> None:
        capture_id = new_capture_id()
        parking = self._park_a_duplicate(layout, capture_id)

        assert purge_from_trash(layout, capture_id) is True
        assert not parking.exists()
        assert not layout.trash_dir(capture_id).exists()
        assert trash_remnants(layout, capture_id) == []

    def test_purge_reports_failure_while_a_parking_survives(
        self, layout: DataLayout
    ) -> None:
        capture_id = new_capture_id()
        parking = self._park_a_duplicate(layout, capture_id)
        # The main directory goes; the parking cannot. The reaper must not
        # claim success on the strength of the main directory alone — that is
        # exactly how a replica reaches absent_managed with bytes still there.
        real_rmtree = shutil.rmtree

        def rmtree_except_the_parking(path, *args, **kwargs):  # noqa: ANN001
            if Path(path) == parking:
                return
            real_rmtree(path, *args, **kwargs)

        with patch("api_orchestrator.layout.shutil.rmtree", rmtree_except_the_parking):
            assert purge_from_trash(layout, capture_id) is False
        assert parking.exists()
        assert trash_remnants(layout, capture_id) == [parking]

    def test_remnants_are_empty_for_an_untouched_capture(
        self, layout: DataLayout
    ) -> None:
        assert trash_remnants(layout, new_capture_id()) == []
