# CI and repository routing for robotics tests

## Contents

- Manifest-first routing
- CI layer separation
- Rosbag replay
- Kairos gates and evidence limits

## Manifest-first routing

Before copying a generic command, inspect:

- `package.xml`, `pyproject.toml`, `CMakeLists.txt`, and frontend manifests;
- the repository's CI workflows;
- root and nested `AGENTS.md` files;
- launch files, compose files, and existing test helpers.

Use the selected repository's ROS distribution and middleware. Do not hardcode a distribution from an example. Source `/opt/ros/$ROS_DISTRO/setup.bash` when a shell variable is intentionally configured and validated.

## CI layer separation

Separate fast deterministic tests from environment-heavy tests so a failure identifies its layer:

```yaml
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pytest -q

  ros-integration:
    runs-on: ubuntu-latest
    container:
      image: ros:${{ matrix.ros_distro }}-ros-base
    strategy:
      matrix:
        ros_distro: [jazzy]
    steps:
      - uses: actions/checkout@v4
      - run: rosdep install --from-paths src --ignore-src -y
      - run: |
          . /opt/ros/${ROS_DISTRO}/setup.sh
          colcon build
          . install/setup.sh
          colcon test
          colcon test-result --verbose
```

Adapt the matrix to the repository's supported targets; do not infer support from this example. Give parallel ROS jobs distinct `ROS_DOMAIN_ID` values.

## Rosbag replay

Use deterministic, versioned fixtures where their size and data policy permit it. Record:

- storage format and compression;
- message schemas and topic QoS;
- expected topic counts/rates and time source;
- whether replay uses simulated time;
- any custom-message overlay required by the player and receiver.

Wait for the system under test to subscribe before replay or use a paused/arming mechanism. A successful `ros2 bag play` process alone does not prove any consumer received data.

## Kairos gates and evidence limits

Use the root Makefile as the canonical entry point:

```bash
make test-py
make test-fe

# After changing a service used by acceptance tests:
make build
make test-e2e

# Real ROS graph replay and diagnosis:
make rosbag-loop BAG=<directory-under-data>
make table
make smoke
```

Important boundaries:

- `make test-e2e` starts the real browser and stack but does not build service images. Build first after changes under `services/`.
- `make test-fe` proves frontend build/unit/lint behavior, not real service wiring.
- Python unit suites can run without ROS because ROS imports are delayed; they do not exercise live `rclpy` paths.
- The E2E suite proves only the scenarios it drives. Read `e2e/README.md` before claiming screen or workflow coverage.
- Keep test data in the repository's configured data location and never commit runtime MCAP samples that policy excludes.
