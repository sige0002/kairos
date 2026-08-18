# Hardware and GUI passthrough

## Contents

- NVIDIA GPU
- Cameras and serial devices
- Stable device naming and hot-plug
- X11, Wayland, and headless rendering
- Verification and security

## NVIDIA GPU

Require a working host driver and NVIDIA Container Toolkit before changing Compose. Verify the host first:

```bash
nvidia-smi
docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi
```

Use Compose device reservations:

```yaml
services:
  perception:
    image: my-perception:release
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    environment:
      NVIDIA_DRIVER_CAPABILITIES: compute,utility,video
```

Use either `count` or `device_ids`, not both. Add `video` only for codec/video APIs that need it. Do not set `NVIDIA_VISIBLE_DEVICES=all` when a narrower reservation is intended.

Choose a CUDA base compatible with the host driver and the ML framework. Install a ROS distribution only on a supported Ubuntu base; do not force Jazzy packages into Jammy or Humble packages into Noble without a documented source-build strategy.

Use a GPU runtime base only when runtime libraries are required. Keep CUDA compilers and headers in a build stage.

## Cameras and serial devices

Pass explicit device nodes and groups:

```yaml
services:
  camera:
    devices:
      - /dev/robot/front_camera:/dev/video0
    group_add:
      - video

  motor_driver:
    devices:
      - /dev/robot/motor:/dev/ttyMOTOR
    group_add:
      - dialout
```

Confirm permissions numerically because group names/IDs may differ between host and image:

```bash
stat -c '%n %a %u %g' /dev/video0 /dev/ttyUSB0
getent group video
getent group dialout
```

Avoid committing site-specific vendor/product/serial IDs unless they are intentionally public fixtures. Store machine-specific udev rules in deployment-local configuration when required.

## Stable device naming and hot-plug

Create stable symlinks with host udev rules:

```udev
SUBSYSTEM=="tty", ATTRS{serial}=="SERIAL_PLACEHOLDER", SYMLINK+="robot/motor"
SUBSYSTEM=="video4linux", ATTRS{serial}=="SERIAL_PLACEHOLDER", SYMLINK+="robot/front_camera"
```

Reload and verify on the host:

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
udevadm info --query=all --name=/dev/video0
```

Static `devices:` mappings are resolved when the container starts. For hot-plug, prefer restarting the affected driver container after udev settles. Use a broader `/dev` mount plus `device_cgroup_rules` only when restart is unacceptable and the security boundary permits it.

Example narrow cgroup rules:

```yaml
device_cgroup_rules:
  - 'c 188:* rmw'  # common USB serial major
  - 'c 81:* rmw'   # video4linux
volumes:
  - /dev:/dev
```

Verify actual major numbers on the deployment host; do not assume they are universal.

## X11

Prefer development-only profiles for GUI tools:

```yaml
services:
  rviz:
    profiles: [dev]
    image: my-ros-dev:local
    environment:
      DISPLAY: ${DISPLAY}
      QT_X11_NO_MITSHM: '1'
    volumes:
      - /tmp/.X11-unix:/tmp/.X11-unix:rw
```

Avoid `xhost +`. If access control must be adjusted, grant only the container user and revoke it after use. Prefer an Xauthority cookie when the environment supports it.

Do not interpolate `${HOME}` in shared Compose examples without confirming it resolves on every operator machine. Pass an explicit host path or repository variable.

## Wayland

Pass only the active Wayland socket and matching UID runtime directory:

```yaml
services:
  rviz:
    profiles: [dev]
    user: "${UID}:${GID}"
    environment:
      WAYLAND_DISPLAY: ${WAYLAND_DISPLAY:-wayland-0}
      XDG_RUNTIME_DIR: /run/user/${UID}
      QT_QPA_PLATFORM: wayland
    volumes:
      - ${XDG_RUNTIME_DIR}/${WAYLAND_DISPLAY}:/run/user/${UID}/${WAYLAND_DISPLAY}:rw
```

Confirm the image includes the Qt Wayland plugin. Do not hardcode UID 1000.

## Headless rendering

Use the repository's browser/GUI test harness when present. Otherwise run Xvfb or a compositor as a supervised process and ensure failures propagate:

```bash
xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24' \
  ros2 run rviz2 rviz2 -d /config/test.rviz
```

Install headless test dependencies in a test stage, not dynamically at container startup.

## Verification and security

- Confirm the container user can open the device without `privileged`.
- Confirm only the intended GPU/device is visible.
- Exercise unplug/replug and container restart where field replacement matters.
- Confirm GUI sockets are absent from deployment profiles.
- Treat `/dev`, X11, Wayland, GPU, host PID, and `privileged` access as host-attack surfaces.
- Document why every broad capability is required and test a narrower alternative.

## Primary sources

- https://docs.docker.com/compose/how-tos/gpu-support/
- https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
- https://docs.docker.com/engine/containers/run/#runtime-privilege-and-linux-capabilities
