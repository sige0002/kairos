# DDS debugging and deployment

## Contents

- Graph inspection
- RMW selection
- Container networking
- Bags and CLI
- Production checks

## Graph inspection

Start with evidence:

```bash
env | grep -E '^(ROS_DISTRO|ROS_DOMAIN_ID|ROS_LOCALHOST_ONLY|RMW_IMPLEMENTATION)='
ros2 node list
ros2 topic list -t
ros2 topic info /camera/image_raw -v
ros2 topic hz /camera/image_raw
ros2 topic bw /camera/image_raw
ros2 doctor --report
```

For a silent topic, compare publisher and subscriber namespace/remapping, type, reliability, durability, history, deadline, liveliness, and discovery visibility. A daemon restart may refresh CLI discovery state, but it is not a substitute for finding the participant/network problem.

## RMW selection

Select the RMW required by the deployment and install it for the chosen distribution:

```bash
export RMW_IMPLEMENTATION=rmw_fastrtps_cpp
# or, when the deployment is configured for Cyclone DDS:
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
```

Keep every participant that must communicate on a mutually supported/configured setup. Mixed RMW deployments can interoperate through DDS in some configurations, but assuming identical defaults is safer operationally and avoids vendor-specific discovery/transport surprises. Validate actual interoperability rather than declaring it from vendor names.

Fast DDS and Cyclone DDS have different configuration schemas and shared-memory behavior. Never apply a Fast DDS shared-memory workaround as a vendor-neutral DDS rule.

### Kairos

Kairos defaults to Fast DDS (`rmw_fastrtps_cpp`) and installs Cyclone DDS as an opt-in alternative. Its ROS containers use host networking and host IPC; the replay harness must use the same RMW and `ROS_DOMAIN_ID`. Set `CYCLONEDDS_URI` only when switching the whole relevant graph to the Cyclone configuration.

## Container networking

Check all of the following:

- `ROS_DOMAIN_ID` and discovery-scope variables;
- host/bridge networking and multicast reachability;
- interface selection on multi-NIC hosts;
- firewall rules for discovery and data traffic;
- vendor-specific shared-memory transport and IPC namespace;
- custom-message type support in publisher and subscriber images;
- clock synchronization when comparing timestamps across hosts.

`ROS_LOCALHOST_ONLY=1` is appropriate only when communication must remain on one host. It will intentionally prevent cross-host discovery, so do not enable it as a generic hardening step for robot/PC deployments.

## Vendor configuration

Keep vendor-specific examples in deployment-owned files. For Cyclone DDS, point `CYCLONEDDS_URI` at a reviewed XML file. For Fast DDS, use the supported Fast DDS profile mechanism for the selected ROS distribution/RMW. Verify configuration fields against that version's official docs before editing; schemas and defaults can change.

Do not hardcode interface names such as `eth0` without inspecting the target host. Prefer an explicit deployment parameter and fail visibly when it does not resolve.

## Bags and CLI

Use a rosbag2 directory, not an arbitrary MCAP file path, with standard CLI commands:

```bash
ros2 bag info recording/
ros2 bag play recording/ --clock
ros2 bag record -s mcap /camera/image /tf
```

Before playback, create subscribers and wait for graph matches or use a paused/arming workflow so the first volatile messages are not lost. Custom message playback requires matching type support/overlays.

Useful inspection:

```bash
ros2 param list /perception
ros2 param get /perception confidence_threshold
ros2 service list -t
ros2 action list -t
ros2 lifecycle get /managed_perception
```

## Production checks

- Pin image/package inputs and record the tested distribution/RMW versions.
- Configure QoS explicitly for critical flows and test compatibility.
- Bound command freshness with watchdogs and safe-stop behavior.
- Use lifecycle nodes where controlled activation/recovery is required, not as ceremony.
- Use SROS2 or another authenticated boundary when the network is not trusted; test credential rotation and failure modes.
- Export health and timing metrics rather than depending only on `ros2 doctor`.
- Isolate robot groups with planned domain/discovery configuration and verify collision avoidance.
- Rehearse rollback with the same hardware, network, and middleware topology.
