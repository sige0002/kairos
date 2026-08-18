# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Validation templates: reading a run's topic inventory, drafting a template.

The *checking* moved out of this module: ``fast_validation`` is now a bagflow
flow run on dora (``fast_validation.py`` + ``flows/fast_validation.yml``), and
the required-topic comparison itself lives in the ``bagflow-topic-presence``
node. What stays here is the MCAP-side helper the HTTP API needs — the topic
enumeration behind ``POST /validation/templates/generate``, which turns a
recording into a first draft of the template an operator then edits under
Settings -> Validation.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from dora_runner.mcap_utils import enumerate_topics, find_mcap, resolve_source_dir
from dora_runner.models import ValidationTemplate


def mcap_loader(capture_id: str, data_dir: Path) -> dict[str, Any]:
    """Load a capture's paths and enumerate its MCAP topics."""
    capture_dir = resolve_source_dir(data_dir, capture_id)
    mcap_path = find_mcap(capture_dir)
    return {
        "capture_id": capture_id,
        "capture_dir": str(capture_dir),
        "mcap_path": str(mcap_path),
        "topics": enumerate_topics(mcap_path),
    }


def generate_template(capture_id: str, data_dir: Path) -> ValidationTemplate:
    """Generate a draft validation template from a capture's MCAP topics."""
    loaded = mcap_loader(capture_id, data_dir)
    return ValidationTemplate(
        name=f"{capture_id}_template",
        version=1,
        required_topics=loaded["topics"],
    )
