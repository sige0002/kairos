# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Execute a fallback graph or callable inside the plugin's prebuilt Python env."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from dora_runner.plugin_loader import (
    NodeContext,
    _load_attr,
    _load_manifest,
    run_dataflow_in_process,
)


def main() -> None:
    plugin_dir = Path(sys.argv[1])
    values = json.loads(sys.argv[2])
    values["data_dir"] = Path(values["data_dir"])
    values["report_dir"] = Path(values["report_dir"])
    ctx = NodeContext(**values)
    manifest = _load_manifest(plugin_dir / "kairos_plugin.yaml")
    if manifest.entrypoint.get("dataflow"):
        run_dataflow_in_process(
            plugin_dir / manifest.entrypoint["dataflow"], plugin_dir, ctx
        )
    else:
        fn = _load_attr(plugin_dir, manifest.entrypoint["callable"], manifest.id)
        fn(ctx.capture_id, ctx.data_dir, ctx.params, ctx.report_dir)


if __name__ == "__main__":
    main()
