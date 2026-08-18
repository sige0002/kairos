---
name: ros2-web-integration
description: >-
  Design, implement, review, and debug ROS 2 web integrations: constrained REST APIs,
  WebSocket telemetry and commands, rosbridge/roslibjs, FastAPI or Flask bridges,
  browser robot dashboards, CORS and authentication, rate limiting, MJPEG or binary
  image streams, WebRTC with aiortc, and safe coexistence with rclpy executors. Use
  for browser-to-ROS 2 communication, ROS service/action wrappers, video preview,
  teleoperation, and production hardening. Inspect the repository's existing API
  boundary, security model, QoS, and streaming implementation before choosing a pattern.
---

# ROS 2 web integration

## Start from the existing boundary

1. Read repository instructions, API specifications, service code, frontend clients, and deployment topology.
2. Identify which process owns ROS subscriptions, commands, authentication, signaling, and browser-facing ports.
3. Preserve an established API hub or reverse-proxy boundary. Do not expose internal ROS services directly because it is convenient.
4. Separate read-only telemetry from state-changing commands and assign explicit authorization, timeout, and recovery behavior to each.
5. Keep high-bandwidth media off JSON paths unless the project explicitly accepts the cost.

For kairos specifically:

- Preserve the orchestrator as the public control/status API hub.
- Preserve the direct `/webrtc` signaling path and the existing `webrtc_streamer` service for camera media.
- Use the implemented FastAPI + rclpy + aiortc pattern; do not introduce ROS 1 `webrtc_ros` examples.
- Keep the documented trusted-LAN/no-auth assumption distinct from generic internet-facing guidance. Do not silently add authentication or claim the current deployment is internet-safe.

## Route to the needed reference

Read only the references relevant to the request:

- Read [bridge-patterns.md](references/bridge-patterns.md) for rosbridge versus custom bridges, rclpy executor separation, service/action calls, parameter APIs, and correct asyncio bridging.
- Read [streaming-webrtc.md](references/streaming-webrtc.md) for MJPEG, compressed binary WebSockets, ROS 2-compatible aiortc WebRTC, ICE/STUN/TURN, frame queues, and connection cleanup.
- Read [security-operations.md](references/security-operations.md) for TLS, reverse proxies, WebSocket authentication, Origin validation, CORS, rate limiting, backpressure, lifecycle management, and production checks.
- Read [command-protocols.md](references/command-protocols.md) for teleoperation watchdogs, acknowledgments, correlation IDs, status broadcasting, and message validation.

## Choose the bridge deliberately

Use rosbridge when the client already speaks its protocol, the deployment is constrained to a trusted environment, and broad graph exposure is acceptable or tightly filtered.

Use a custom bridge when any of these apply:

- expose only an allowlisted subset of topics, services, actions, or parameters;
- authenticate or authorize users and commands;
- aggregate, transform, or rate-limit data;
- present a stable domain API instead of ROS graph details;
- stream media with an explicit encoding and latency budget;
- maintain command state, idempotency, or audit events.

Do not label a framework production-ready by itself. Production readiness depends on boundary design, deployment, authentication, authorization, resource limits, observability, and recovery.

## Keep rclpy and the web runtime independent

- Run the ROS executor in a dedicated thread or process.
- Keep the web event loop free of `rclpy.spin*()` and synchronous ROS calls.
- Protect shared state written by ROS callbacks and read by web handlers.
- Prefer immutable snapshots or latest-value buffers over sharing mutable ROS messages.
- Coordinate shutdown: stop accepting work, stop background tasks, shut down the executor, destroy nodes, call `rclpy.shutdown()`, and join threads.
- Use a separate process when CPU-heavy serialization, encoding, or callback load causes GIL contention.

## Bridge ROS futures correctly

`rclpy.task.Future.result()` has no timeout parameter and does not block until completion. Do not pass a timeout to it or wrap it in `run_in_executor()` as a waiting strategy.

Bridge completion into an `asyncio.Future` with `add_done_callback()` and `loop.call_soon_threadsafe()`, then apply `asyncio.wait_for()`. On timeout, remove the pending client request and return an explicit HTTP timeout response. Use the complete helper in [bridge-patterns.md](references/bridge-patterns.md).

Do not assume direct `await client.call_async(...)` is portable across supported rclpy versions; verify the target distribution before relying on it.

## Design telemetry for bounded work

- Store the latest sample when clients need current state, not an unbounded history.
- Apply a per-client maximum rate and bounded queue.
- Drop stale sensor or video frames instead of increasing control latency.
- Use binary WebSocket frames for compressed images and other binary payloads.
- Keep JSON for compact state, events, commands, and metadata.
- Detect slow clients and reduce rate/quality or disconnect them.
- Never serialize arbitrary ROS graph objects requested by a client without an allowlist and size limits.

## Design commands as safety-critical APIs

- Authenticate and authorize each state-changing action where authentication is in scope.
- Validate schema, ranges, units, coordinate frames, and command age.
- Assign correlation IDs and explicit `accepted`, `in_progress`, `completed`, `failed`, and `cancelled` states when commands outlive one request.
- Use idempotency keys or deduplication where retries can repeat physical effects.
- Add a dead-man timeout to velocity and teleoperation commands.
- Send a safe stop on disconnect, timeout, page lifecycle loss, or server shutdown.
- Do not equate WebSocket delivery acknowledgment with robot execution.

## Choose video transport from the task

- Use MJPEG for the simplest `<img>` integration when bandwidth and latency are acceptable.
- Use binary WebSocket JPEG frames for controlled-rate previews without WebRTC complexity.
- Use WebRTC for low-latency adaptive media, NAT traversal, and browser media pipelines.
- For ROS 2 Python systems, use a ROS image subscriber feeding a latest-frame queue and an aiortc `VideoStreamTrack`; create one `RTCPeerConnection` per browser and clean it up on failure/close.
- Configure ICE servers only from deployment needs. Host candidates may suffice on a reachable LAN; use STUN/TURN where direct connectivity cannot be relied on.
- Treat signaling transport and media transport separately. Proxying HTTP signaling does not proxy ICE/SRTP media.

## Authenticate WebSockets without leaking credentials

- Use WSS outside loopback development.
- Understand that browser `new WebSocket(url, protocols)` cannot set an arbitrary `Authorization` header, although non-browser clients and the protocol are not universally subject to that limitation.
- Prefer a secure, HttpOnly, SameSite session cookie for same-origin applications, combined with a strict handshake `Origin` allowlist.
- If cookie auth is unsuitable, send a short-lived token as the first WebSocket message and enforce a short authentication deadline.
- If authentication must happen before upgrade, use a short-lived, single-use ticket and redact query strings from logs. Do not place long-lived bearer tokens in WebSocket URLs.
- Revalidate long-lived sessions and close sockets on logout or expiry.
- Authorize every command message; connection authentication is not blanket permission.
- Do not rely on CORS middleware to prevent Cross-Site WebSocket Hijacking. Validate `Origin` separately.

## Verify behavior end to end

1. Unit-test pure transformations, validation, rate limiting, and command state transitions without ROS.
2. Test executor startup/shutdown and service timeout paths with fakes or a controlled ROS graph.
3. Test browser reconnect, duplicate connections, slow consumers, tab close, and network loss.
4. Verify QoS compatibility and discovery with representative publishers.
5. Measure end-to-end latency, frame age, drop rate, bandwidth, and server CPU under multiple clients.
6. Verify unauthorized origins, expired sessions, malformed messages, oversized payloads, and rate-limit behavior when security is enabled.
7. Verify reverse-proxy WebSocket upgrade, idle timeout, TLS, and logging redaction.
8. Test motion-command dead-man behavior independently of the happy path.

## Reject common failure patterns

- Do not spin an already-managed node from an HTTP handler.
- Do not call synchronous ROS services inside `async def` handlers.
- Do not use `rclpy.Future.result(timeout=...)`.
- Do not expose all topics or allow arbitrary publish targets by default.
- Do not forward raw camera frames as base64 JSON.
- Do not authenticate WebSockets with long-lived query tokens.
- Do not accept cookie-authenticated WebSockets without an Origin allowlist.
- Do not use ROS 1 `webrtc_ros` launch examples as ROS 2 guidance.
- Do not keep dead peer connections or client objects in registries.
- Do not let a disconnected teleoperation client leave a nonzero velocity active.

## Primary sources

- rclpy task implementation: https://github.com/ros2/rclpy/blob/jazzy/rclpy/rclpy/task.py
- rclpy client implementation: https://github.com/ros2/rclpy/blob/jazzy/rclpy/rclpy/client.py
- Browser WebSocket constructor: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket
- OWASP WebSocket security: https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html
- aiortc server example: https://github.com/aiortc/aiortc/blob/main/examples/server/server.py
- aiortc API: https://aiortc.readthedocs.io/en/latest/api.html
- ROS index for ROS 1 `webrtc_ros`: https://index.ros.org/p/webrtc_ros/
