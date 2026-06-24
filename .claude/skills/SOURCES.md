# Installed third-party skills — provenance & review

Vetted (every `SKILL.md` reviewed; **no `scripts/` present** in any) and installed from:

- Source: https://github.com/arpitg1304/robotics-agent-skills (Apache-2.0, ~289★)
- Reviewed: 2026-06-24. Security scan: markdown-only, no executable code; content is robotics best-practice reference. `install.sh` (benign copy script) was reviewed but NOT run — skills copied manually.

Installed (high relevance to kairos):
- `ros2-development`            (repo `skills/ros2`)            — rclpy/rclcpp, QoS, DDS, colcon, components
- `ros2-web-integration`        (repo `skills/ros2-web-integration`) — FastAPI+rclpy bridge, WebSocket/SSE/MJPEG/WebRTC, CORS
- `docker-ros2-development`     (repo `skills/docker-ros2-development`) — multi-stage Dockerfiles, compose, cross-container DDS, GPU
- `robotics-testing`            (repo `skills/robotics-testing`) — pytest, launch_testing, mock HW, golden-file, deterministic
- `robotics-software-principles`(repo `skills/robotics-software-principles`) — SOLID, plugin arch, config-over-code

Reviewed but NOT installed (off-scope for this data pipeline): `ros1`, `robot-perception`, `robotics-design-patterns`, `robotics-security`, `robot-bringup`.
Not installed (marketplace-only — scripts unverifiable, or redundant with built-in /code-review): skills.rest `ros2-skill`, `awesome-skills/code-review-skill`, `harunkurtdev/ros2-claude-code-template` (no license).

Apache-2.0 applies; see the source repo's LICENSE.
