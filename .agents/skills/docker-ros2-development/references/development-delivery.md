# Development, CI, and delivery

## Contents

- Compose structure and health
- Development volumes and devcontainers
- CI and validation
- Logging and resource controls
- Offline delivery and rollback

## Compose structure and health

Factor only truly shared settings into anchors. Keep service-specific devices, ports, health semantics, and writable mounts visible at the service.

```yaml
x-ros-env: &ros-env
  ROS_DOMAIN_ID: ${ROS_DOMAIN_ID:-0}
  RMW_IMPLEMENTATION: ${RMW_IMPLEMENTATION:-rmw_fastrtps_cpp}

services:
  driver:
    image: my-driver:${IMAGE_TAG:?set IMAGE_TAG}
    environment:
      <<: *ros-env
    network_mode: host
    ipc: host
    restart: unless-stopped
    healthcheck:
      test: [CMD, /opt/health/check-driver]
      interval: 5s
      timeout: 3s
      retries: 6
      start_period: 15s
```

Make health checks cheap and deterministic. Prefer an application liveness/readiness endpoint or direct internal state over repeatedly starting `ros2` CLI discovery processes.

Use `depends_on: condition: service_healthy` only for startup ordering. Applications must still tolerate later dependency loss and recovery.

Use profiles for optional development or deployment components:

```yaml
services:
  rviz:
    profiles: [dev]
  watchdog:
    profiles: [deploy]
```

Render every supported combination:

```bash
docker compose --project-directory . -f compose/compose.yaml config -q
docker compose --project-directory . -f compose/compose.yaml --profile dev config -q
```

## Development volumes

Mount source deliberately and isolate generated artifacts:

```yaml
services:
  dev:
    build:
      target: dev
    working_dir: /ros2_ws
    volumes:
      - ./src:/ros2_ws/src:rw
      - ros-build:/ros2_ws/build
      - ros-install:/ros2_ws/install
      - ros-log:/ros2_ws/log
      - ccache:/ccache

volumes:
  ros-build:
  ros-install:
  ros-log:
  ccache:
```

Do not let named build/install volumes hide stale ABI or overlay problems. Provide a safe clean/recreate workflow scoped to these volumes, and run clean builds in CI.

Avoid mounting host `node_modules`, Python virtual environments, or architecture-specific build outputs into images intended for another machine.

## Devcontainers

Keep devcontainer privileges opt-in. A baseline can set the target and source mount without granting full host access:

```json
{
  "name": "ROS 2 development",
  "build": {
    "dockerfile": "../Dockerfile",
    "target": "dev",
    "args": { "ROS_DISTRO": "jazzy" }
  },
  "workspaceMount": "source=${localWorkspaceFolder}/src,target=/ros2_ws/src,type=bind",
  "workspaceFolder": "/ros2_ws",
  "containerEnv": {
    "ROS_DOMAIN_ID": "0",
    "RMW_IMPLEMENTATION": "rmw_fastrtps_cpp"
  },
  "remoteUser": "rosuser"
}
```

Add host network, IPC, GPU, GUI, and devices only for tasks that need them. Do not use `--privileged` as a default developer convenience.

## CI and validation

Build and test the same targets/operators use locally:

1. Validate Dockerfile/build checks.
2. Build the development/test target.
3. Run package tests and lint inside a controlled environment.
4. Build the runtime target.
5. Render all Compose overlays/profiles.
6. Run a minimal runtime and health test.
7. Run architecture/distribution matrix jobs only for combinations the project supports.

Use BuildKit registry or GitHub Actions caches rather than hand-moving `/tmp` cache directories when the CI platform supports them. Pin action major versions according to project policy.

Do not include EOL distributions in a nominal support matrix. Verify ROS distribution support dates and base OS availability before updating matrices.

## Logging and resource controls

Set log rotation for long-running robot deployments:

```yaml
logging:
  driver: json-file
  options:
    max-size: 20m
    max-file: '5'
```

Apply memory and CPU controls based on measurement. Leave headroom for DDS buffers, image encoding, and startup peaks. Verify which Compose fields affect local Docker Compose versus Swarm-only deployment semantics.

Treat health-check subprocesses, restart loops, and verbose ROS logging as resource consumers. Add backoff at the application or orchestration layer when repeated restarts can overload hardware.

## Offline delivery

Separate these operations:

- build images on a connected/build-capable machine;
- export exact image tags or an OCI archive;
- transfer checksums and deployment configuration;
- load images on the target;
- validate that Compose resolves only local immutable tags;
- start without `build` or pull;
- retain the previous image set for rollback.

Example generic flow:

```bash
docker image save \
  my-driver:2026.08.18 \
  my-monitor:2026.08.18 \
  -o robot-stack-2026.08.18.tar
sha256sum robot-stack-2026.08.18.tar > robot-stack-2026.08.18.tar.sha256
```

On the target:

```bash
sha256sum -c robot-stack-2026.08.18.tar.sha256
docker image load -i robot-stack-2026.08.18.tar
docker compose --project-directory . -f compose/compose.yaml up -d --no-build --pull never
```

Prefer repository wrappers such as kairos `make images-save`, `make images-load`, and `make up` when provided; they encode the supported service set and tags.

Test offline behavior on a clean target or with network access deliberately unavailable. A warm builder cache is not evidence that startup is offline-safe.

## Rollback

- Keep deployment configuration compatible with the previous image set.
- Record the exact image IDs/digests before rollout.
- Define database/config downgrade limits before calling rollback safe.
- Verify health and representative ROS data after rollback.
- Never use an unqualified mutable `latest` as the sole rollback pointer.

## Primary sources

- https://docs.docker.com/reference/compose-file/
- https://docs.docker.com/reference/cli/docker/compose/up/
- https://containers.dev/implementors/json_reference/
