# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""topic_probe — generic numeric-field live plotter (OL-3.3).

A SEPARATE ROS 2 service (isolated from topic_monitor / rosbag2_recorder) that
subscribes to ONE selected topic at a time on its own connection, DECODES it,
introspects its numeric/array fields, and streams throttled samples to the UI.

Decoding lives here on purpose: keeping it out of the non-intrusive monitor and
the recorder means a probe crash can never affect recording or monitoring.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.1.0"
