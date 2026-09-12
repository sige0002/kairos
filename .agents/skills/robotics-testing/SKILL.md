---
name: robotics-testing
description: Design tests for ROS graph behavior, robotics timing, simulated or physical interfaces, and replayed workflows. Match the test layer to the claim.
---

# Robotics test evidence

Choose the lowest layer that can falsify the claim. Pure logic belongs in unit
or property tests; discovery/QoS needs ROS integration; dynamics may need
simulation; a physical interface needs authorized hardware evidence. Do not
claim a higher layer from a lower-layer pass.

## Determinism and readiness

Control clocks, random inputs, QoS, fixtures, and external state. Specify units,
frames, tolerances, denominator, and time source for numeric assertions. Bound
waits and report the terminal state, rather than treating a sleep as evidence.

For a publisher/subscriber test, install the result collector and subscriber
before publication, wait with a monotonic deadline for the required endpoint
match, then publish and spin until a result or timeout. A constructed endpoint
has not necessarily completed DDS discovery. Timeout diagnostics should include
topic, QoS, endpoint counts, and elapsed time.

Normal golden-file tests are read-only. Missing or changed goldens fail; updates
use a separate explicit tool/mode and reviewed diff. Fixtures should retain the
node/context and dependencies they use.

Test failure, stale data, cancellation, communication loss, and safe output where
those states are part of the changed contract. Isolate parallel ROS domains.
Use fakes for hardware unless physical testing is authorized.

## Relevant examples and repository gates

- Node/launch tests, mock publishers, discovery helpers:
  [ros2-integration.md](references/ros2-integration.md).
- Pure/property/golden tests, simulation and safety examples:
  [property-regression-simulation.md](references/property-regression-simulation.md).
- Package gates, CI, rosbag replay, kairos acceptance evidence:
  [ci-and-repository-routing.md](references/ci-and-repository-routing.md).

Kairos's host Python tests do not exercise lazy-imported rclpy paths. UI/behavior
changes require frontend checks, rebuilt affected images, and the E2E gate in
AGENTS.md. Select only relevant gates, and rerun after new changes or unresolved
failures rather than repeating passing unrelated suites.
