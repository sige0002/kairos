"""greet node: turn the input params into a kairos greeting summary.

Template plugin (see docs/specs/ja/dora_plugins.md). Dual-mode, like every
kairos node:

* ``process(inputs, ctx)`` — pure logic, called by the in-process interpreter
  (and by unit tests) on a CPU-only host with no dora binary.
* ``main()`` — the dora event loop, run by ``dora start`` under the daemon.

It ignores the recording entirely and just echoes the ``subject`` param into a
greeting. That keeps this the smallest possible "input -> summary.json" example.
The summary shape is the kairos contract shared by every pipeline:
``{pipeline, version, result, message, metrics, params, checked_at}``.
"""

from __future__ import annotations

import json
import os
from typing import Any

from kairos_common import utc_now_iso8601

PIPELINE_ID = "hello_kairos"
VERSION = "0.1.0"  # keep in sync with kairos_plugin.yaml


def build_summary(params: dict[str, Any]) -> dict[str, Any]:
    """Build the greeting summary from the job params (no MCAP needed)."""
    subject = str(params.get("subject") or "kairos").strip() or "kairos"
    message = f"hello {subject}!"
    if params.get("shout"):
        message = message.upper()
    return {
        "pipeline": PIPELINE_ID,
        "version": VERSION,
        "result": "pass",
        "message": message,
        "metrics": {"subject": subject, "characters": len(message)},
        "params": {"subject": subject, "shout": bool(params.get("shout"))},
        "checked_at": utc_now_iso8601(),
    }


def process(inputs: dict[str, Any], ctx: Any) -> dict[str, Any]:
    return {"summary": build_summary(ctx.params)}


def main() -> None:  # pragma: no cover - requires the dora daemon
    import pyarrow as pa
    from dora import Node

    node = Node()
    params = json.loads(os.environ.get("KAIROS_PARAMS_JSON", "{}"))
    for event in node:
        # A finite batch: the first timer tick builds the greeting and emits once.
        if event["type"] == "INPUT":
            summary = build_summary(params)
            node.send_output(
                "summary", pa.array([json.dumps(summary)]), event["metadata"]
            )
            return


if __name__ == "__main__":  # pragma: no cover
    main()
