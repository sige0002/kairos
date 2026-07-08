"""Tests for the committed-vs-local config path resolution."""

from __future__ import annotations

from pathlib import Path

from kairos_common import resolve_config_path


def _mk(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}\n", encoding="utf-8")
    return path


def test_existing_path_is_returned_unchanged(tmp_path: Path) -> None:
    committed = _mk(tmp_path / "config" / "bot" / "recording" / "default.yaml")
    assert resolve_config_path(str(committed)) == str(committed)


def test_missing_committed_path_falls_back_to_local_twin(tmp_path: Path) -> None:
    local = _mk(tmp_path / "config" / "local" / "bot" / "recording" / "default.yaml")
    given = str(tmp_path / "config" / "bot" / "recording" / "default.yaml")
    assert resolve_config_path(given) == str(local)


def test_missing_path_without_local_twin_is_returned_unchanged(
    tmp_path: Path,
) -> None:
    given = str(tmp_path / "config" / "bot" / "recording" / "default.yaml")
    assert resolve_config_path(given) == given


def test_local_path_is_never_rewritten(tmp_path: Path) -> None:
    given = str(tmp_path / "config" / "local" / "bot" / "recording" / "default.yaml")
    assert resolve_config_path(given) == given


def test_empty_path_means_disabled_and_stays_empty() -> None:
    assert resolve_config_path("") == ""


def test_path_without_config_segment_is_returned_unchanged(tmp_path: Path) -> None:
    given = str(tmp_path / "etc" / "bot" / "default.yaml")
    assert resolve_config_path(given) == given
