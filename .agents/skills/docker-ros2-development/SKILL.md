---
name: docker-ros2-development
description: Build or debug ROS 2 container images, Compose wiring, DDS transport, and device access using the target deployment's existing choices.
---

# ROS 2 containers

Resolve the affected Dockerfile/Compose configuration, distribution, architecture,
RMW, network/IPC topology, and device needs. Preserve established entrypoints,
image identities, user IDs, volume ownership, and offline constraints unless the
task changes them.

Kairos defaults to Jazzy and `rmw_fastrtps_cpp`, with host networking and host IPC
on ROS-facing services. Cyclone DDS is an optional runtime choice, not a default
replacement. Keep build and startup separate through the existing Make targets;
offline startup must not acquire a build/pull dependency.

## Select the relevant reference

| Task | Reference |
|---|---|
| Base images, multi-stage builds, ARG/ENV, dependencies, entrypoints | [dockerfile-patterns.md](references/dockerfile-patterns.md) |
| Discovery, network modes, vendor transport, shared memory | [dds-networking.md](references/dds-networking.md) |
| GPU, USB/serial, udev, X11/Wayland | [hardware-gui.md](references/hardware-gui.md) |
| Devcontainers, runtime images, CI, health, offline delivery | [development-delivery.md](references/development-delivery.md) |

Read only the applicable reference. Multi-stage `ARG` values must be redeclared
inside each independent stage that uses them; a pre-FROM declaration alone
does not make a RUN variable available.

For DDS failures, distinguish endpoint health/discovery, domain/RMW, QoS, and
payload transport. Confirm the layer that fails before changing topology or
middleware. Same-host placement and shared IPC do not prove SHM or zero-copy.
Fast DDS SHM transport, data-sharing, and loaned zero-copy are distinct; Cyclone
DDS SHM requires version-compatible build/plugin support, not a standalone
legacy `SharedMemory/Enable` block.

Render affected Compose combinations before runtime checks. Build or exercise
only the targets needed to validate the change, within the task's authorization.
For transport changes, verify discovery and representative payload flow; for
hardware changes, verify only authorized devices with the necessary access.
Use narrow device/group mappings and explain any required broader privilege.
Do not add secret values to build arguments, layers, or tracked Compose files.
