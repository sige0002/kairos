#!/usr/bin/env bash
# Generate the small, redistributable ROS 2 MCAP fixture used by release CI.
# Run inside a sourced Jazzy environment with rosbag2-storage-mcap installed.
set -euo pipefail

output_dir="${1:-data/ci-e2e/fixture}"
duration_s="${FIXTURE_DURATION_S:-8}"

if [ -e "$output_dir" ]; then
  echo "fixture output already exists: $output_dir" >&2
  exit 1
fi
mkdir -p "$(dirname "$output_dir")"

publisher_pids=""
bag_pid=""
cleanup() {
  if [ -n "$bag_pid" ]; then
    kill -INT "$bag_pid" 2>/dev/null || true
    wait "$bag_pid" 2>/dev/null || true
  fi
  for pid in $publisher_pids; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

publish() {
  topic="$1"
  message_type="$2"
  value="$3"
  rate="$4"
  ros2 topic pub --rate "$rate" "$topic" "$message_type" "$value" \
    >/dev/null 2>&1 &
  publisher_pids="$publisher_pids $!"
}

publish /hsrb/joint_states sensor_msgs/msg/JointState \
  "{header: {frame_id: base_link}, name: [joint], position: [0.0]}" 25
publish /hsrb/wrist_wrench/raw geometry_msgs/msg/WrenchStamped \
  "{header: {frame_id: wrist}}" 25
publish /hsrb/odom nav_msgs/msg/Odometry \
  "{header: {frame_id: odom}, child_frame_id: base_link}" 25
publish /hsrb/command_velocity geometry_msgs/msg/Twist \
  "{linear: {x: 0.0}, angular: {z: 0.0}}" 25
publish /hsrb/arm_trajectory_controller/command trajectory_msgs/msg/JointTrajectory \
  "{joint_names: [joint]}" 25
publish /hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed sensor_msgs/msg/CompressedImage \
  "{header: {frame_id: head_camera}, format: jpeg, data: [255, 216, 255, 217]}" 10
publish /hsrb/hand_camera/image_raw/compressed sensor_msgs/msg/CompressedImage \
  "{header: {frame_id: hand_camera}, format: jpeg, data: [255, 216, 255, 217]}" 10

# Allow DDS discovery before the recorder resolves its topic types.
sleep 2
ros2 bag record --storage mcap --output "$output_dir" \
  /hsrb/joint_states \
  /hsrb/wrist_wrench/raw \
  /hsrb/odom \
  /hsrb/command_velocity \
  /hsrb/arm_trajectory_controller/command \
  /hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed \
  /hsrb/hand_camera/image_raw/compressed &
bag_pid="$!"
sleep "$duration_s"
kill -INT "$bag_pid"
wait "$bag_pid"
bag_pid=""

ros2 bag info "$output_dir"
echo "generated fixture: $output_dir"
