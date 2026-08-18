# ROS 2 web bridge patterns

## Contents

- Select rosbridge or a custom bridge
- Run rclpy beside a web server
- Bridge rclpy futures into asyncio
- Wrap services, actions, and parameters
- Test and shut down

## Select rosbridge or a custom bridge

Use rosbridge for compatible tooling and constrained trusted deployments. Before exposing it, verify its current launch arguments and filtering support for the installed ROS distribution; do not copy historical parameter names blindly.

Use a custom domain bridge when the API must hide ROS graph details, enforce an allowlist, aggregate state, authenticate commands, or control resource use.

| Concern | rosbridge | Custom bridge |
|---|---|---|
| Initial integration | low effort | application code required |
| ROS graph abstraction | exposes ROS-oriented protocol | define stable domain resources |
| Filtering | deployment/version dependent | explicit allowlist in code/config |
| Auth/authorization | add proxy/plugin controls | integrate with application security |
| Binary/media path | avoid for high-rate media unless proven | design separate binary/WebRTC path |

Do not publish motion commands through an unrestricted generic topic endpoint.

## Run rclpy beside a web server

Use a dedicated ROS executor thread for modest I/O-bound bridges:

```python
import threading

import rclpy
from rclpy.executors import MultiThreadedExecutor


def start_ros(node):
    executor = MultiThreadedExecutor(num_threads=2)
    executor.add_node(node)
    thread = threading.Thread(target=executor.spin, daemon=True)
    thread.start()
    return executor, thread
```

Keep ROS callbacks short. Store snapshots under a lock:

```python
class LatestState:
    def __init__(self):
        self._lock = threading.Lock()
        self._value = None

    def set(self, value):
        with self._lock:
            self._value = value

    def get(self):
        with self._lock:
            value = self._value
            return None if value is None else dict(value)
```

Prefer a separate process when callbacks or handlers perform CPU-heavy encoding/serialization. Multiple Python threads do not remove GIL contention.

Do not call `rclpy.spin_once()` or `spin_until_future_complete()` from an HTTP handler when another executor owns the node.

## Bridge rclpy futures into asyncio

`rclpy.task.Future.result()` does not accept a timeout and does not wait for completion. Use a thread-safe completion bridge:

```python
import asyncio
from typing import TypeVar

T = TypeVar("T")


async def await_ros_future(client, ros_future, timeout_s: float) -> T:
    loop = asyncio.get_running_loop()
    aio_future = loop.create_future()

    def on_ros_done(_):
        def transfer():
            if aio_future.done():
                return
            try:
                result = ros_future.result()
            except BaseException as exc:
                aio_future.set_exception(exc)
            else:
                aio_future.set_result(result)

        loop.call_soon_threadsafe(transfer)

    ros_future.add_done_callback(on_ros_done)

    try:
        return await asyncio.wait_for(aio_future, timeout=timeout_s)
    except TimeoutError:
        client.remove_pending_request(ros_future)
        ros_future.cancel()
        raise
```

Use it from FastAPI:

```python
from fastapi import HTTPException
from std_srvs.srv import Trigger


@app.post("/api/robot/emergency-stop")
async def emergency_stop():
    client = app.state.ros_node.estop_client
    if not client.service_is_ready():
        raise HTTPException(503, "Emergency-stop service is unavailable")

    ros_future = client.call_async(Trigger.Request())
    try:
        result = await await_ros_future(client, ros_future, timeout_s=5.0)
    except TimeoutError as exc:
        raise HTTPException(504, "Emergency-stop service timed out") from exc
    return {"success": result.success, "message": result.message}
```

Test the completion, ROS exception, timeout, and completion-timeout race paths. Verify behavior against the exact rclpy version. Directly awaiting an rclpy future has changed across versions and has a known Jazzy regression.

## Wrap services and actions

Map ROS outcomes to explicit HTTP semantics:

| Condition | Suggested HTTP result |
|---|---|
| invalid request | 400/422 |
| unauthorized/forbidden | 401/403 |
| target resource missing | 404 |
| state conflict | 409 |
| ROS dependency unavailable | 503 |
| ROS response timeout | 504 |

For long-running actions, return an operation ID and expose status/cancel resources. Do not hold an HTTP request open for an unbounded navigation/manipulation action.

Model an operation with explicit states and timestamps. Propagate ROS action rejection, cancellation, abort, and result separately.

Do not claim a command completed when it was merely accepted by the bridge.

## Wrap parameters carefully

- Expose an allowlist of nodes and parameter names.
- Validate value types and ranges before calling ROS.
- Check each `SetParametersResult`; `set_parameters()` may return unsuccessful results without raising.
- Preserve atomicity requirements with the appropriate atomic parameter service where needed.
- Return current values after successful mutation.
- Avoid catch-all `except Exception` that turns programming/runtime failures into user input errors.

Example result handling:

```python
results = node.set_parameters([parameter])
failed = [result.reason for result in results if not result.successful]
if failed:
    raise HTTPException(409, detail={"reasons": failed})
```

## Shutdown

Coordinate teardown in this order:

1. Stop accepting new commands.
2. Cancel web background tasks and close sockets/peer connections.
3. Shut down the ROS executor and wait for callbacks to finish.
4. Remove/destroy nodes.
5. Call `rclpy.shutdown()`.
6. Join the spin thread with a bounded timeout.

Use framework lifespan hooks rather than raising `KeyboardInterrupt` from a signal handler inside reusable application code.

## Testing

- Unit-test validation and response mapping without rclpy.
- Inject fake ROS clients/futures for timeout and failure tests.
- Run a real service/action integration test using the same executor topology.
- Verify parallel requests do not reuse mutable request objects.
- Verify shutdown during an outstanding request does not hang.
- Measure handler latency while ROS callbacks are busy.

## Primary sources

- https://docs.ros.org/en/rolling/p/rclpy/api/services.html
- https://github.com/ros2/rclpy/blob/jazzy/rclpy/rclpy/task.py
- https://github.com/ros2/rclpy/blob/jazzy/rclpy/rclpy/client.py
- https://github.com/ros2/rclpy/issues/1588
