# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
import json

from plugin_helpers import summary


def run(capture_id, data_dir, params, report_dir):
    (report_dir / "summary.json").write_text(json.dumps(summary()))
