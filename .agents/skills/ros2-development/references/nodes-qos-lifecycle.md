# Nodes, QoS, lifecycle, components, and actions

## Contents

- rclpy node skeleton
- rclcpp component notes
- Lifecycle contract
- QoS selection
- Action cancellation

## rclpy node skeleton

Keep parameter validation and processing logic separable from ROS callbacks.

```python
import rclpy
from rcl_interfaces.msg import FloatingPointRange, ParameterDescriptor, SetParametersResult
from rclpy.node import Node
from rclpy.qos import HistoryPolicy, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import Image
from vision_msgs.msg import Detection2DArray


class PerceptionNode(Node):
    def __init__(self) -> None:
        super().__init__("perception")
        descriptor = ParameterDescriptor(
            description="Processing rate in Hz",
            floating_point_range=[FloatingPointRange(from_value=1.0, to_value=120.0)],
        )
        self.declare_parameter("rate_hz", 30.0, descriptor)
        self.declare_parameter("confidence_threshold", 0.7)

        sensor_qos = QoSProfile(
            reliability=ReliabilityPolicy.BEST_EFFORT,
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
        )
        self.detections = self.create_publisher(Detection2DArray, "detections", 10)
        self.images = self.create_subscription(
            Image, "camera/image_raw", self.image_callback, sensor_qos
        )
        self.add_on_set_parameters_callback(self.validate_parameters)

    def validate_parameters(self, parameters):
        for parameter in parameters:
            if parameter.name == "confidence_threshold" and not 0.0 <= parameter.value <= 1.0:
                return SetParametersResult(successful=False, reason="must be in [0, 1]")
        return SetParametersResult(successful=True)

    def image_callback(self, message: Image) -> None:
        result = process_image(message, self.get_parameter("confidence_threshold").value)
        self.detections.publish(result)


def main(args=None) -> None:
    rclpy.init(args=args)
    node = PerceptionNode()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()
```

Do not swallow callback exceptions silently. Decide whether an error should reject input, transition lifecycle state, trip a watchdog, or stop the process for supervision.

## rclcpp component notes

For a composable node, accept `rclcpp::NodeOptions`, register with `RCLCPP_COMPONENTS_REGISTER_NODE`, and enable intra-process communication through node/subscription options when ownership permits it. Zero-copy is conditional: publisher/subscriber type, ownership (`UniquePtr`), process placement, and subscriber count all matter. Measure rather than promise it from a shared pointer alone.

```cpp
class FilterComponent : public rclcpp::Node {
public:
  explicit FilterComponent(const rclcpp::NodeOptions & options)
  : Node("filter", options) {
    auto qos = rclcpp::SensorDataQoS();
    sub_ = create_subscription<sensor_msgs::msg::Image>(
      "image", qos,
      [this](sensor_msgs::msg::Image::UniquePtr msg) { handle(std::move(msg)); });
  }
private:
  void handle(sensor_msgs::msg::Image::UniquePtr msg);
  rclcpp::Subscription<sensor_msgs::msg::Image>::SharedPtr sub_;
};
```

## Lifecycle contract

Use lifecycle nodes when the system needs controlled allocation and activation:

- `on_configure`: validate parameters and allocate resources; do not start external effects.
- `on_activate`: activate lifecycle publishers and begin work.
- `on_deactivate`: stop external effects and reach a safe inactive state.
- `on_cleanup`: release resources and return to unconfigured.
- `on_error`: record the fault and choose a recoverable or terminal transition.

Return transition failures instead of logging success after partial initialization. Test every transition and rollback path. Prefer lifecycle events/readiness over fixed launch delays.

## QoS selection

Compatibility is offered/requested and includes more than reliability. Inspect reliability, durability, history/depth, deadline, liveliness, and lifespan where used.

Typical starting points:

```python
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy

sensor_qos = QoSProfile(
    reliability=ReliabilityPolicy.BEST_EFFORT,
    durability=DurabilityPolicy.VOLATILE,
    history=HistoryPolicy.KEEP_LAST,
    depth=1,
)

command_qos = QoSProfile(
    reliability=ReliabilityPolicy.RELIABLE,
    durability=DurabilityPolicy.VOLATILE,
    history=HistoryPolicy.KEEP_LAST,
    depth=10,
)

latched_state_qos = QoSProfile(
    reliability=ReliabilityPolicy.RELIABLE,
    durability=DurabilityPolicy.TRANSIENT_LOCAL,
    history=HistoryPolicy.KEEP_LAST,
    depth=1,
)
```

These are starting points, not universal rules. A command stream also needs a watchdog and stale-command policy; RELIABLE delivery alone does not make continued motion safe.

## Action cancellation

Long-running actions must check cancellation at bounded intervals and return a terminal result only after work has stopped.

```python
async def execute_callback(self, goal_handle):
    steps = list(self.plan(goal_handle.request))
    for index, step in enumerate(steps):
        if goal_handle.is_cancel_requested:
            await self.stop_motion()
            goal_handle.canceled()
            return PickPlace.Result(success=False, message="canceled")
        await self.execute_step(step)
        feedback = PickPlace.Feedback(progress=(index + 1) / len(steps))
        goal_handle.publish_feedback(feedback)
    goal_handle.succeed()
    return PickPlace.Result(success=True)
```

Define concurrent-goal policy, resource ownership, preemption, timeout, and safe-stop behavior explicitly.
