# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""topic_monitor: ROS 2 lightweight live monitoring (Stage 0 skeleton).

Stage 0 provides only a runnable FastAPI shell (/healthz, /readyz, stub root).
The monitoring logic (allowlist subscribe, window stats, Hz/Late/Gap/Loss/
bandwidth, SSE /metrics/stream, discovery /topics) lands in Stage 2.
"""
