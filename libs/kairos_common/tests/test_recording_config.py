"""Tests for the RECORDING_CONFIG loader and the Settings model."""

from __future__ import annotations

from pathlib import Path

import pytest
from kairos_common import (
    Compression,
    RecordingConfig,
    Reliability,
    Settings,
    load_recording_config,
)
from kairos_common.recording_config import Durability

# The canonical template lives at repo root; resolve it relative to this file.
REPO_ROOT = Path(__file__).resolve().parents[3]
# The copy-from template robot (config/template/) — modelled on airoa_hsr.
TEMPLATE = REPO_ROOT / "config" / "template" / "recording" / "default.yaml"


def test_loads_canonical_template() -> None:
    """The committed template robot must load and validate cleanly."""
    cfg = load_recording_config(TEMPLATE)
    assert isinstance(cfg, RecordingConfig)
    assert cfg.robot_name
    assert cfg.default_topics
    assert cfg.recording.storage.value == "mcap"
    assert cfg.recording.compression is Compression.none


def test_qos_override_enums_parsed(tmp_path: Path) -> None:
    # Self-contained: the shipped template defaults topic_qos_overrides to []
    # (rosbag2 QoS adaptation), so build a config that exercises override parsing.
    cfg_path = tmp_path / "c.yaml"
    cfg_path.write_text(
        "robot_name: r\n"
        "topic_qos_overrides:\n"
        '  - { pattern: "**/compressed", reliability: best_effort,'
        " durability: volatile, depth: 1 }\n"
    )
    cfg = load_recording_config(cfg_path)
    first = cfg.topic_qos_overrides[0]
    assert first.reliability is Reliability.best_effort
    assert first.durability is Durability.volatile
    assert first.depth == 1


def test_expected_hz_pattern_optional_hz(tmp_path: Path) -> None:
    """A pattern with no hz must parse as None (dynamic-learn)."""
    cfg_path = tmp_path / "c.yaml"
    cfg_path.write_text(
        "robot_name: r\n"
        "expected_hz_patterns:\n"
        '  - pattern: "/a"\n'
        '  - pattern: "/b"\n'
        "    hz: 30\n",
        encoding="utf-8",
    )
    cfg = load_recording_config(cfg_path)
    assert cfg.expected_hz_patterns[0].hz is None
    assert cfg.expected_hz_patterns[1].hz == 30


def test_prepare_disarm_timeout_default_and_override(tmp_path: Path) -> None:
    """recording.prepare_disarm_timeout_s (two-phase start) defaults to 120s
    and is overridable, following the same pattern as the other recording
    tuning knobs."""
    cfg = load_recording_config(TEMPLATE)
    assert cfg.recording.prepare_disarm_timeout_s == 120.0

    cfg_path = tmp_path / "c.yaml"
    cfg_path.write_text(
        "robot_name: r\nrecording:\n  prepare_disarm_timeout_s: 30\n",
        encoding="utf-8",
    )
    assert load_recording_config(cfg_path).recording.prepare_disarm_timeout_s == 30


def test_pre_arm_default_and_override(tmp_path: Path) -> None:
    """recording.pre_arm (Console two-phase pre-arm, frontend-read) defaults to
    on and is overridable per robot."""
    cfg = load_recording_config(TEMPLATE)
    assert cfg.recording.pre_arm is True

    cfg_path = tmp_path / "c.yaml"
    cfg_path.write_text(
        "robot_name: r\nrecording:\n  pre_arm: false\n",
        encoding="utf-8",
    )
    assert load_recording_config(cfg_path).recording.pre_arm is False


def test_missing_robot_name_is_rejected(tmp_path: Path) -> None:
    cfg_path = tmp_path / "c.yaml"
    cfg_path.write_text("default_topics: [/tf]\n", encoding="utf-8")
    with pytest.raises(ValueError, match="robot_name"):
        load_recording_config(cfg_path)


def test_unknown_key_is_rejected(tmp_path: Path) -> None:
    """Unknown keys are typos; loading must fail loudly."""
    cfg_path = tmp_path / "c.yaml"
    cfg_path.write_text(
        "robot_name: r\ndefault_topcs: [/tf]\n",  # typo: topcs
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="default_topcs"):
        load_recording_config(cfg_path)


def test_invalid_qos_enum_is_rejected(tmp_path: Path) -> None:
    cfg_path = tmp_path / "c.yaml"
    cfg_path.write_text(
        "robot_name: r\n"
        "topic_qos_overrides:\n"
        '  - pattern: "*"\n'
        "    reliability: sometimes\n"  # invalid enum
        "    durability: volatile\n"
        "    depth: 1\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="reliability"):
        load_recording_config(cfg_path)


def test_missing_file_raises() -> None:
    with pytest.raises(FileNotFoundError):
        load_recording_config("/no/such/recording.yaml")


def test_settings_defaults() -> None:
    """Settings should expose the documented defaults when env is empty."""
    s = Settings(_env_file=None)
    assert s.ros_domain_id == 0
    assert s.ros_distro == "jazzy"
    assert s.api_orch_port == 8000
    assert s.topic_monitor_port == 8001
    assert s.webrtc_port == 8002
    assert s.frontend_port == 8080
    assert s.bind_host == "0.0.0.0"


def test_settings_cors_origins_split_from_string(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A comma-separated CORS_ORIGINS env string must split into a list."""
    monkeypatch.setenv("CORS_ORIGINS", "http://a:1, http://b:2")
    s = Settings(_env_file=None)
    assert s.cors_origins == ["http://a:1", "http://b:2"]
