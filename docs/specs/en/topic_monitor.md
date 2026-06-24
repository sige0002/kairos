<!-- AUTO-GENERATED from docs/specs/ja/topic_monitor.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# topic_monitor Specification

> Status: design finalized (v1). Based on `fig_const/topicmonitor.png`, with unspecified items finalized as the recommended design. Japanese is the source of truth (it takes precedence). The English version `docs/specs/en/topic_monitor.md` is an auto-generated mirror (do not edit it directly). **No authentication required.**

A container for **lightweight, non-destructive real-time monitoring** of ROS 2 topics. **In principle it does not decode payloads** (only header / serialized size / arrival time). It does no heavy decoding or video generation (those belong to `dora_runner` / `webrtc_streamer`).

## Role

- Subscribes to monitored topics lightly and publishes Hz / Late / Gap / Loss / Bandwidth / Sensor preview.
- Provides ROS 2 graph discovery (topic list / QoS) and serves as the topic information source for `api_orchestrator`.

## Input

- Monitored topics (**allowlist**; consistent with `default_topics` in `RECORDING_CONFIG`)
- Per-topic `expected_hz` (`RECORDING_CONFIG`, optional)
- alert definitions (a list of `{ topic, metric, op, threshold }`, including `cooldown_s` / `clear_after_s`)

## Components

- **ROS2 Subscribers** — subscribe in the monitoring thread of an rclpy node. Subscribe to **the allowlist only** (no bulk subscription to all topics).
- **Window Stats** — aggregate over a sliding window (default `1s` / `5s`, configurable).
- **Alert Rules** — threshold evaluation. Hysteresis (`cooldown_s`, `clear_after_s`).
- **Sensor Preview** — **decode allowlist (disabled by default).** Lightweight decoding only for small, fixed types enabled in the UI (`std_msgs/*` numeric, `sensor_msgs/Imu` / `NavSatFix` / `BatteryState`, etc.).
- **Metrics Publisher** — publish via SSE / JSON.

## Automatic QoS matching

- Use `get_publishers_info_by_topic()` to obtain each publisher's offered QoS and generate the subscription (to prevent drops).
- When QoS differs across multiple publishers, lean toward the compatible side: if any is `best_effort`, use `best_effort`; `durability` is `volatile`; `depth` is small (`keep_last`).
- `topic_qos_overrides` in `RECORDING_CONFIG` (pattern matching) has **highest priority**. The fallback when retrieval is not possible is `best_effort` / `keep_last`.

## Metric definitions

- **Hz**: number of messages in the window / second.
- **Bandwidth**: serialized bytes / second.
- **Gap**: maximum receive interval, and the number of times a threshold is exceeded.
- **Late**: split into two kinds — `inter_arrival_late_ratio` (the fraction exceeding the expected period derived from `expected_hz`), `stamp_delay_ms` (only when `header.stamp` can be obtained safely).
- **Loss**: hard to generalize in ROS 2, so `null` by default (computed only for special types where seq is available).
- For topics with no `expected_hz` set, only Hz / Bandwidth / Gap. Late / Loss are `null` + reason.

## API

- `GET /topics` — ROS 2 graph discovery (`name` / `type` / `publisher_count` / `subscriber_count` / `qos` / `last_seen`). The information source for `api_orchestrator`'s `GET /api/v1/topics`.
- `GET /metrics` — periodic snapshot (all topics).
- `GET /metrics/stream` — SSE. Delivers **a periodic snapshot rather than topic diffs** (simpler for the UI).
- `POST /metrics/pause` / `POST /metrics/resume` — pause / resume monitoring (to reduce load, e.g. during recording; equivalent to the pause/resume of `../rosbag-view`).
- `GET /alerts` / `GET /alerts/stream`
- `GET /healthz` / `GET /readyz`
- The common API conventions (error format / types / time) follow [config](config.md).

## Output schema (example, WebSocket / SSE / JSON)

```json
{
  "ts": "2026-06-24T01:23:45.123Z",
  "window_s": 5,
  "topics": [
    { "name": "/cam/image_raw", "type": "sensor_msgs/msg/Image",
      "hz": 29.8, "bandwidth_bps": 51200000, "gap_max_ms": 80,
      "inter_arrival_late_ratio": 0.01, "stamp_delay_ms": 12, "loss_rate": null,
      "sensor_preview": null }
  ],
  "alerts": []
}
```

## Design points / non-functional

- Prioritize non-destructiveness and lightness above all. Set load caps with `max_topics` / `max_bytes` (to prevent load spikes from subscribing to all topics).
- Metrics are aggregated by `api_orchestrator` and relayed to the frontend ([api_orchestrator](api_orchestrator.md)).
- Shared configuration is in [config](config.md).
