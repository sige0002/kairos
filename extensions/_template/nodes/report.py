"""census node: count messages per topic in the recorded MCAP -> summary.json.

Extension-template node. Dual-mode like every kairos plugin node:

* ``process(inputs, ctx)`` — pure logic, called by dora_runner's in-process
  interpreter (the actual path on hosts without the dora CLI) and by tests.
* ``main()`` — the dora event loop for a real ``dora start`` deployment.

Deliberately self-contained: it reads the MCAP with the ``mcap`` library
directly (installed in the dora_runner image) instead of importing
dora_runner internals, so your extension repo does not break when kairos
internals move. The summary shape is the kairos contract shared by every
pipeline: ``{pipeline, version, result, message, metrics, params, checked_at}``.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

PIPELINE_ID = "topic_census"
VERSION = "0.1.0"  # keep in sync with kairos_plugin.yaml


def census(run_dir: Path) -> tuple[dict[str, int], int, int]:
    """Messages per topic from the MCAP summary sections (no decode).

    Sums over EVERY .mcap in the run — split recordings (``--max-bag-size`` /
    ``--max-bag-duration``) produce ``<run>_0.mcap``, ``<run>_1.mcap``, …;
    reading only the first file silently undercounts. Returns
    ``(counts, files_read, files_without_statistics)`` — a crashed recorder
    can leave an unindexed MCAP whose summary section is missing, which is
    NOT the same as "no messages".
    """
    from mcap.reader import make_reader

    mcaps = sorted(run_dir.glob("*.mcap")) or sorted(run_dir.glob("**/*.mcap"))
    if not mcaps:
        raise FileNotFoundError(f"no .mcap under {run_dir}")
    counts: dict[str, int] = {}
    unindexed = 0
    for mcap_path in mcaps:
        with mcap_path.open("rb") as f:
            summary = make_reader(f).get_summary()
            if summary is None or summary.statistics is None:
                unindexed += 1
                continue
            for channel_id, n in summary.statistics.channel_message_counts.items():
                channel = summary.channels[channel_id]
                counts[channel.topic] = counts.get(channel.topic, 0) + n
    return counts, len(mcaps), unindexed


def build_summary(run_dir: Path, params: dict[str, Any]) -> dict[str, Any]:
    counts, files_read, unindexed = census(run_dir)
    min_messages = int(params.get("min_messages") or 1)
    busiest = max(counts.values(), default=0)
    if unindexed:
        # Honest failure: absent statistics = unverifiable, not "empty".
        result = "fail"
        message = f"{unindexed}/{files_read} MCAP files have no statistics section"
    elif not counts:
        result = "fail"
        message = "recording contains no messages"
    else:
        result = "pass" if busiest >= min_messages else "fail"
        message = (
            f"{len(counts)} topics across {files_read} file(s), "
            f"busiest carries {busiest} messages"
        )
    return {
        "pipeline": PIPELINE_ID,
        "version": VERSION,
        "result": result,
        "message": message,
        "metrics": {
            "topic_count": len(counts),
            "busiest_topic_messages": busiest,
            "messages_total": sum(counts.values()),
            "mcap_files": files_read,
            "mcap_files_without_statistics": unindexed,
        },
        "params": {"min_messages": min_messages},
        "checked_at": datetime.now(UTC).isoformat(),
    }


def process(inputs: dict[str, Any], ctx: Any) -> dict[str, Any]:
    """In-process entrypoint: ctx carries run_id/data_dir/params/report_dir."""
    summary = build_summary(ctx.data_dir / "recorded" / ctx.run_id, ctx.params)
    (ctx.report_dir / "summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    return {"summary": summary}


def main() -> None:  # pragma: no cover - requires the dora daemon
    """dora-CLI entrypoint: the same logic, context from KAIROS_* env."""
    import os

    run_id = os.environ["KAIROS_RUN_ID"]
    data_dir = Path(os.environ["KAIROS_DATA_DIR"])
    report_dir = Path(os.environ["KAIROS_REPORT_DIR"])
    params = json.loads(os.environ.get("KAIROS_PARAMS_JSON") or "{}")
    summary = build_summary(data_dir / "recorded" / run_id, params)
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
