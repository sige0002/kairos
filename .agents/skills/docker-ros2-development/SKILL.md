---
name: docker-ros2-development
description: Design, build, deploy, and debug ROS 2 containers. Use for Dockerfiles and multi-stage colcon builds; Compose stacks; DDS discovery or shared-memory issues with Fast DDS or Cyclone DDS; GPU, USB, X11, or Wayland passthrough; devcontainers; container CI; and development-versus-deployment image strategy. Apply to the ROS 2 distributions supported by the target project. Inspect the repository's chosen distribution, RMW implementation, network topology, and offline-delivery rules before selecting generic defaults.
---

# Docker-based ROS 2 development

## Start from repository truth

1. Read the repository instructions, Compose files, Dockerfiles, and deployment documentation before proposing changes.
2. Identify the supported ROS distribution, base image, CPU architecture, RMW implementation, network topology, device requirements, and build/offline constraints.
3. Preserve established entrypoints, image tags, health semantics, user IDs, and volume ownership unless the task explicitly changes them.
4. Distinguish project defaults from generic vendor choices. Do not silently replace a project's Fast DDS default with Cyclone DDS, or vice versa.
5. Change the smallest deployable unit and validate the rendered Compose configuration before runtime tests.

For kairos specifically:

- Treat Jazzy as the default unless `ROS_DISTRO` overrides it.
- Treat `rmw_fastrtps_cpp` as the default and `rmw_cyclonedds_cpp` as an optional runtime selection.
- Preserve `network_mode: host` and `ipc: host` on ROS-facing services.
- Keep build and startup separate. Use repository `make` targets and offline image save/load flows rather than adding implicit builds to `up`.

## Route to the needed reference

Read only the references relevant to the request:

- Read [dockerfile-patterns.md](references/dockerfile-patterns.md) for base-image selection, `ARG` scope, multi-stage builds, rosdep caching, non-root runtimes, entrypoints, and image-size decisions.
- Read [dds-networking.md](references/dds-networking.md) for host/bridge networking, discovery, Fast DDS versus Cyclone DDS, shared memory, and DDS troubleshooting.
- Read [hardware-gui.md](references/hardware-gui.md) for NVIDIA GPU, cameras, serial devices, udev, X11, Wayland, and headless visualization.
- Read [development-delivery.md](references/development-delivery.md) for Compose profiles, devcontainers, source/build volumes, CI, health checks, logging, offline delivery, and rollback.

## Choose the container boundary deliberately

- Match one container to one independently deployable subsystem when the repository already uses that boundary.
- Keep build tools out of production stages.
- Keep hardware drivers, high-rate perception, planning, and web/API services isolated when they have different restart, resource, or device requirements.
- Do not split tightly coupled processes merely to satisfy a slogan. Account for latency, shared-memory availability, lifecycle coupling, and operational complexity.

## Build images safely

1. Declare global build arguments before `FROM` only when a `FROM` expression needs them.
2. Consume each global `ARG` again inside every independent stage that uses it.
3. Promote values needed by the running container to `ENV`; build arguments do not persist at runtime.
4. Copy package manifests before source, install dependencies, then copy and build source.
5. Pin critical tools and lock application dependencies when the repository requires reproducibility or offline rebuilds.
6. Copy only runtime artifacts into the final stage.
7. Run the final image as a non-root user unless hardware or middleware constraints require a documented exception.
8. Source both the ROS underlay and workspace overlay in the entrypoint.

Use this invariant for ROS distribution arguments:

```dockerfile
ARG ROS_DISTRO=jazzy

FROM ros:${ROS_DISTRO}-ros-base AS build
ARG ROS_DISTRO
ENV ROS_DISTRO=${ROS_DISTRO}

FROM ros:${ROS_DISTRO}-ros-core AS runtime
ARG ROS_DISTRO
ENV ROS_DISTRO=${ROS_DISTRO}
```

Do not use a pre-`FROM` `ARG` inside `RUN` without redeclaring it in that stage.

## Select ROS networking from evidence

Use this order:

1. Confirm both endpoints use the intended `ROS_DOMAIN_ID` and RMW implementation.
2. Confirm the container is attached to the expected network and interface.
3. Confirm discovery before diagnosing topic QoS or payload transport.
4. Confirm publisher/subscriber QoS compatibility.
5. Measure the actual data path before claiming shared memory, zero-copy, or network isolation.

Use host networking for the simplest Linux single-host or robot-LAN deployment when its reduced isolation is acceptable. Use bridge networking only after testing multicast behavior or configuring vendor-supported unicast/discovery services. Do not claim that every Docker bridge blocks multicast; behavior depends on Docker, host firewall, network driver, and DDS configuration.

## Treat shared memory as vendor-specific

- Fast DDS creates an SHM transport by default when builtin transports remain enabled. In Docker, use both host networking and a shared IPC namespace for inter-container SHM. Prefer `ipc: host` or explicit shared IPC over bind-mounting `/dev/shm`.
- Do not call Fast DDS SHM transport zero-copy. Data-sharing delivery and loan-based zero-copy are separate mechanisms with additional constraints.
- Do not enable Cyclone DDS shared memory with the legacy standalone `SharedMemory/Enable` XML block. Modern Cyclone DDS shared-memory exchange requires a compatible build/plugin, iceoryx/RouDi or the applicable PSMX setup, and version-matched configuration.
- If a project image does not bundle that Cyclone DDS support, expect network transport even when IPC is shared.

## Handle hardware with least privilege

- Pass only required devices and groups.
- Prefer stable host-side udev symlinks over enumeration-dependent `/dev/ttyUSB0` names.
- Prefer Compose GPU device reservations over `privileged: true`.
- Use `privileged` or a full `/dev` mount only when narrower device mappings cannot support hot-plug requirements, and document the security tradeoff.
- Match host UID/GID or use explicit ownership handling for writable bind mounts.

## Separate development from deployment

- Use a development target for compilers, debuggers, linters, editors, and source mounts.
- Use a runtime target with fixed artifacts and no source bind mounts.
- Keep build, load, start, restart, and configuration reload as distinct operations when offline operation matters.
- Persist caches and build artifacts only where they do not contaminate deploy images or hide clean-build failures.
- Version production images with an immutable digest, commit, or release tag; retain a known-good rollback image.

## Verify in layers

Run the least expensive checks first:

1. Validate Dockerfile syntax/build arguments and build the affected target.
2. Render every affected Compose combination with `docker compose config -q` or the repository wrapper.
3. Inspect the runtime environment, user, mounts, devices, network mode, IPC mode, and entrypoint.
4. Confirm ROS discovery with a minimal talker/listener or topic list using the same RMW and domain.
5. Confirm QoS and payload flow with representative message sizes.
6. Measure SHM/network behavior rather than inferring it from configuration.
7. Exercise health checks, restart behavior, shutdown, log rotation, and rollback.
8. For offline delivery, load saved images on a clean/disconnected target and start without building or pulling.

## Reject common failure patterns

- Do not put secrets in `ARG`, image layers, or Compose files.
- Do not run `apt-get update` without package installation in the same layer.
- Do not bind-mount an entire workspace when build/install/log artifacts should be isolated.
- Do not rely on `depends_on` alone as application readiness.
- Do not hardcode one `ROS_DOMAIN_ID` for every deployed robot.
- Do not assume same-host DDS means SHM is active.
- Do not assume shared memory means zero-copy.
- Do not use mutable `latest` as the only production rollback identity.
- Do not make normal startup require network access when the deployment must operate offline.

## Primary sources

- Dockerfile `ARG` scope: https://docs.docker.com/reference/dockerfile/#understand-how-arg-and-from-interact
- Docker build-variable scoping: https://docs.docker.com/build/building/variables/#scoping
- Fast DDS SHM in Docker: https://fast-dds.docs.eprosima.com/en/3.2.x/docker/shm_docker.html
- Fast DDS SHM transport: https://fast-dds.docs.eprosima.com/en/3.x/fastdds/transport/shared_memory/shared_memory.html
- Fast DDS data-sharing: https://fast-dds.docs.eprosima.com/en/latest/fastdds/transport/datasharing.html
- Cyclone DDS shared memory: https://cyclonedds.io/docs/cyclonedds/latest/shared_memory/shared_mem_config.html
