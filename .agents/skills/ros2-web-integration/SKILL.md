---
name: ros2-web-integration
description: Implement or debug ROS 2 browser APIs, telemetry, commands, and video transport while preserving executor and public-service boundaries.
---

# ROS 2 web integration

Identify the owners of ROS subscriptions, commands, browser APIs, signaling,
and media in the affected flow. Preserve kairos's orchestrator control/status
hub, direct `/webrtc` signaling path, and existing FastAPI/rclpy/aiortc services.
Kairos's trusted-LAN/no-auth assumption is deliberate; security redesign is a
separate requirement. Do not silently add authentication or present it as
internet-safe.

## Read by boundary

| Work | Reference |
|---|---|
| Bridge choice, executor separation, service/action/parameter calls | [bridge-patterns.md](references/bridge-patterns.md) |
| MJPEG, binary previews, aiortc, ICE/STUN/TURN, cleanup | [streaming-webrtc.md](references/streaming-webrtc.md) |
| Authentication, Origin, TLS, proxies, rate/resource limits | [security-operations.md](references/security-operations.md) |
| Teleoperation, watchdogs, command states, acknowledgments | [command-protocols.md](references/command-protocols.md) |

## Preserve runtime and command contracts

Keep the ROS executor separate from the web event loop. Avoid spin or synchronous
ROS calls inside async handlers; transfer callback results thread-safely and
coordinate executor/task/node shutdown.

`rclpy.task.Future.result()` does not wait and accepts no timeout. For service
calls, use the callback-to-asyncio bridge in `bridge-patterns.md`, apply a timeout,
and remove pending requests when it expires. Verify the selected rclpy version
before relying on direct await behavior.

Bound per-client work, queues, and rates. Prefer latest samples for live state,
binary frames for images, and explicit cleanup for disconnected media peers.
HTTP signaling and ICE/SRTP media are separate paths.

For commands with physical effects, validate units, frames, ranges, age, and
state. A delivery acknowledgment is not completed execution. Define deduplication,
cancellation, and dead-man/safe-stop behavior so disconnect or stale input cannot
leave motion active. Where authentication is in scope, authorize commands rather
than treating a connected socket as blanket permission; keep credentials out of
URLs/logs and validate browser Origins independently of CORS.

Verify the paths affected by the change: transformations without ROS, timeout/
shutdown with controlled clients, and browser/ROS transport where needed.
Include slow consumers, disconnect/reconnect, and command recovery when relevant.
Security or latency testing should support the actual deployment requirement,
not become an automatic full hardening project.
