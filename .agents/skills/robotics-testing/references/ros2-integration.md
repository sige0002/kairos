# ROS 2 integration testing patterns

## Contents

- Discovery-safe message test
- Launch-test ordering
- Deterministic mock publisher
- Failure diagnostics

## Discovery-safe message test

Create both endpoints, wait for a graph match, then publish. Spin every node that owns callbacks.

```python
import time

import rclpy
from rclpy.executors import SingleThreadedExecutor
from rclpy.node import Node
from std_msgs.msg import String


def spin_until(executor, predicate, timeout_s: float, reason: str) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        executor.spin_once(timeout_sec=0.05)
        if predicate():
            return
    raise AssertionError(reason)


def test_message_flow() -> None:
    rclpy.init()
    publisher_node = Node("test_publisher")
    subscriber_node = Node("test_subscriber")
    executor = SingleThreadedExecutor()
    executor.add_node(publisher_node)
    executor.add_node(subscriber_node)
    received: list[String] = []

    try:
        subscriber_node.create_subscription(String, "/status", received.append, 10)
        publisher = publisher_node.create_publisher(String, "/status", 10)

        spin_until(
            executor,
            lambda: publisher.get_subscription_count() >= 1,
            5.0,
            "subscriber did not match /status within 5 s",
        )
        publisher.publish(String(data="ready"))
        spin_until(
            executor,
            lambda: bool(received),
            5.0,
            "matched subscriber received no /status message within 5 s",
        )
        assert received[0].data == "ready"
    finally:
        executor.shutdown()
        publisher_node.destroy_node()
        subscriber_node.destroy_node()
        rclpy.shutdown()
```

When the code under test publishes from a callback, establish the output subscription and wait for its match before invoking the callback. A call to `spin_once()` after an unmatched first publish cannot recover that lost volatile message.

## Launch-test ordering

`launch_testing.actions.ReadyToTest()` means processes were launched; it does not prove DDS endpoints matched. Inside the test:

1. Create the test subscriber and publisher.
2. Add the test node to an executor.
3. Wait until the input publisher has a subscriber and the output subscriber has a publisher.
4. Publish the stimulus.
5. Spin until the output or a monotonic deadline.

```python
def endpoints_ready(input_pub, test_node) -> bool:
    return (
        input_pub.get_subscription_count() >= 1
        and test_node.count_publishers("/planner/path") >= 1
    )
```

Match the QoS used by the production endpoint. On timeout, include `get_subscription_count()`, `count_publishers()`, and `ros2 topic info -v` guidance in the failure message.

## Deterministic mock publisher

Retain the node used to create the publisher; do not reference an unset `self.node` later.

```python
import numpy as np
from sensor_msgs.msg import JointState


class MockJointStatePublisher:
    def __init__(self, node, trajectory=None):
        self.node = node
        self.publisher = node.create_publisher(JointState, "/joint_states", 10)
        self.step = 0
        if trajectory is None:
            t = np.linspace(0, 2 * np.pi, 100)
            trajectory = np.column_stack(
                [0.1 * np.sin(t + index * 0.5) for index in range(7)]
            )
        self.trajectory = np.asarray(trajectory)

    def publish_next(self) -> None:
        msg = JointState()
        msg.header.stamp = self.node.get_clock().now().to_msg()
        msg.name = [f"joint_{index}" for index in range(7)]
        row = self.trajectory[self.step % len(self.trajectory)]
        msg.position = row.tolist()
        self.publisher.publish(msg)
        self.step += 1
```

For a replayable clock, inject a `now()` function instead of reading the node's live clock.

## Failure diagnostics

- Use `time.monotonic()` for wall-clock deadlines. ROS time can remain paused under `use_sim_time`.
- Keep endpoint objects alive for the whole assertion; losing the subscription reference may allow collection.
- Use a dedicated `ROS_DOMAIN_ID` for parallel integration jobs.
- Treat QoS incompatibility as a first-class failure: report reliability, durability, history, and depth.
- Destroy nodes and shut down the context in `finally` blocks so one failure does not poison later tests.
