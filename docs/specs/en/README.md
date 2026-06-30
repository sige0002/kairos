<!-- AUTO-GENERATED from docs/specs/ja/README.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# Specification docs (Japanese, source of truth)

Per-service specs. Based on each diagram in `fig_const/`, with unspecified items finalized as recommended design — the **source of truth for the design** (treat it as canonical). **Japanese is the source of truth**; the English version is [`docs/specs/en/`](../ja/README.md) (an auto-generated mirror produced by the `/sync-docs` skill). **No authentication is required.**

| Document | Role |
|---|---|
| [config](config.md) | Shared configuration (externalization of `ROS_DOMAIN_ID` / ports / paths, etc., and runtime configuration) |
| [deployment_topology](deployment_topology.md) | Deployment topology (placement topology). A split deployment that records from a separate PC without overloading the robot |
| [rosbag2_recorder](rosbag2_recorder.md) | ROS 2 topics → MCAP recording (canonical). QoS selection / image support |
| [topic_monitor](topic_monitor.md) | Lightweight real-time monitoring (Hz / Late / Gap / Loss / bandwidth) |
| [topic_probe](topic_probe.md) | Live plotting of numeric fields (decode isolated; cross-topic overlay) |
| [webrtc_streamer](webrtc_streamer.md) | Low-latency streaming of camera video (preview) |
| [api_orchestrator](api_orchestrator.md) | Job management / state management / API hub (single entry point `/api/v1`) |
| [dora_runner](dora_runner.md) | Post-recording validation, conversion, and AI processing (dora extension, stage3. Validation v1 = required topics + template) |
| [frontend](frontend.md) | Tabbed Web UI (backend-driven, recomposable) |
