# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""rosbag2_recorder: ROS 2 topics -> MCAP canonical recorder.

The service exposes the recorder's internal HTTP API (consumed by
``api_orchestrator``): ``POST /record/prepare|start|stop`` and ``GET
/record/status|metadata``. Recording is performed by spawning ``ros2 bag record
--storage mcap`` (see :mod:`rosbag2_recorder.recorder`).

Each recording is a **capture**: the recorder mints its ``capture_id`` (a UUIDv7,
contract §1) and points rosbag2 at ``<data_dir>/objects/<capture_id>/``, so the
MCAP files and standard ``metadata.yaml`` land there beside the capture's
``object_manifest.json`` (§3) — the audit record that says what was recorded, by
whom, and how it ended. The ``run_id`` the orchestrator allocates survives as the
capture's display name, not as a path.

The recorder is the manifest's sole writer only up to a terminal state with
``digest_state=pending``; the per-file hashes are the orchestrator's to add
afterwards (§3.3), which is why ``GET /record/status`` reports which capture_ids
are still live.
"""
