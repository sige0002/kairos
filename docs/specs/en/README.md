<!-- AUTO-GENERATED from docs/specs/ja/README.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# Specification docs (Japanese, source of truth)

Per-service specs. Based on each diagram in `fig_const/`, with unspecified items finalized as recommended design — the **source of truth for the design** (treat it as canonical). **Japanese is the source of truth**; the English version `docs/specs/en/README.md` is an auto-generated mirror produced by `/sync-docs` (do not edit it directly). **No authentication is required.**

| Document | Role |
|---|---|
| [config](config.md) | Shared configuration (externalization of `ROS_DOMAIN_ID` / ports / paths, etc., and runtime configuration) |
| [capture_store](capture_store.md) | Identity, placement, and durability of recorded data (`objects/<capture_id>` / sidecars / deletion / rebuild). The cross-service foundation |
| [deployment_topology](deployment_topology.md) | Deployment topology (placement topology). A split deployment that records from a separate PC without overloading the robot |
| [rosbag2_recorder](rosbag2_recorder.md) | ROS 2 topics → MCAP recording (canonical). QoS selection / image support |
| [topic_monitor](topic_monitor.md) | Lightweight real-time monitoring (Hz / Late / Gap / Loss / bandwidth) |
| [topic_probe](topic_probe.md) | Live plotting of numeric fields (decode isolated; cross-topic overlay) |
| [webrtc_streamer](webrtc_streamer.md) | Low-latency streaming of camera video (preview) |
| [api_orchestrator](api_orchestrator.md) | Job management / state management / API hub (single entry point `/api/v1`) |
| [dora_runner](dora_runner.md) | Built-in post-recording validation, job management, dedicated dora execution, and extensions |
| [dora_plugins](dora_plugins.md) | Required work for custom plugin authors and integrators, Python/OS dependencies, GPU, I/O, and execution checks |
| [frontend](frontend.md) | Role-tab Web UI (Console v2: Collect / Review / Datasets / Validation / Monitor / Settings) |

For the overall setup, start with the [root README](../../../README.md); for adding plugins, see the [user procedure](../../../services/dora_runner/plugins/README.md); for changing built-in checks, start with the [dora development guide](../../dora/README.md).
