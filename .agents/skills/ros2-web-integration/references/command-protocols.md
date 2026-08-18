# Robot command and telemetry protocols

## Contents

- Define message envelopes
- Model command lifecycle
- Make retries safe
- Implement teleoperation watchdogs
- Broadcast status with bounded work
- Test failure and recovery

## Define message envelopes

Version the protocol and use correlation IDs:

```json
{
  "v": 1,
  "type": "command",
  "id": "01J...",
  "action": "navigate_to",
  "sent_at": "2026-08-18T10:30:00Z",
  "params": {"frame": "map", "x": 1.0, "y": 2.0, "yaw": 0.0}
}
```

Return structured events:

```json
{"v":1,"type":"command_status","id":"01J...","state":"accepted"}
{"v":1,"type":"command_status","id":"01J...","state":"in_progress","progress":0.45}
{"v":1,"type":"command_status","id":"01J...","state":"completed","result":{}}
```

Validate:

- protocol version and message type;
- ID format and uniqueness scope;
- action allowlist;
- timestamp/maximum age;
- numeric bounds, units, and coordinate frame;
- authorization for the robot/action;
- message and nested collection sizes.

## Model command lifecycle

Use explicit states:

```text
received -> accepted -> in_progress -> completed
    |          |             |
 rejected   cancelled      failed
```

Define which component owns each transition. Persist state when clients must reconnect and resume observation.

Distinguish:

- received: transport delivered the request;
- accepted: validation and dispatch succeeded;
- in progress: robot execution started or feedback arrived;
- completed: terminal success from the underlying action/system;
- failed: terminal error with a stable error code;
- cancelled: cancellation was confirmed, not merely requested.

Do not send `completed` before physical execution finishes.

## Make retries safe

Use an idempotency/correlation key for commands that clients may retry. Store lifecycle state, not only a set of seen IDs:

```python
class CommandStore:
    def begin(self, command_id, payload_hash):
        """Atomically create RECEIVED or return the existing matching record."""

    def transition(self, command_id, expected, target, details=None):
        """Compare-and-set a valid lifecycle transition."""
```

If the same ID arrives with a different payload, reject it as a conflict. If it matches, return current state without dispatching the physical effect again.

Do not mark an ID complete before dispatch. If dispatch fails, preserve a retryable/failed state according to the action's semantics.

## Teleoperation watchdog

Treat browser velocity commands as a lease, not persistent setpoints:

- require a session/lease ID;
- include sequence and monotonic client timestamp where useful;
- clamp velocity/acceleration to server-side limits;
- publish at a controlled server rate;
- expire after a short silence;
- publish zero on disconnect, expiry, authorization loss, shutdown, or takeover;
- prevent two operators from commanding simultaneously unless arbitration is designed.

Example core:

```python
class TeleopLease:
    def __init__(self, publish, timeout_s=0.5):
        self._publish = publish
        self._timeout_s = timeout_s
        self._last_command = 0.0
        self._active = False

    def command(self, linear_x, angular_z, now):
        linear_x = max(-1.0, min(1.0, float(linear_x)))
        angular_z = max(-2.0, min(2.0, float(angular_z)))
        self._publish(linear_x, angular_z)
        self._last_command = now
        self._active = True

    def tick(self, now):
        if self._active and now - self._last_command > self._timeout_s:
            self._publish(0.0, 0.0)
            self._active = False

    def close(self):
        self._publish(0.0, 0.0)
        self._active = False
```

Run the watchdog independently of incoming receive calls so silence can trigger it. Make zero publication idempotent.

## Status broadcasting

Keep a bounded latest snapshot for replaceable state and an explicit event channel for lifecycle events. Do not make every WebSocket client own a ROS subscription unless isolation requirements justify it.

```python
async def broadcast_snapshot(clients, snapshot):
    dead = []
    for client in tuple(clients):
        try:
            await asyncio.wait_for(client.send_json(snapshot), timeout=0.25)
        except Exception:
            dead.append(client)
    for client in dead:
        clients.discard(client)
```

For many clients, do not await slow sends serially. Use per-client bounded queues/tasks or bounded concurrency, and cap total memory.

Include freshness metadata:

```json
{
  "v": 1,
  "type": "robot_status",
  "source_time": "2026-08-18T10:30:00.120Z",
  "server_time": "2026-08-18T10:30:00.145Z",
  "stale": false,
  "data": {}
}
```

Do not report `active` when required source data has never arrived or has exceeded its freshness threshold.

## Errors and recovery

Use stable machine-readable codes plus human-readable messages:

```json
{
  "v": 1,
  "type": "error",
  "request_id": "01J...",
  "code": "dependency_unavailable",
  "message": "Navigation action server is unavailable",
  "retryable": true
}
```

Define recovery for:

- ROS dependency not discovered;
- QoS mismatch or stale telemetry;
- command rejection;
- action abort/cancel;
- bridge restart;
- browser reconnect;
- duplicate/replayed command;
- operator takeover;
- malformed/unsupported protocol version.

## Testing

- Drop the WebSocket during nonzero teleoperation and assert zero is published within the deadline.
- Pause client commands without closing and assert the same watchdog behavior.
- Retry the same ID before, during, and after execution.
- Replay an ID with a different payload and assert conflict.
- Reconnect and retrieve durable command state where promised.
- Inject out-of-order action feedback and terminal results.
- Verify a slow telemetry client cannot delay command handling or other clients.
- Test stale status thresholds and explicit unknown/unavailable states.
- Verify server shutdown stops motion and closes active commands consistently.
