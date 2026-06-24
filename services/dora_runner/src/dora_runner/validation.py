"""fast_validation nodes and in-process executor."""

from __future__ import annotations

import fnmatch
import json
from pathlib import Path
from typing import Any

from kairos_common import utc_now_iso8601

from dora_runner.mcap_utils import enumerate_topics, find_mcap
from dora_runner.models import ValidationTemplate


def mcap_loader(run_id: str, data_dir: Path) -> dict[str, Any]:
    """Node contract: load run paths and enumerate MCAP topics."""
    run_dir = data_dir / "recorded" / run_id
    mcap_path = find_mcap(run_dir)
    return {
        "run_id": run_id,
        "run_dir": str(run_dir),
        "mcap_path": str(mcap_path),
        "topics": enumerate_topics(mcap_path),
    }


def validator(loaded: dict[str, Any], template: ValidationTemplate) -> dict[str, Any]:
    """Node contract: compare enumerated topics to the validation template."""
    actual = {
        str(topic["name"]): str(topic.get("type") or "") for topic in loaded["topics"]
    }
    missing: list[dict[str, str | None]] = []
    matched_names: set[str] = set()
    for required in template.required_topics:
        matches = [
            (name, type_)
            for name, type_ in actual.items()
            if fnmatch.fnmatch(name, required.name)
        ]
        if required.type is not None:
            matches = [
                (name, type_) for name, type_ in matches if type_ == required.type
            ]
        if not matches:
            missing.append(required.model_dump())
            continue
        matched_names.update(name for name, _type in matches)

    extra = [
        {"name": name, "type": type_}
        for name, type_ in sorted(actual.items())
        if name not in matched_names
    ]
    return {
        "template": {"name": template.name, "version": template.version},
        "result": "fail" if missing else "pass",
        "missing": missing,
        "extra": extra,
        "checked_at": utc_now_iso8601(),
    }


def result_writer(
    summary: dict[str, Any], data_dir: Path, run_id: str
) -> dict[str, Any]:
    """Node contract: persist the validation summary artifact."""
    report_dir = data_dir / "report" / "fast_validation" / run_id
    report_dir.mkdir(parents=True, exist_ok=True)
    summary_path = report_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return {
        "summary": summary,
        "artifacts": [str(summary_path)],
    }


def run_fast_validation(
    *,
    run_id: str,
    data_dir: Path,
    template: ValidationTemplate,
) -> dict[str, Any]:
    """Run the v1 dataflow in-process.

    This intentionally keeps dora-style node boundaries while avoiding a dora
    coordinator/daemon, so CI and unit tests can execute the v1 pipeline.
    """
    loaded = mcap_loader(run_id, data_dir)
    summary = validator(loaded, template)
    return result_writer(summary, data_dir, run_id)


def generate_template(run_id: str, data_dir: Path) -> ValidationTemplate:
    """Generate a draft validation template from a run's MCAP topics."""
    loaded = mcap_loader(run_id, data_dir)
    return ValidationTemplate(
        name=f"{run_id}_template",
        version=1,
        required_topics=loaded["topics"],
    )
