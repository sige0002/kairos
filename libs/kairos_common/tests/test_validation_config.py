"""Tests for the validation-template loader (VALIDATION_CONFIG)."""

from __future__ import annotations

from pathlib import Path

import pytest
from kairos_common import ValidationTemplate, load_validation_template

REPO_ROOT = Path(__file__).resolve().parents[3]
VALIDATION_DIR = REPO_ROOT / "config" / "validation"


def test_loads_committed_samples() -> None:
    """Every committed config/validation/*.yaml must load and validate."""
    files = sorted(VALIDATION_DIR.glob("*.yaml"))
    assert files, "expected at least one validation template"
    for path in files:
        tmpl = load_validation_template(path)
        assert isinstance(tmpl, ValidationTemplate)
        assert tmpl.name
        assert tmpl.required_topics


def test_hsr_required_topics() -> None:
    tmpl = load_validation_template(VALIDATION_DIR / "airoa_hsr.yaml")
    names = {t.name for t in tmpl.required_topics}
    assert "/hsrb/joint_states" in names
    assert "/tf" in names


def test_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_validation_template(tmp_path / "nope.yaml")


def test_unknown_key_rejected(tmp_path: Path) -> None:
    bad = tmp_path / "bad.yaml"
    # 'topics' is a typo for 'required_topics' -> rejected (extra="forbid").
    bad.write_text("name: x\nversion: 1\ntopics: []\n", encoding="utf-8")
    with pytest.raises(ValueError):
        load_validation_template(bad)
