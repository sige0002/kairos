# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
import ctypes
import json
import os
from pathlib import Path

import humanize


def write_report(report_dir):
    ctypes.CDLL("libmagic.so.1")
    (Path(report_dir) / "summary.json").write_text(
        json.dumps(
            {
                "pipeline": "requirements_example",
                "result": "pass",
                "message": humanize.intcomma(12345),
                "metrics": {
                    "dependency_version": humanize.__version__,
                    "system_library": True,
                },
            }
        )
    )


def process(inputs, ctx):
    write_report(ctx.report_dir)
    return {}


def main():
    from dora import Node

    for event in Node():
        if event["type"] == "INPUT":
            write_report(os.environ["KAIROS_REPORT_DIR"])
            return


if __name__ == "__main__":
    main()
