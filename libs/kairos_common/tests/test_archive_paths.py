"""The KAIROS_ARCHIVE_ROOTS allow-list.

Archiving copies a dataset out and then DELETES the source, so the destination
is the string that decides what gets removed from disk. These tests pin the
boundary: what parses as a root, what is accepted under one, and — mostly —
what must never be accepted, including the two escapes that look like paths
under a root but are not (``..`` and a planted symlink).
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from kairos_common import ApiError
from kairos_common.archive_paths import (
    archive_enabled,
    parse_archive_roots,
    resolve_archive_destination,
)

ROOTS = [Path("/mnt/nas/datasets"), Path("/mnt/backup")]


def _code(exc: ApiError) -> str:
    return exc.code


# ---- parsing ---------------------------------------------------------------


def test_parses_colon_separated_absolute_paths() -> None:
    assert parse_archive_roots("/mnt/nas/datasets:/mnt/backup") == ROOTS


def test_blank_and_relative_entries_are_dropped_not_resolved() -> None:
    """A relative root would invent a boundary from the process's cwd."""
    roots = parse_archive_roots("/mnt/nas: : relative/path :/mnt/nas")
    assert roots == [Path("/mnt/nas")]  # deduplicated, relative dropped


def test_unset_means_the_feature_is_off() -> None:
    for raw in (None, "", "   ", ":::"):
        roots = parse_archive_roots(raw)
        assert roots == []
        assert archive_enabled(roots) is False


def test_a_root_is_normalized_but_a_missing_one_is_kept() -> None:
    """An unmounted NAS is a mount problem to report, not a narrower allow-list."""
    assert parse_archive_roots("/mnt/nas/../nas/datasets") == [
        Path("/mnt/nas/datasets")
    ]
    assert parse_archive_roots("/definitely/not/mounted") == [
        Path("/definitely/not/mounted")
    ]


# ---- what is allowed -------------------------------------------------------


def test_a_subpath_under_a_root_is_accepted() -> None:
    assert resolve_archive_destination("/mnt/nas/datasets/op/task/003", ROOTS) == Path(
        "/mnt/nas/datasets/op/task/003"
    )


def test_the_root_itself_is_accepted_and_the_second_root_counts() -> None:
    assert resolve_archive_destination("/mnt/backup", ROOTS) == Path("/mnt/backup")
    assert resolve_archive_destination("/mnt/backup/x", ROOTS) == Path("/mnt/backup/x")


def test_surrounding_whitespace_is_tolerated() -> None:
    assert resolve_archive_destination("  /mnt/backup/x  ", ROOTS) == Path(
        "/mnt/backup/x"
    )


# ---- what must never be allowed --------------------------------------------


def test_traversal_out_of_a_root_is_refused() -> None:
    for destination in (
        "/mnt/nas/datasets/../../etc",
        "/mnt/nas/datasets/../../../",
        "/mnt/nas/datasets/ok/../../../tmp/x",
    ):
        with pytest.raises(ApiError) as excinfo:
            resolve_archive_destination(destination, ROOTS)
        assert _code(excinfo.value) == "destination_not_allowed"


def test_an_unrelated_absolute_path_is_refused() -> None:
    for destination in ("/etc/passwd", "/", "/mnt", "/mnt/nas"):
        with pytest.raises(ApiError) as excinfo:
            resolve_archive_destination(destination, ROOTS)
        assert _code(excinfo.value) == "destination_not_allowed"


def test_a_sibling_sharing_the_roots_prefix_is_refused() -> None:
    """/mnt/backup-evil starts with /mnt/backup as a STRING but is not under it."""
    with pytest.raises(ApiError) as excinfo:
        resolve_archive_destination("/mnt/backup-evil/x", ROOTS)
    assert _code(excinfo.value) == "destination_not_allowed"


def test_a_relative_or_empty_destination_is_refused() -> None:
    for destination in ("", "   ", "relative/path", "./x"):
        with pytest.raises(ApiError) as excinfo:
            resolve_archive_destination(destination, ROOTS)
        assert _code(excinfo.value) == "invalid_destination"


def test_no_roots_configured_refuses_everything_distinguishably(tmp_path: Path) -> None:
    """The UI keys off this code to hide the control rather than offer a 400."""
    with pytest.raises(ApiError) as excinfo:
        resolve_archive_destination(str(tmp_path / "x"), [])
    assert _code(excinfo.value) == "archive_not_configured"
    assert excinfo.value.status_code == 400


def test_a_symlink_under_a_root_cannot_redirect_outside_it(tmp_path: Path) -> None:
    """The escape a string-prefix check would miss — and the copy would then
    delete the source after writing through the link."""
    root = tmp_path / "archive"
    (root / "inner").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, root / "escape")

    roots = [root]
    # The honest path under the root still works…
    assert resolve_archive_destination(str(root / "inner" / "ep"), roots) == (
        root / "inner" / "ep"
    )
    # …but one that traverses the symlink resolves outside and is refused.
    with pytest.raises(ApiError) as excinfo:
        resolve_archive_destination(str(root / "escape" / "ep"), roots)
    assert _code(excinfo.value) == "destination_not_allowed"


def test_a_symlinked_root_still_matches_its_own_contents(tmp_path: Path) -> None:
    """Resolving both sides must not break the legitimate case of a root that
    is itself a symlink (a very common NAS mount layout)."""
    real = tmp_path / "real_nas"
    real.mkdir()
    link = tmp_path / "nas"
    os.symlink(real, link)

    assert resolve_archive_destination(str(link / "op" / "001"), [link]) == (
        link / "op" / "001"
    )
