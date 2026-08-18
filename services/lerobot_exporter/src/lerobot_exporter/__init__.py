# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""lerobot_exporter: dataset -> LeRobot v3 conversion service for kairos.

The service is resident (a member of the compose stack, idle at rest) and runs
the bundled ``rosbag2lerobot`` converter as a subprocess for the duration of an
export. See ``docs/specs/ja/capture_store.md`` §6.2 for the store-side contract.
"""
