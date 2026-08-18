# Dockerfile patterns for ROS 2

## Contents

- Base-image selection
- Correct multi-stage template
- Dependency and source caching
- Entrypoint and runtime user
- Image checks

## Base-image selection

Choose the smallest official image that contains the runtime capabilities the service needs. Verify current tags instead of copying historical size estimates.

| Need | Typical base |
|---|---|
| One headless node with explicit dependencies | `ros:<distro>-ros-core` |
| Common interfaces, launch, rosbag, or broader CLI use | `ros:<distro>-ros-base` |
| Perception libraries | `ros:<distro>-perception` |
| rviz2/rqt desktop development | `ros:<distro>-desktop` |

Use the repository's established distribution. Do not combine a ROS distribution with an unsupported Ubuntu release merely because both images exist separately.

## Correct multi-stage template

Consume global arguments inside each independent stage that uses them. Persist runtime values with `ENV`.

```dockerfile
# syntax=docker/dockerfile:1
ARG ROS_DISTRO=jazzy

FROM ros:${ROS_DISTRO}-ros-base AS deps
ARG ROS_DISTRO
ENV ROS_DISTRO=${ROS_DISTRO}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3-colcon-common-extensions \
       python3-rosdep \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /ros2_ws
COPY src/my_msgs/package.xml src/my_msgs/package.xml
COPY src/my_node/package.xml src/my_node/package.xml
RUN . "/opt/ros/${ROS_DISTRO}/setup.sh" \
    && apt-get update \
    && rosdep install --from-paths src --ignore-src -r -y \
    && rm -rf /var/lib/apt/lists/*

FROM deps AS dev
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential gdb ccache python3-pytest \
    && rm -rf /var/lib/apt/lists/*
ENV CCACHE_DIR=/ccache CC="ccache gcc" CXX="ccache g++"
COPY src/ src/
COPY docker/ros-entrypoint.sh /ros-entrypoint.sh
ENTRYPOINT ["/ros-entrypoint.sh"]
CMD ["bash"]

FROM deps AS build
COPY src/ src/
RUN . "/opt/ros/${ROS_DISTRO}/setup.sh" \
    && colcon build \
       --cmake-args -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF \
       --event-handlers console_direct+

FROM ros:${ROS_DISTRO}-ros-core AS runtime
ARG ROS_DISTRO
ENV ROS_DISTRO=${ROS_DISTRO} \
    RMW_IMPLEMENTATION=rmw_fastrtps_cpp

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-yaml \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /ros2_ws/install /ros2_ws/install
COPY docker/ros-entrypoint.sh /ros-entrypoint.sh
RUN groupadd --system rosuser \
    && useradd --system --gid rosuser --create-home --shell /bin/bash rosuser \
    && chown -R rosuser:rosuser /ros2_ws
USER rosuser
ENTRYPOINT ["/ros-entrypoint.sh"]
CMD ["ros2", "launch", "my_node", "bringup.launch.py"]
```

If a runtime package name contains the distribution, declare `ARG ROS_DISTRO` before the install step:

```dockerfile
FROM ros:${ROS_DISTRO}-ros-base AS runtime
ARG ROS_DISTRO
ENV ROS_DISTRO=${ROS_DISTRO}
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       "ros-${ROS_DISTRO}-rmw-cyclonedds-cpp" \
    && rm -rf /var/lib/apt/lists/*
```

Do not repeat a different stage default such as `ARG ROS_DISTRO=humble`; consume the global value with `ARG ROS_DISTRO`.

## Dependency and source caching

Order layers by change frequency:

1. Base image and system repositories.
2. System packages.
3. Package manifests and lockfiles.
4. Dependency installation.
5. Source files.
6. Build.
7. Build identity metadata.

Copying only a few package manifests by hand is fragile when packages are added. Prefer a deterministic manifest-extraction step or accept a broader cache invalidation when maintenance risk exceeds build-time savings.

Use BuildKit cache mounts only when the build environment supports them and they do not undermine offline/reproducible requirements:

```dockerfile
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends build-essential
```

Keep `apt-get update` and install in one instruction. Remove package indexes in production-oriented images when not using cache mounts.

## Entrypoint and runtime user

Use a fail-fast entrypoint:

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${ROS_DISTRO:?ROS_DISTRO must be set}"
source "/opt/ros/${ROS_DISTRO}/setup.bash"
if [[ -f /ros2_ws/install/setup.bash ]]; then
  source /ros2_ws/install/setup.bash
fi
exec "$@"
```

Keep the runtime user non-root. Add only required supplementary groups such as `video` or `dialout`. Account for host UID/GID when writing to bind mounts; a fixed image UID does not automatically match the operator.

Do not bake device nodes, credentials, mutable robot configuration, or host-specific IDs into the image.

## Python services in ROS images

- Preserve access to system `rclpy` when using a virtual environment; use `--system-site-packages` if that is the selected packaging strategy.
- Lock Python dependencies and avoid network resolution during normal startup.
- Keep ROS imports lazy only when the service intentionally supports pure-logic tests or health endpoints without ROS.
- Verify the runtime interpreter imports both the installed application and `rclpy`.

## Image checks

Run checks proportional to the change:

```bash
docker build --target runtime --build-arg ROS_DISTRO=jazzy -t my-node:test .
docker run --rm --entrypoint bash my-node:test -lc '
  test "$ROS_DISTRO" = jazzy
  source "/opt/ros/$ROS_DISTRO/setup.bash"
  source /ros2_ws/install/setup.bash
  ros2 pkg executables my_node
'
```

Inspect image history and runtime identity:

```bash
docker history --no-trunc my-node:test
docker run --rm --entrypoint id my-node:test
```

Reject builds that require secrets as build arguments. Use BuildKit secrets for authenticated dependency retrieval, then ensure the final layer contains no credential material.

## Primary sources

- https://docs.docker.com/reference/dockerfile/
- https://docs.docker.com/build/building/multi-stage/
- https://docs.docker.com/build/building/variables/#scoping
