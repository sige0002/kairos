# Installed third-party skills — provenance & review

Vetted (every `SKILL.md` reviewed; **no `scripts/` present** in any) and installed from:

- Source: https://github.com/arpitg1304/robotics-agent-skills (Apache-2.0, ~289★)
- Reviewed: 2026-08-18. Security scan: no executable code in these imported
  skills; content is robotics best-practice reference. `install.sh` (benign copy
  script) was reviewed but NOT run — skills were copied manually. The local
  copies are adapted for current ROS 2/Docker APIs and kairos defaults; detailed
  examples live under each skill's `references/` directory.

Installed (high relevance to kairos):
- `ros2-development`            (repo `skills/ros2`)            — rclpy/rclcpp, QoS, DDS, colcon, components
- `ros2-web-integration`        (repo `skills/ros2-web-integration`) — FastAPI+rclpy bridge, WebSocket/SSE/MJPEG/WebRTC, CORS
- `docker-ros2-development`     (repo `skills/docker-ros2-development`) — multi-stage Dockerfiles, compose, cross-container DDS, GPU
- `robotics-testing`            (repo `skills/robotics-testing`) — pytest, launch_testing, mock HW, golden-file, deterministic
- `robotics-software-principles`(repo `skills/robotics-software-principles`) — SOLID, plugin arch, config-over-code

Reviewed but NOT installed (off-scope for this data pipeline): `ros1`, `robot-perception`, `robotics-design-patterns`, `robotics-security`, `robot-bringup`.
Not installed (marketplace-only — scripts unverifiable, or redundant with built-in /code-review): skills.rest `ros2-skill`, `awesome-skills/code-review-skill`, `harunkurtdev/ros2-claude-code-template` (no license).

Apache-2.0 applies; see the source repo's LICENSE.

## Local-only installation

`ui-ux-pro-max` is installed by `uipro init` into gitignored paths. It is not a
repository-managed dependency, is excluded from the tracked skill acceptance
gate, and must not be assumed present by project instructions. Its source and
update lifecycle remain the responsibility of the local installation.

---

# Authored in-house

- `dora-rs` — NOT copied from a third-party pack. Authored 2026-07-07 against verified current sources
  (github.com/dora-rs/dora `main`: README/CLAUDE.md/AGENTS.md/docs/examples, the shipped
  `dora/__init__.pyi`, PyPI/crates.io release metadata) plus kairos's own `services/dora_runner`
  plugin contract (`plugin_loader.py`, `plugins/README.md`, `docs/specs/ja/dora_plugins.md`). The
  community `ZhangHanDong/dora-skills` (mirrored at `dora-rs/dora-skills`, MIT/Apache) was reviewed as
  prior art but is stale (~2026-01, pre-1.0 CLI, no Node Hub / adora→dora) and was NOT copied. Markdown
  only, no `scripts/`.
