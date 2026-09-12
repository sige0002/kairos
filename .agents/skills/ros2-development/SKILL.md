---
name: ros2-development
description: Implement or debug ROS 2 nodes, packages, launch wiring, QoS, and graph behavior. Resolve the actual distribution and middleware before choosing APIs.
---

# ROS 2 development

Use the target repository's distribution, RMW, domain, overlays, and commands.
Inspect the relevant manifest, launch/Compose file, or running graph; a small
node fix does not require reading every deployment document. Verify version-
sensitive APIs against the selected distribution's official documentation.

Kairos defaults to Jazzy, `rmw_fastrtps_cpp`, and domain 0, with host network/IPC
on ROS containers. Configuration can override these values. A Cyclone DDS switch
must be deliberate and applied consistently to services and replay participants.

## Route by the problem

- Node callbacks, QoS, lifecycle, composition, actions:
  [nodes-qos-lifecycle.md](references/nodes-qos-lifecycle.md).
- Package manifests, colcon/ament, interfaces, launch, overlays:
  [packages-build-launch.md](references/packages-build-launch.md).
- DDS discovery, vendor selection, CLI diagnosis, deployment:
  [dds-debugging-deployment.md](references/dds-debugging-deployment.md).

Keep pure decisions testable without ROS. Choose topic/service/action by stream,
bounded request, or cancelable long-running semantics. Define timing, cancellation,
and failure behavior where they affect the interface. Use lifecycle/composition
when the required operational behavior or measured cost justifies it.

For missing data, distinguish node health and remapping, domain/discovery scope,
RMW, offered/requested QoS, network/IPC transport, and message type support.
Inspect `ros2 topic info <topic> -v` before changing QoS. Vendor switching is a
diagnostic/deployment choice, not a generic repair.

Source the underlay before overlays, declare dependencies in the package/build
system, and install required launch/config/interface resources. Do not hide
readiness behind fixed sleeps or rely on ambient developer-machine packages.

Verify the changed behavior using repository-native gates. Pure host tests do
not prove live rclpy or DDS behavior; use the appropriate ROS image/integration
harness for those paths and report the tested environment. Use isolated domains
when parallel tests could discover each other.
