"""Alert-rule YAML loader (MON-C1): valid load, missing file, malformed.

These lock in the failure policy: an unset/missing path yields no rules (the
monitor boots without alerts), while a present-but-broken file raises so a config
typo fails startup loudly instead of running with silently-empty alerts.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from topic_monitor.alert_config import load_alert_rules, load_derived_config
from topic_monitor.models import AlertMetric, AlertOp


def _write(tmp_path: Path, text: str) -> str:
    p = tmp_path / "alerts.yaml"
    p.write_text(text, encoding="utf-8")
    return str(p)


def test_none_path_returns_no_rules() -> None:
    assert load_alert_rules(None) == []
    assert load_alert_rules("") == []


def test_missing_file_warns_and_returns_no_rules(tmp_path: Path) -> None:
    # A not-yet-created per-robot file must not crash the monitor.
    rules = load_alert_rules(str(tmp_path / "does_not_exist.yaml"))
    assert rules == []


def test_parses_a_valid_rule_with_all_fields(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        "rules:\n"
        "  - topic: /hsrb/joint_states\n"
        "    metric: hz\n"
        "    op: lt\n"
        "    threshold: 15\n"
        "    clear_after_s: 3\n"
        "    cooldown_s: 10\n",
    )
    rules = load_alert_rules(path)
    assert len(rules) == 1
    rule = rules[0]
    assert rule.topic == "/hsrb/joint_states"
    assert rule.metric == AlertMetric.hz
    assert rule.op == AlertOp.lt
    assert rule.threshold == 15.0
    assert rule.clear_after_s == 3.0
    assert rule.cooldown_s == 10.0


def test_rule_defaults_when_hysteresis_omitted(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        "rules:\n  - topic: /cam\n    metric: gap\n    op: gt\n    threshold: 200\n",
    )
    (rule,) = load_alert_rules(path)
    assert rule.clear_after_s == 0.0 and rule.cooldown_s == 0.0


def test_empty_or_comment_only_file_returns_no_rules(tmp_path: Path) -> None:
    assert load_alert_rules(_write(tmp_path, "# just a comment\n")) == []


def test_rules_key_null_returns_no_rules(tmp_path: Path) -> None:
    # `rules: []` and a bare `rules:` both mean "no rules", not an error.
    assert load_alert_rules(_write(tmp_path, "rules:\n")) == []
    assert load_alert_rules(_write(tmp_path, "rules: []\n")) == []


def test_root_not_a_mapping_raises(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        load_alert_rules(_write(tmp_path, "- not\n- a\n- mapping\n"))


def test_rules_not_a_list_raises(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        load_alert_rules(_write(tmp_path, "rules: 42\n"))


def test_rule_item_not_a_mapping_raises(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        load_alert_rules(_write(tmp_path, "rules:\n  - just_a_string\n"))


def test_invalid_rule_field_raises(tmp_path: Path) -> None:
    # `metric: bogus` is not in the AlertMetric vocabulary -> validation error.
    with pytest.raises(ValueError):
        load_alert_rules(
            _write(
                tmp_path,
                "rules:\n  - topic: /cam\n    metric: bogus\n    op: lt\n"
                "    threshold: 1\n",
            )
        )


def test_malformed_yaml_raises_value_error(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        load_alert_rules(_write(tmp_path, "rules: [unclosed\n"))


# --- derived_rules block (load_derived_config) ----------------------------


def test_derived_config_defaults_when_unset_or_absent(tmp_path: Path) -> None:
    # No path, missing file, and a file without a derived_rules block all yield
    # the defaults (feature enabled) so auto-derived rules work out of the box.
    for cfg in (
        load_derived_config(None),
        load_derived_config(str(tmp_path / "missing.yaml")),
        load_derived_config(_write(tmp_path, "rules: []\n")),
    ):
        assert cfg.enabled is True
        assert cfg.warn_ratio == 0.8
        assert cfg.danger_ratio == 0.5


def test_derived_config_parses_overrides(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        "derived_rules:\n"
        "  enabled: false\n"
        "  warn_ratio: 0.9\n"
        "  danger_ratio: 0.6\n"
        "  sustain_s: 4\n",
    )
    cfg = load_derived_config(path)
    assert cfg.enabled is False
    assert cfg.warn_ratio == 0.9
    assert cfg.danger_ratio == 0.6
    assert cfg.sustain_s == 4.0


def test_derived_config_malformed_block_raises(tmp_path: Path) -> None:
    # A present-but-wrong block fails loudly (same policy as the rules loader).
    with pytest.raises(ValueError):
        load_derived_config(_write(tmp_path, "derived_rules: 42\n"))
    with pytest.raises(ValueError):
        # warn_ratio > 1 violates the field bound.
        load_derived_config(_write(tmp_path, "derived_rules:\n  warn_ratio: 2.0\n"))
