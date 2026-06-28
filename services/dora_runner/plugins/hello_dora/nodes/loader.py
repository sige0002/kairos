"""mcap_loader node: read a recorded MCAP and emit per-topic message counts.

Dual-mode (see plugin_loader.py):
* ``process(inputs, ctx)`` — pure logic, called by the in-process interpreter.
* ``main()`` — the dora event loop, run by ``dora start`` under the daemon.

Counts come from the MCAP summary statistics, so this is decode-free (no rclpy).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from dora_runner.mcap_utils import find_mcap, validate_run_id
from mcap.reader import make_reader


def load_topic_counts(run_id: str, data_dir: Path) -> dict[str, Any]:
    """Enumerate topics with their message counts and the run's time span."""
    validate_run_id(run_id)
    mcap_path = find_mcap(data_dir / "recorded" / run_id)
    with mcap_path.open("rb") as fh:
        summary = make_reader(fh).get_summary()

    topics: list[dict[str, Any]] = []
    start_ns: int | None = None
    end_ns: int | None = None
    if summary is not None:
        stats = summary.statistics
        counts = dict(stats.channel_message_counts) if stats is not None else {}
        if stats is not None:
            start_ns = stats.message_start_time
            end_ns = stats.message_end_time
        for channel_id, channel in summary.channels.items():
            schema = summary.schemas.get(channel.schema_id)
            topics.append(
                {
                    "name": channel.topic,
                    "type": schema.name if schema is not None else "",
                    "count": int(counts.get(channel_id, 0)),
                }
            )
    topics.sort(key=lambda topic: topic["name"])
    return {
        "run_id": run_id,
        "mcap_path": str(mcap_path),
        "topics": topics,
        "start_time_ns": start_ns,
        "end_time_ns": end_ns,
    }


def process(inputs: dict[str, Any], ctx: Any) -> dict[str, Any]:
    return {"loaded": load_topic_counts(ctx.run_id, ctx.data_dir)}


def main() -> None:  # pragma: no cover - requires the dora daemon
    import pyarrow as pa
    from dora import Node

    node = Node()
    run_id = os.environ["KAIROS_RUN_ID"]
    data_dir = Path(os.environ["KAIROS_DATA_DIR"])
    for event in node:
        # A finite batch: the first timer tick loads the run and emits once.
        if event["type"] == "INPUT":
            loaded = load_topic_counts(run_id, data_dir)
            node.send_output(
                "loaded", pa.array([json.dumps(loaded)]), event["metadata"]
            )
            return


if __name__ == "__main__":  # pragma: no cover
    main()
