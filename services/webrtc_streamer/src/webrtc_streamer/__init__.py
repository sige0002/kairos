"""webrtc_streamer: ROS 2 image -> browser WebRTC preview (Stage 0 skeleton).

Stage 0 provides only a runnable FastAPI shell (/healthz, /readyz, stub root).
The streaming logic (image subscribe, frame queue, VP8/H.264 encode, WHEP-style
/stream/offer signaling) lands in Stage 2. This is a preview-only path,
independent of the canonical recording path (rosbag2_recorder).
"""
