"""summarize node: turn loaded topic counts into the kairos summary contract.

The summary shape mirrors the other dora_runner pipelines:
``{pipeline, version, result, metrics, params, checked_at}``.
"""

from __future__ import annotations

import json
import os
from typing import Any

from kairos_common import utc_now_iso8601

PIPELINE_ID = "hello_dora"
VERSION = "0.1.0"  # keep in sync with kairos_plugin.yaml


def summarize(loaded: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    topics = loaded.get("topics", [])
    message_count = sum(int(topic.get("count", 0)) for topic in topics)

    start = loaded.get("start_time_ns")
    end = loaded.get("end_time_ns")
    duration_s = (
        round((end - start) / 1e9, 3)
        if isinstance(start, int) and isinstance(end, int) and end >= start
        else None
    )

    min_messages = int(params.get("min_messages", 1) or 0)
    result = "pass" if message_count >= min_messages else "fail"

    return {
        "pipeline": PIPELINE_ID,
        "version": VERSION,
        "result": result,
        "metrics": {
            "message_count": message_count,
            "topic_count": len(topics),
            "duration_s": duration_s,
            "topics": topics,
        },
        "params": {"min_messages": min_messages},
        "checked_at": utc_now_iso8601(),
    }


def process(inputs: dict[str, Any], ctx: Any) -> dict[str, Any]:
    return {"summary": summarize(inputs["loaded"], ctx.params)}


def main() -> None:  # pragma: no cover - requires the dora daemon
    import pyarrow as pa
    from dora import Node

    node = Node()
    params = json.loads(os.environ.get("KAIROS_PARAMS_JSON", "{}"))
    for event in node:
        if event["type"] == "INPUT" and event["id"] == "loaded":
            loaded = json.loads(event["value"][0].as_py())
            summary = summarize(loaded, params)
            node.send_output(
                "summary", pa.array([json.dumps(summary)]), event["metadata"]
            )
            return


if __name__ == "__main__":  # pragma: no cover
    main()
