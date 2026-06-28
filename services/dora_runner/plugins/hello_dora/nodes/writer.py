"""result_writer node: persist summary.json under the run's report directory."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def write_summary(summary: dict[str, Any], report_dir: Path) -> Path:
    report_dir.mkdir(parents=True, exist_ok=True)
    summary_path = report_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary_path


def process(inputs: dict[str, Any], ctx: Any) -> dict[str, Any]:
    write_summary(inputs["summary"], ctx.report_dir)
    return {}  # terminal node — no outputs


def main() -> None:  # pragma: no cover - requires the dora daemon
    import json as _json

    from dora import Node

    node = Node()
    report_dir = Path(os.environ["KAIROS_REPORT_DIR"])
    for event in node:
        if event["type"] == "INPUT" and event["id"] == "summary":
            summary = _json.loads(event["value"][0].as_py())
            write_summary(summary, report_dir)
            return


if __name__ == "__main__":  # pragma: no cover
    main()
