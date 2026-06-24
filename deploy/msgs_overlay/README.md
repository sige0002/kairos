# Custom-message overlay (mount point)

Mount a pre-built colcon **`install/`** overlay of custom ROS 2 message packages
here so the recorder can record topics with non-standard types (e.g.
`tmc_control_msgs/msg/ServoState` in the AIROA HSR bags).

- `compose.yaml` mounts the host dir `${MSGS_OVERLAY_DIR:-./deploy/msgs_overlay}`
  to `/opt/msgs_overlay:ro` in the recorder; its entrypoint sources
  `/opt/msgs_overlay/install/setup.bash` if present.
- To populate it: build the custom msg packages in a colcon workspace, then
  place that workspace's `install/` here so this directory contains
  `install/setup.bash`.
- If empty (no `install/setup.bash`), the recorder logs a one-line warning and
  records only standard types — no failure (per the "assume msgs present"
  policy: provide the overlay when you need custom types).
- `install/` build artifacts are gitignored; this README is the only tracked file.

See `docs/specs/ja/rosbag2_recorder.md` → カスタムメッセージ対応.
