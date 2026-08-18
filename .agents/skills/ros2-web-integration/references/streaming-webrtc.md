# Sensor streaming and WebRTC

## Contents

- Choose a transport
- Maintain a bounded latest-frame path
- Stream MJPEG or binary WebSocket frames
- Build ROS 2 WebRTC with aiortc
- Configure ICE and clean up peers
- Measure quality

## Choose a transport

| Transport | Use when | Avoid when |
|---|---|---|
| SSE | low-rate server-to-browser events | binary/high-rate data or bidirectional commands |
| JSON WebSocket | compact telemetry and event streams | raw images, point clouds, large binary samples |
| Binary WebSocket | compressed frames or bounded binary samples | adaptive media/NAT traversal is required |
| MJPEG | simplest camera preview in an `<img>` | bandwidth efficiency, audio, or low latency is critical |
| WebRTC | low-latency media, congestion control, browser media APIs, ICE | operational simplicity matters more than latency |

Do not send raw `sensor_msgs/Image` as base64 JSON. Base64 adds about one third to binary size before JSON overhead.

## Maintain a bounded latest-frame path

For previews, store one latest frame per source. Overwrite stale data instead of queueing latency:

```python
import threading


class LatestFrame:
    def __init__(self):
        self._lock = threading.Lock()
        self._sequence = 0
        self._frame = None

    def put(self, frame):
        with self._lock:
            self._sequence += 1
            self._frame = frame

    def get(self):
        with self._lock:
            return self._sequence, self._frame
```

Record capture time, receive time, encode time, and send time where latency diagnosis matters. Do not report network latency from frame-rate deltas alone.

Use sensor-data QoS only when compatible with the publisher and loss semantics. Discover publisher QoS before hardcoding reliability.

## MJPEG

Use a bounded-rate generator and handle disconnect cleanup:

```python
def mjpeg_chunks(frames, max_fps=10):
    interval = 1.0 / max_fps
    last_sequence = -1
    while True:
        sequence, jpeg = frames.get()
        if jpeg is None or sequence == last_sequence:
            time.sleep(min(interval, 0.02))
            continue
        last_sequence = sequence
        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n"
            b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n"
            + jpeg + b"\r\n"
        )
```

Disable proxy buffering for the MJPEG route. Enforce client count, resolution, FPS, and idle limits.

## Binary WebSocket frames

Send already-compressed bytes:

```python
@app.websocket("/ws/camera")
async def camera(websocket: WebSocket):
    await authenticate_websocket(websocket)
    await websocket.accept()
    last_sequence = -1
    try:
        while True:
            sequence, jpeg = app.state.frames.get()
            if jpeg is not None and sequence != last_sequence:
                last_sequence = sequence
                await websocket.send_bytes(jpeg)
            await asyncio.sleep(1 / 15)
    except WebSocketDisconnect:
        pass
```

Use object URLs carefully in the browser and revoke the previous URL after the image has switched. Track send duration and disconnect clients that cannot keep up.

## ROS 2 WebRTC with aiortc

Do not use RobotWebTools `webrtc_ros` as a ROS 2 example; ROS index lists it as an Indigo/CATKIN package using ROS 1 dependencies.

Use this architecture:

```text
ROS 2 Image/CompressedImage subscriber
  -> conversion/downscale
  -> latest-frame buffer per stream
  -> aiortc VideoStreamTrack
  -> RTCPeerConnection per browser
  -> ICE/DTLS/SRTP media path
```

Create a peer from the browser offer:

```python
from aiortc import RTCConfiguration, RTCIceServer
from aiortc import RTCPeerConnection, RTCSessionDescription


async def answer_offer(offer_sdp, offer_type, track, ice_config):
    servers = [RTCIceServer(**item) for item in ice_config]
    pc = RTCPeerConnection(RTCConfiguration(iceServers=servers))
    peer_registry.add(pc)

    @pc.on("connectionstatechange")
    async def on_state_change():
        if pc.connectionState in {"failed", "closed"}:
            await close_peer(pc)

    pc.addTrack(track)
    await pc.setRemoteDescription(
        RTCSessionDescription(sdp=offer_sdp, type=offer_type)
    )
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    return pc.localDescription
```

Implement `VideoStreamTrack.recv()` with timestamp pacing and an `av.VideoFrame`. Avoid blocking the event loop while waiting for ROS frames; use a thread-safe buffer/event bridge.

The browser side should create a receive-only transceiver, set its local offer, exchange signaling, and apply the answer:

```javascript
const pc = new RTCPeerConnection({ iceServers });
pc.addTransceiver('video', { direction: 'recvonly' });
pc.addEventListener('track', ({ streams }) => {
  video.srcObject = streams[0];
});
await pc.setLocalDescription(await pc.createOffer());
const answer = await postOffer(pc.localDescription);
await pc.setRemoteDescription(answer);
```

Use HTTP offer/answer for simple non-trickle signaling or a WebSocket signaling channel for trickle ICE/renegotiation. State which model the API implements.

## ICE, STUN, and TURN

- Use host candidates when both peers have direct reachable addresses on a trusted LAN/VPN.
- Use STUN to discover server-reflexive candidates where NAT permits direct connectivity.
- Use TURN when direct UDP/TCP connectivity cannot be relied on.
- Supply matching ICE server configuration to both browser and server peer where required.
- Protect TURN credentials; prefer time-limited credentials.
- Test Wi-Fi client isolation, VPN MTU, UDP blocking, IPv4/IPv6, and NAT behavior from the actual browser network.

An HTTP reverse proxy handles signaling only. Media follows the nominated ICE candidate pair and may bypass the HTTP proxy entirely.

## Peer and stream cleanup

- Keep one peer connection per browser session.
- Remove failed/closed peers from registries.
- Treat `disconnected` as potentially transient; apply a bounded recovery policy rather than always destroying immediately.
- Close peers on application shutdown.
- Stop ROS subscriptions/encoders when no peers reference a stream after an idle timeout.
- Limit peers per stream and total encoding load.
- Share a source frame buffer; decide explicitly whether encoders are shared or per-peer.

## Measure quality

Collect:

- source FPS and frame age;
- conversion/encode time;
- frames sent/dropped;
- selected ICE candidate type/path;
- bytes sent, packets lost, jitter, and round-trip time from WebRTC stats;
- connection and ICE state transitions;
- server CPU/GPU and memory per client.

Test multiple simultaneous clients and slow/disappearing clients. A connected state without increasing inbound video bytes is not a healthy preview.

## Primary sources

- https://github.com/aiortc/aiortc/blob/main/examples/server/server.py
- https://aiortc.readthedocs.io/en/latest/api.html
- https://www.w3.org/TR/webrtc/
- https://index.ros.org/p/webrtc_ros/
