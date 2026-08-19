# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""ROS 2 lightweight live monitoring for the kairos operator console.

The implemented service auto-matches subscription QoS, gathers windowed
Hz/late/gap/loss/bandwidth metrics without decoding payloads, streams snapshots
over SSE, and exposes topic discovery and subscriber diagnostics.
"""
