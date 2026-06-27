"""Tests for the Stream tab layout config loader (STREAM_CONFIG)."""

from __future__ import annotations

from pathlib import Path

import pytest
from kairos_common import StreamConfig, load_stream_config

REPO_ROOT = Path(__file__).resolve().parents[3]
SAMPLE = REPO_ROOT / "config" / "airoa_hsr" / "stream" / "default.yaml"


def test_loads_committed_sample() -> None:
    """The committed config/<robot>/stream/default.yaml must load and validate."""
    cfg = load_stream_config(SAMPLE)
    assert isinstance(cfg, StreamConfig)
    assert cfg.columns == 2
    topics = [p.topic for p in cfg.panes]
    assert "/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed" in topics
    assert "/hsrb/hand_camera/image_raw/compressed" in topics


def test_defaults_when_empty(tmp_path: Path) -> None:
    cfg = load_stream_config(_write(tmp_path, "panes: []\n"))
    assert cfg.columns == 2
    assert cfg.panes == []


def test_pane_topic_optional(tmp_path: Path) -> None:
    cfg = load_stream_config(_write(tmp_path, "panes:\n  - {}\n"))
    assert cfg.panes[0].topic is None


def test_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_stream_config(tmp_path / "nope.yaml")


def test_columns_out_of_range_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        load_stream_config(_write(tmp_path, "columns: 9\npanes: []\n"))


def test_unknown_key_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        load_stream_config(_write(tmp_path, "rows: 2\npanes: []\n"))


def _write(tmp_path: Path, text: str) -> Path:
    p = tmp_path / "stream.yaml"
    p.write_text(text, encoding="utf-8")
    return p
