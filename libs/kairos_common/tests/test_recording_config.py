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
from pydantic import ValidationError

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


def test_transfer_auto_pull_default_and_override(tmp_path: Path) -> None:
    """transfer.auto_pull_on_save (split importer Save-trigger, orchestrator-
    read) defaults to OFF — nothing transfers without an explicit opt-in — and
    is overridable per robot. The section is optional for older configs."""
    cfg = load_recording_config(TEMPLATE)
    assert cfg.transfer.auto_pull_on_save is False

    cfg_path = tmp_path / "c.yaml"
    cfg_path.write_text(
        "robot_name: r\ntransfer:\n  auto_pull_on_save: true\n",
        encoding="utf-8",
    )
    assert load_recording_config(cfg_path).transfer.auto_pull_on_save is True


def test_the_quick_check_duration_floor_has_a_default() -> None:
    """A deployment that never wrote a validation section still gets a floor.

    Without a default, the stop-time quick check would have no opinion about
    duration on exactly the installs least likely to have tuned anything — and
    an accidental double-click would read as a healthy take.
    """
    config = RecordingConfig.model_validate({"robot_name": "r"})
    assert config.validation.min_duration_s == 2.0


def test_the_duration_floor_is_configurable() -> None:
    config = RecordingConfig.model_validate(
        {"robot_name": "r", "validation": {"min_duration_s": 7.5}}
    )
    assert config.validation.min_duration_s == 7.5


def test_zero_disables_the_duration_floor() -> None:
    config = RecordingConfig.model_validate(
        {"robot_name": "r", "validation": {"min_duration_s": 0}}
    )
    assert config.validation.min_duration_s == 0


def test_a_negative_floor_is_rejected() -> None:
    # A negative minimum is not a looser rule, it is a nonsensical one; failing
    # at config load beats silently never firing.
    with pytest.raises(ValidationError):
        RecordingConfig.model_validate(
            {"robot_name": "r", "validation": {"min_duration_s": -1}}
        )


def test_syntactically_broken_yaml_is_a_ValueError_naming_the_file(
    tmp_path: Path,
) -> None:
    """E-20, config half: someone edits the file by hand and leaves it invalid.

    The loaders promise ``ValueError`` for a config they cannot use, and every
    caller catches that (plus OSError) to degrade with a warning. PyYAML's
    ``YAMLError`` is neither, so before this an unparseable file did not
    degrade — it came out of ``create_orchestrator_app`` as a raw scanner
    traceback and the service did not start at all, over a file the same
    handler was already written to tolerate.
    """
    path = tmp_path / "recording.yaml"
    # A tab where YAML forbids one, which is what a hand edit tends to produce.
    path.write_text("robot_name: r\ntopics:\n\t- /a\n", encoding="utf-8")

    with pytest.raises(ValueError) as excinfo:
        load_recording_config(path)
    assert str(path) in str(excinfo.value)
