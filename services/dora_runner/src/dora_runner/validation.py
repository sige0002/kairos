"""Validation templates: reading a run's topic inventory, drafting a template.

The *checking* moved out of this module: ``fast_validation`` is now a bagflow
flow run on dora (``fast_validation.py`` + ``flows/fast_validation.yml``), and
the required-topic comparison itself lives in the ``bagflow-topic-presence``
node. What stays here is the MCAP-side helper the HTTP API needs — the topic
enumeration behind ``POST /validation/templates/generate``, which turns a
recording into a first draft of the template an operator then edits in the
Config tab.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from dora_runner.mcap_utils import enumerate_topics, find_mcap, validate_run_id
from dora_runner.models import ValidationTemplate


def mcap_loader(run_id: str, data_dir: Path) -> dict[str, Any]:
    """Load a run's paths and enumerate its MCAP topics."""
    validate_run_id(run_id)
    run_dir = data_dir / "recorded" / run_id
    mcap_path = find_mcap(run_dir)
    return {
        "run_id": run_id,
        "run_dir": str(run_dir),
        "mcap_path": str(mcap_path),
        "topics": enumerate_topics(mcap_path),
    }


def generate_template(run_id: str, data_dir: Path) -> ValidationTemplate:
    """Generate a draft validation template from a run's MCAP topics."""
    loaded = mcap_loader(run_id, data_dir)
    return ValidationTemplate(
        name=f"{run_id}_template",
        version=1,
        required_topics=loaded["topics"],
    )
