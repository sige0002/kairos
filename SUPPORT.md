<!-- AUTO-GENERATED from SUPPORT.ja.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->
# Support

kairos is alpha software. Maintenance is best effort; no response-time or long-term-support period is promised.
Do not put secrets, including confidential security reports, in a public issue.

Include the following in a bug report:

- `VERSION`, `git rev-parse HEAD`, and whether the worktree is dirty
- host OS, CPU architecture, Docker Engine, and Compose versions
- `ROS_DISTRO`, `RMW_IMPLEMENTATION`, `ROS_DOMAIN_ID`, and single-host or split topology
- reproduction steps, expected result, actual result, and minimal non-secret configuration
- `make smoke`, `docker compose ... ps`, and recent logs for the affected service
- for suspected data corruption, confirmation that writes stopped and sidecars plus `lifecycle.jsonl` were preserved

Support covers the documented default environment and current release. Unverified platforms, custom message
overlays, site-provided plugins/converters, and robot-specific networks are handled best effort only when a
reproducible minimal example is available.
