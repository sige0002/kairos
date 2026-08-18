---
name: ros2-development
description: Design, build, review, and debug ROS 2 nodes, packages, launch files, components, interfaces, lifecycle nodes, actions, QoS, DDS discovery, workspace overlays, colcon and ament builds, custom messages, SROS2, Nav2, MoveIt 2, and micro-ROS. Use for rclpy/rclcpp implementation, package.xml or CMakeLists.txt work, ROS 2 deployment, middleware tuning, and ROS graph or build failures. Resolve the target distribution and RMW from the repository/deployment instead of assuming a fixed supported-version list.
---

# ROS 2 development

Inspect the repository and running deployment before selecting an API, distribution, middleware, or command. ROS 2 behavior varies by distribution, RMW implementation, QoS, network topology, and installed overlays.

## Resolve the environment first

1. Read root and nested agent guidance.
2. Inspect `package.xml`, `CMakeLists.txt`, `pyproject.toml`, Dockerfiles, compose/launch files, CI, and existing build commands.
3. Determine the actual `ROS_DISTRO`, `RMW_IMPLEMENTATION`, `ROS_DOMAIN_ID`, and overlay source order.
4. Check official documentation for the selected distribution when an API or support status may have changed.
5. Reproduce the failure or inspect the graph before changing QoS, DDS, or launch topology.

Do not infer supported distributions from this skill and do not copy a fixed distro from an example. Treat Rolling as moving, and verify lifecycle/support status rather than embedding a dated list.

### Kairos defaults

Kairos uses:

- `ROS_DISTRO=jazzy` by default, overrideable through the Make/compose configuration;
- `RMW_IMPLEMENTATION=rmw_fastrtps_cpp` (Fast DDS) by default;
- `ROS_DOMAIN_ID=0` by default;
- host networking and host IPC for the ROS containers.

Both Fast DDS and Cyclone DDS are installed in the relevant images. Switch to Cyclone DDS only when the deployment requires it, and switch every participant and replay harness consistently. Do not present Cyclone DDS as the universal recommendation.

## Design sequence

1. Keep algorithms and state transitions independent of ROS where practical.
2. Give each node one operational responsibility and explicit inputs, outputs, parameters, and failure behavior.
3. Choose topic, service, or action by interaction semantics:
   - topic for streams/state;
   - service for bounded request/response;
   - action for cancelable long-running work with feedback.
4. Set QoS from data semantics and the offered/requested compatibility rules. Never change reliability alone and assume the connection is fixed.
5. Use lifecycle nodes only when configure/activate/deactivate/error transitions are part of the required operational contract.
6. Use composition/intra-process communication after measuring copy/latency costs and confirming ownership constraints.
7. Make shutdown, cancellation, timeout, and safe-state transitions explicit.

Read [references/nodes-qos-lifecycle.md](references/nodes-qos-lifecycle.md) for rclpy/rclcpp node, lifecycle, QoS, component, and action examples.

## Package and launch workflow

- Declare dependencies in `package.xml` and the build system; do not rely on a developer machine's ambient installation.
- Use `ament_cmake` for C++/mixed/interface packages and `ament_python` for pure Python packages without generated interfaces.
- Source the selected ROS underlay first, then workspace overlays from least to most specific.
- Build the smallest affected package set during iteration and run the repository's canonical full gate before handoff.
- Install launch/config/interface resources explicitly.
- Keep launch arguments and remappings explicit; avoid fixed startup sleeps when a lifecycle or readiness signal is available.

Read [references/packages-build-launch.md](references/packages-build-launch.md) for package manifests, colcon, CMake, Python packaging, interfaces, launch, and overlay examples.

## DDS and QoS diagnosis

Check in this order:

1. Node/process health and namespace/remapping.
2. Same `ROS_DOMAIN_ID` and compatible discovery scope.
3. Intended RMW on every participant.
4. Offered/requested QoS using `ros2 topic info <topic> -v`.
5. Network interfaces, multicast/unicast policy, firewall, and container networking.
6. Shared-memory requirements for the selected vendor and container IPC configuration.
7. Message type support and sourced custom-message overlays.

Changing DDS vendor is a diagnostic or deployment choice, not a generic fix. Record the before/after graph and traffic evidence.

Read [references/dds-debugging-deployment.md](references/dds-debugging-deployment.md) for vendor-neutral debugging, Fast DDS/Cyclone DDS selection, CLI inspection, bags, and production checks.

## Build troubleshooting

- Package missing at configure time: verify dependency declaration, run `rosdep`, and source the underlay.
- Executable missing after build: source `install/setup.*`, then inspect `ros2 pkg executables` and install/entry-point declarations.
- Python edit not reflected: use the repository's rebuild command or `--symlink-install` when supported.
- Generated interface missing: verify generator/runtime dependencies, rebuild producers before consumers, and resource the overlay.
- Duplicate package: inspect `colcon list` and overlay order.
- Out of memory: reduce parallel workers before changing compiler flags or architecture.

## Verification

- Run formatting/lint, unit tests, package build, and integration/launch tests required by the repository.
- For graph behavior, wait for discovery and use bounded, observable checks rather than sleeps.
- For containerized ROS, validate the actual compose configuration and test both discovery and data transport.
- State the tested distribution, RMW, domain, topology, and whether custom overlays were loaded.

## Production checklist

- [ ] Distribution and RMW are explicit and supported for the deployment.
- [ ] QoS is explicit for critical topics and compatibility is tested.
- [ ] Domain/discovery exposure matches the intended network boundary.
- [ ] Lifecycle, watchdog, cancellation, and safe shutdown behavior are exercised.
- [ ] Parameters and hardware addresses are externalized and validated.
- [ ] Logs/metrics expose graph, timing, drop, and error state.
- [ ] Bags use the repository's required storage format and replay path.
- [ ] Security requirements are implemented and tested when the network is not trusted.
- [ ] Deployment and rollback artifacts are reproducible.
