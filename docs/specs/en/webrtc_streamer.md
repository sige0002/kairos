<!-- AUTO-GENERATED from docs/specs/ja/webrtc_streamer.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# webrtc_streamer Specification

> Status: design finalized (v1). Based on `fig_const/webstremer.png`, with unstated items finalized as the recommended design. Japanese is the source of truth (it governs). The English version `docs/specs/en/webrtc_streamer.md` is an auto-generated mirror (do not edit it directly). **No authentication required.**

A **preview-only** container that delivers ROS 2 image topics to the browser with low latency. **Not the canonical recording** (recording is handled by `rosbag2_recorder`). Independent of the recording path.

## Role

- Subscribes to image topics and live-streams them to the browser over WebRTC (multiple cameras = multiple streams).

## Input

- ROS 2 image topic (`sensor_msgs/Image` / `sensor_msgs/CompressedImage`)
- camera_info (optional)

## Components

- **ROS2 Subscriber** — subscribes to image topics.
- **Frame Queue** — **latest-frame priority** (older frames are dropped = frame drop assumed).
- **Encoder** — VP8 (default) / H.264 (optional, environment-dependent. Capability is exposed via `/stream/status`).
- **WebRTC Session / Signaling** — SDP / ICE.
- **Stream Status** — streaming state, number of connections.

## Libraries

- **aiortc** (WebRTC peer / offer-answer) + **aiohttp** (signaling HTTP) + **opencv-python-headless** (frame conversion) recommended.

## API

- `POST /stream/start` — `{ topic, encoding?: "vp8"|"h264", max_fps?, max_width?, max_height?, bitrate_kbps? }` → `{ stream_id }` (`bitrate_kbps` is accepted but currently not applied — a reserved field)
- `POST /stream/stop` — `{ stream_id }`
- `GET /stream/status` — `{ capabilities: { h264: bool }, streams: [ { stream_id, topic, state, clients, fps } ] }`
- `POST /stream/offer` — `{ stream_id, sdp: { type: "offer", sdp } }` → `{ type: "answer", sdp }` (WHEP-style HTTP offer/answer. `stream_id` required. v1 exchanges a complete non-trickle SDP with candidates included. If trickle is needed, add WS.)
- `GET /healthz` / `GET /readyz`

## Configuration / Behavior

- ICE: the LAN default is `ice_servers = []` (reachable within the same LAN). Only when traversal beyond the LAN is required is STUN/TURN distributed via `/api/v1/config`.
- CORS: with the default (`WEBRTC_PUBLIC_URL=/webrtc`) the request is same-origin through the frontend's nginx, so CORS is not needed. Only in the legacy mode — an absolute URL where the browser offers directly — apply `CORS_ORIGINS` ([config](config.md)) to the streamer.
- `stream_id` is generated deterministically from the topic, and a duplicate start for the same topic returns the existing stream.
- Unreferenced streams are stopped automatically after `idle_timeout_s` (default `60`). Cleanup happens on client disconnect.
- By default the frontend signals through the same-origin path `/webrtc` (the frontend's nginx reverse-proxies it to the streamer), without going through the orchestrator. Setting `WEBRTC_PUBLIC_URL` to an absolute URL switches to the legacy mode of connecting to the streamer directly. Note that even when signaling is same-origin, the WebRTC media (ICE/SRTP) still flows over UDP directly between the browser and the streamer host, so it assumes the same LAN or host reachability (an SSH-tunnel-only setup where UDP cannot pass needs a separate TURN server).
- Multiple clients: each stream shares a single video source (the latest frame), and a **PeerConnection is created per client**. The corresponding PC is destroyed on client disconnect.

## Design Points

- Low-latency first, preview-only. Low quality is acceptable.
- Not the canonical recording (the canonical recording is `rosbag2_recorder`).
