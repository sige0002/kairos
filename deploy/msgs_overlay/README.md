# Custom-message overlay (mount point)

Custom ROS 2 message packages the **recorder** needs to record (and the monitor
to subscribe to) topics with non-standard types — e.g. `rm_ros_interfaces/*` for
RealMan, `tmc_control_msgs/*` for the HSR.

> Live ROS only. Offline analysis (`dora_runner` on **MCAP**) uses the MCAP's
> embedded schemas and needs **none** of this. The overlay matters only for the
> live path (`ros2 bag record` / rclpy), which loads compiled typesupport.

## One command (no manual colcon)

1. Drop the message package **sources** under `src/` (each a colcon package with
   `package.xml` + `CMakeLists.txt` + `msg/`):
   ```
   deploy/msgs_overlay/src/rm_ros_interfaces/
   ```
2. Build them into `install/` using the recorder's ROS image (no host ROS):
   ```
   make msgs-build
   ```
   This colcon-builds `src/*` → `install/setup.bash`. The recorder's entrypoint
   sources `install/setup.bash` automatically.

## Multiple robots: shared vs per-robot

The overlay dir is selected by **`MSGS_OVERLAY_DIR`** (default `./deploy/msgs_overlay`),
used by both `make msgs-build` (what it builds) and `compose` (what the recorder
mounts) — so build and runtime always agree.

- **Shared (default):** put every robot's message packages in the one
  `src/` — they coexist in one `install/` (message packages don't conflict; the
  recorder records whatever types appear on the graph). Simplest.
- **Per-robot (isolated / swappable):** keep each robot's packages in its own dir
  and select it (must start with `./`):
  ```
  make msgs-build MSGS_OVERLAY_DIR=./deploy/msgs_overlay/realman
  make up         MSGS_OVERLAY_DIR=./deploy/msgs_overlay/realman   # mounts the same one
  ```
  Set `MSGS_OVERLAY_DIR` in your `.env` to make a robot's overlay the default.

## Notes

- Everything under this directory (message **sources** + colcon `build/`/`install/`/
  `log/`) is **gitignored** except this README — keeps confidential vendor message
  packages local and out of git.
- If empty (no `install/setup.bash`), the recorder logs a one-line warning and
  records only standard types — no failure.
- Monitoring custom-type topics live also needs the overlay on the monitor (not
  yet wired — tracked).

See `docs/specs/ja/rosbag2_recorder.md` → カスタムメッセージ対応.
