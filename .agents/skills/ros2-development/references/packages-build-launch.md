# Packages, builds, interfaces, and launch

## Contents

- Workspace and overlays
- Package dependencies
- CMake and Python packages
- Interfaces
- Launch files

## Workspace and overlays

Use the distribution selected by the repository:

```bash
: "${ROS_DISTRO:?set ROS_DISTRO to the repository's selected distribution}"
. "/opt/ros/${ROS_DISTRO}/setup.bash"

rosdep install --from-paths src --ignore-src -y
colcon build --packages-up-to my_robot_pkg --symlink-install
. install/setup.bash
colcon test --packages-select my_robot_pkg
colcon test-result --verbose
```

Source the base underlay first and overlays from shared to task-specific. The last sourced version wins. Never source from `build/`; source the generated `install/setup.*`.

Useful iteration flags:

```bash
colcon build --packages-select my_robot_pkg
colcon build --packages-up-to my_robot_pkg
colcon build --parallel-workers 2
colcon build --event-handlers console_direct+
colcon build --cmake-args -DCMAKE_BUILD_TYPE=Release
```

Do not delete a shared workspace's `build/ install/ log/` tree without confirming scope and ownership.

## Package dependencies

Declare build, runtime, interface, and test dependencies in `package.xml`:

```xml
<?xml version="1.0"?>
<package format="3">
  <name>my_robot_pkg</name>
  <version>0.1.0</version>
  <description>Robot perception package</description>
  <maintainer email="dev@example.com">Maintainer</maintainer>
  <license>Apache-2.0</license>

  <buildtool_depend>ament_cmake</buildtool_depend>
  <depend>rclcpp</depend>
  <depend>sensor_msgs</depend>
  <depend>geometry_msgs</depend>

  <build_depend>rosidl_default_generators</build_depend>
  <exec_depend>rosidl_default_runtime</exec_depend>
  <member_of_group>rosidl_interface_packages</member_of_group>

  <test_depend>ament_lint_auto</test_depend>
  <test_depend>launch_testing_ament_cmake</test_depend>
  <export><build_type>ament_cmake</build_type></export>
</package>
```

Use `<depend>` where a dependency is needed at build and runtime. Avoid declaring both granular and aggregate forms for the same dependency without a reason.

## CMake package

```cmake
cmake_minimum_required(VERSION 3.8)
project(my_robot_pkg)

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(rosidl_default_generators REQUIRED)

rosidl_generate_interfaces(${PROJECT_NAME}
  "msg/Detection.msg"
  "srv/GetPose.srv"
  "action/PickPlace.action"
  DEPENDENCIES sensor_msgs
)

add_executable(perception_node src/perception_node.cpp)
ament_target_dependencies(perception_node rclcpp sensor_msgs)
install(TARGETS perception_node DESTINATION lib/${PROJECT_NAME})
install(DIRECTORY launch config DESTINATION share/${PROJECT_NAME})

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  ament_lint_auto_find_test_dependencies()
  find_package(launch_testing_ament_cmake REQUIRED)
  add_launch_test(test/test_integration.py)
endif()

ament_package()
```

For components, add `rclcpp_components`, build a shared library, call `rclcpp_components_register_node`, and install the target.

## Pure Python package

Use `ament_python` only when the package does not generate interfaces or compile native code. Register executable entry points and install resource index, manifest, launch, and config files.

```python
from glob import glob
from setuptools import find_packages, setup

package_name = "my_python_pkg"

setup(
    name=package_name,
    version="0.1.0",
    packages=find_packages(exclude=["test"]),
    data_files=[
        ("share/ament_index/resource_index/packages", [f"resource/{package_name}"]),
        (f"share/{package_name}", ["package.xml"]),
        (f"share/{package_name}/launch", glob("launch/*.launch.py")),
    ],
    install_requires=["setuptools"],
    entry_points={
        "console_scripts": [
            "perception = my_python_pkg.perception:main",
        ]
    },
)
```

## Interfaces

Keep goals and results explicit and unit-bearing where ambiguity is possible:

```text
# action/PickPlace.action
geometry_msgs/PoseStamped target_pose
string object_class
---
bool success
string error_code
string message
---
float32 progress
string current_phase
```

Build interface producers before consumers and source the resulting overlay. Preserve backward compatibility deliberately; changing a message definition affects every generated client.

## Launch files

Use launch arguments and package-share paths rather than fixed machine paths:

```python
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    config = PathJoinSubstitution(
        [FindPackageShare("my_robot_pkg"), "config", "robot.yaml"]
    )
    return LaunchDescription(
        [
            DeclareLaunchArgument("namespace", default_value="robot"),
            Node(
                package="my_robot_pkg",
                executable="perception_node",
                namespace=LaunchConfiguration("namespace"),
                parameters=[config],
                remappings=[("image", "camera/image_raw")],
                output="screen",
            ),
        ]
    )
```

Use lifecycle state transitions or a real readiness signal for dependencies. `TimerAction` is a scheduling delay, not evidence that another node is ready.
