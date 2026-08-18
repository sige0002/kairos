---
name: robotics-testing
description: Testing strategies and safe examples for robotics software, including ROS 2 unit and launch tests, DDS discovery synchronization, deterministic sensor fixtures, mock hardware, simulation and hardware-in-the-loop layers, property-based tests, trajectory golden files, rosbag replay, and robotics CI. Use when writing or reviewing tests for robot nodes, message flows, perception, planning, control, hardware adapters, or end-to-end robot behavior.
---

# Robotics testing

Build evidence in layers and make every wait, oracle, and hardware boundary explicit. Inspect the repository's manifests, CI, and test commands before choosing a framework or inventing a gate.

## Workflow

1. Identify the claim: pure algorithm, node callback, ROS graph interaction, multi-node behavior, simulation, HIL, or field behavior.
2. Choose the lowest layer that can falsify it. Add a higher layer only for behavior the lower layer cannot observe.
3. Control clocks, random seeds, input fixtures, DDS domain, QoS, and external state.
4. Synchronize on observable readiness or completion. Never use a fixed sleep as proof.
5. Test failure, cancellation, timeout, stale data, malformed input, and safe-stop behavior as well as success.
6. Run the repository's canonical gates and state what each passing layer actually proves.

## Test-layer selection

| Claim | Preferred layer | Typical evidence |
|---|---|---|
| Math, parsing, state transition | Pure unit test | return values, invariants, property checks |
| One node's callback/parameters | Node-level test | published message, state, rejected parameter |
| DDS/QoS/launch wiring | ROS integration or `launch_testing` | matched endpoints and received messages |
| Several nodes and processes | Integration test | bounded end-to-end outcome |
| Dynamics, collision, timing envelope | Deterministic simulation | task result and safety invariant |
| Driver or physical interface | HIL | measured I/O and fail-safe response |
| Product workflow | Browser/field acceptance | user-visible outcome against real services |

Keep unit tests numerous and fast. Use fewer integration, simulation, HIL, and field tests as cost and variability increase.

## DDS synchronization rule

Creating a publisher or subscriber does not mean discovery has completed. Use this order:

1. Create the event/result collector.
2. Create the subscriber.
3. Create or obtain the publisher.
4. Wait with a monotonic deadline until the publisher reports the expected subscription match (or the subscriber reports a publisher).
5. Publish only after the match.
6. Spin the nodes/executor until the result arrives or the deadline expires.
7. Fail with endpoint counts, topic, QoS, and elapsed time when the deadline expires.

Do not publish before creating the subscriber. Do not create an event after publishing. Do not replace graph readiness with `sleep()`.

Read [references/ros2-integration.md](references/ros2-integration.md) when writing ROS 2 node tests, launch tests, mock publishers, or discovery helpers.

## Determinism and oracles

- Seed every random source, including libraries and simulators, or inject deterministic data directly.
- Prefer fake clocks and explicit stepping over wall-clock timing.
- Assert physical invariants and safety bounds, not only exact arrays.
- Record the denominator, tolerance, frame, units, and time source for numeric assertions.
- Bound loops by time or iteration count and report the terminal state on failure.
- Keep test fixtures immutable unless the test explicitly verifies persistence.

Golden files are reviewed baselines, not cache files. A normal test run must never create or rewrite them. If a golden is missing, fail with the repository's explicit update command. Generate or update goldens in a separate tool or opt-in command, review the diff, then run the tests again without update mode.

Read [references/property-regression-simulation.md](references/property-regression-simulation.md) for pure-function, property-based, golden-file, simulation, and safety examples.

## Hardware and process boundaries

- Put hardware behind an interface and inject a fake with the same contract.
- Make mock timestamps and sequences deterministic; retain the node/context used by the mock.
- Verify timeout behavior and safe output when communication disappears.
- Separate simulator correctness from application correctness; a simulation pass is not HIL evidence.
- Isolate ROS tests with a dedicated `ROS_DOMAIN_ID` where parallel runs could discover each other.

## Repository and CI routing

Use [references/ci-and-repository-routing.md](references/ci-and-repository-routing.md) when choosing package gates, rosbag replay, CI layers, or kairos-specific acceptance tests.

For kairos:

- Run pure Python package tests from that package with `uv run --extra test pytest -q`; use `make test-py` for the complete Python set.
- Run `make test-fe` for frontend build, unit tests, and lint.
- For a UI or behavior change, rebuild changed service images first (`make build` or the scoped build target), then run `make test-e2e`. The E2E target intentionally does not build images.
- Use `make rosbag-loop`, `make table`, and `make smoke` for real ROS graph replay and observability. Keep the replay stack's `ROS_DOMAIN_ID` and RMW aligned with the services.
- Do not claim that unit tests exercised lazy-imported `rclpy` paths; those paths require the ROS image or the real-stack acceptance harness.

## Review checklist

- [ ] The selected layer can observe the claim.
- [ ] Publishers wait for discovery before the first message.
- [ ] Waits use deadlines and diagnostic failures, not sleeps.
- [ ] Randomness and clocks are controlled.
- [ ] Golden tests are read-only in normal mode.
- [ ] Failure and safe-stop paths are asserted.
- [ ] Mocks retain every dependency they use and implement the real contract.
- [ ] Higher-level test claims do not exceed the services/screens they exercised.
- [ ] Repository-native gates were run in the required order.
