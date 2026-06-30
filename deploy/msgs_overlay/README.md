# Custom-message overlay (mount point)

Custom ROS 2 message packages the **recorder** needs to record (and the
**monitor** / **probe** / the **bag player** to handle) topics with non-standard
types — e.g. `tmc_control_msgs/*` for the HSR, or a vendor's `<robot>_msgs/*`.

> Live ROS only. Offline analysis (`dora_runner` on **MCAP**) uses the MCAP's
> embedded schemas and needs **none** of this. The overlay matters only for the
> live path (`ros2 bag record` / `ros2 bag play` / rclpy), which loads compiled
> typesupport.

> A robot's bag may use **more than one** custom package (e.g. one for the arm
> and one for the mobile base). Build **every** package its topics use — any
> package you omit has its topics **silently skipped** (no error); only the
> standard-type topics are recorded/played.

## Build (no manual colcon)

The overlay dir is chosen by **`MSGS_OVERLAY_DIR`**; the same value drives both
`make msgs-build` (what it builds) and `compose` (what the services mount), so
build and runtime always agree. **Default: `./deploy/msgs_overlay/robot`** (ships
empty — only `.gitkeep`), so a plain `make msgs-build` / `make up` adds no custom
types until you populate that dir or point at a per-robot one.

Per-robot (recommended — isolated / swappable; the path must start with `./`):

1. Drop the vendor message **sources** under the robot's `src/` (each a colcon
   package with `package.xml` + `CMakeLists.txt` + `msg/`). Obtain these from the
   robot vendor / their ROS 2 driver repo — a fresh clone ships none (gitignored):
   ```
   deploy/msgs_overlay/<robot>/src/<robot>_msgs/
   deploy/msgs_overlay/<robot>/src/<another_pkg>/      # if the bag uses several
   ```
2. Build them into `install/` using the recorder's ROS image (no host ROS):
   ```
   make msgs-build MSGS_OVERLAY_DIR=./deploy/msgs_overlay/<robot>
   ```
   This colcon-builds `src/*` → `install/setup.bash`, which the recorder / monitor
   / probe entrypoints (and the bag player) source automatically.
3. Use the same dir at run time:
   ```
   make up MSGS_OVERLAY_DIR=./deploy/msgs_overlay/<robot>
   ```
   Set `MSGS_OVERLAY_DIR` in your `.env` to make a robot's overlay the default.

Shared alternative: put every robot's packages under one dir's `src/` — they
coexist in one `install/` (message packages don't conflict). Simpler, but couples
robots; per-robot keeps them swappable.

## Notes

- Everything under this directory (message **sources** + colcon `build/`/`install/`/
  `log/`) is **gitignored** except this README — keeps confidential vendor message
  packages local and out of git. A fresh clone therefore has **no** sources; fetch
  them from the vendor before `make msgs-build`.
- If the selected overlay is empty (no `install/setup.bash`), the recorder logs a
  one-line warning and records only standard types — no hard failure (but the
  custom-type topics are absent from the bag).
- The **bag player** (`deploy/test/compose.yaml`) and the **monitor** / **probe**
  also source the selected overlay, so `ros2 bag play` can publish custom-type
  topics and the monitor can measure them. (`make table` / `topic_table` does NOT
  mount the overlay — it shows Hz for standard types only.)

See `docs/specs/ja/rosbag2_recorder.md` → カスタムメッセージ対応.
