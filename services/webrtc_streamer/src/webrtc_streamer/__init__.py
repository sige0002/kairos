# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""ROS 2 image-to-browser WebRTC preview service for kairos.

The implemented preview-only path subscribes to images, applies a latest-frame
queue, encodes VP8/H.264, and negotiates per-client peer connections through
WHEP-style signaling. It is independent of the canonical rosbag recording path.
"""
