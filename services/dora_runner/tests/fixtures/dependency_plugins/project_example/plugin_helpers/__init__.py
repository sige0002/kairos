# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
import humanize


def summary():
    return {
        "pipeline": "project_example",
        "result": "pass",
        "message": humanize.intcomma(12345),
        "metrics": {
            "dependency_version": humanize.__version__,
            "packaged_helper": True,
        },
    }
