"""Load topic_monitor alert rules from the ALERT_CONFIG_PATH YAML (MON-C1).

The alert engine (:mod:`topic_monitor.alerts`) only does anything in production if
the rules it evaluates are loaded here and injected into :class:`MonitorService`.
The file is optional; its schema is a single top-level ``rules:`` list, each entry
an :class:`~topic_monitor.models.AlertRule`. The canonical, documented template is
``config/template/monitoring/alerts.yaml``.

Failure policy (never hide a config mistake):

- path unset / empty     -> no rules (the monitor runs without alerts).
- path set, file missing -> WARNING log, no rules (tolerate a not-yet-created
  per-robot file rather than refuse to boot).
- file present but broken -> raise (invalid YAML, non-mapping root, non-list
  ``rules``, or a rule failing validation) so startup fails loudly and the
  operator fixes the typo instead of running with silently-empty alerts.
"""

from __future__ import annotations

import logging
from pathlib import Path

import yaml
from pydantic import ValidationError

from topic_monitor.models import AlertRule, DerivedRulesConfig

logger = logging.getLogger("kairos.topic_monitor")


def load_alert_rules(path: str | None) -> list[AlertRule]:
    """Load and validate alert rules from *path* (see the module docstring)."""
    if not path:
        return []
    file = Path(path)
    if not file.exists():
        logger.warning("alert config not found; running with no alert rules: %s", file)
        return []
    with file.open("r", encoding="utf-8") as fh:
        try:
            raw = yaml.safe_load(fh)
        except yaml.YAMLError as exc:
            raise ValueError(f"alert config is not valid YAML: {file}: {exc}") from exc
    rules = _parse_rules(raw, file)
    logger.info("loaded %d alert rule(s) from %s", len(rules), file)
    return rules


def load_derived_config(path: str | None) -> DerivedRulesConfig:
    """Load the optional ``derived_rules:`` block from the same alerts.yaml.

    Returns the defaults (feature enabled) when the path is unset/missing or the
    file has no ``derived_rules:`` block, so the auto-derived rules are on out of
    the box. A present-but-malformed block raises (same loud-failure policy as the
    rules loader) so a config typo is never silently ignored.
    """
    if not path:
        return DerivedRulesConfig()
    file = Path(path)
    if not file.exists():
        return DerivedRulesConfig()
    with file.open("r", encoding="utf-8") as fh:
        try:
            raw = yaml.safe_load(fh)
        except yaml.YAMLError as exc:
            raise ValueError(f"alert config is not valid YAML: {file}: {exc}") from exc
    if raw is None:
        return DerivedRulesConfig()
    if not isinstance(raw, dict):
        raise ValueError(f"alert config root must be a mapping: {file}")
    block = raw.get("derived_rules")
    if block is None:
        return DerivedRulesConfig()
    if not isinstance(block, dict):
        raise ValueError(f"alert config 'derived_rules' must be a mapping: {file}")
    try:
        return DerivedRulesConfig.model_validate(block)
    except ValidationError as exc:
        raise ValueError(f"invalid 'derived_rules' in {file}: {exc}") from exc


def _parse_rules(raw: object, file: Path) -> list[AlertRule]:
    """Convert the parsed YAML document into validated :class:`AlertRule` objects."""
    if raw is None:
        return []  # empty or all-comments file -> no rules
    if not isinstance(raw, dict):
        raise ValueError(f"alert config root must be a mapping with 'rules': {file}")
    rules_raw = raw.get("rules")
    if rules_raw is None:
        return []  # 'rules:' absent or null -> no rules
    if not isinstance(rules_raw, list):
        raise ValueError(f"alert config 'rules' must be a list: {file}")
    rules: list[AlertRule] = []
    for i, item in enumerate(rules_raw):
        if not isinstance(item, dict):
            raise ValueError(f"alert config rule #{i} must be a mapping: {file}")
        try:
            rules.append(AlertRule.model_validate(item))
        except ValidationError as exc:
            raise ValueError(f"invalid alert rule #{i} in {file}: {exc}") from exc
    return rules
