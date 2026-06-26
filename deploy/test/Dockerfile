# Test harness image: ROS 2 + rosbag2 MCAP storage, for `ros2 bag play` of recorded bags.
# ROS_DISTRO is adjustable; the default reads the MCAP samples under data/.
ARG ROS_DISTRO=jazzy
FROM ros:${ROS_DISTRO}-ros-base
ARG ROS_DISTRO

# MCAP is the canonical recording format; install the rosbag2 MCAP storage plugin so
# `ros2 bag play` can read *.mcap bags. Also bundle the Cyclone DDS RMW so this
# replay "robot" can publish over either Fast DDS (default) or Cyclone DDS by
# setting RMW_IMPLEMENTATION, matching whatever the kairos services use.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ros-${ROS_DISTRO}-rosbag2-storage-mcap \
        ros-${ROS_DISTRO}-rmw-cyclonedds-cpp \
    && rm -rf /var/lib/apt/lists/*

# The base image entrypoint (ros_entrypoint.sh) sources /opt/ros/$ROS_DISTRO/setup.bash,
# so `command:` runs with the ROS 2 environment already sourced.
