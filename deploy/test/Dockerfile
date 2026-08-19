# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
# Test harness image: ROS 2 + rosbag2 MCAP storage, for `ros2 bag play` of recorded bags.
# ROS_DISTRO is adjustable; the default reads the MCAP samples under data/.
ARG ROS_DISTRO=jazzy
ARG ROS_BASE_IMAGE=ros:jazzy-ros-base@sha256:6513503d0b10e919fbe8134981d4f9d19b5c1f9b045b87a9fe3b0b9e03e7c2a9
FROM ${ROS_BASE_IMAGE}
ARG ROS_DISTRO
RUN test -d "/opt/ros/${ROS_DISTRO}" || { echo "ROS_BASE_IMAGE does not provide ROS_DISTRO=${ROS_DISTRO}" >&2; exit 1; }

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
