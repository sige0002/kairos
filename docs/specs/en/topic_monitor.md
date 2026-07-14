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
- alert definitions (a list of `{ topic, metric, op, threshold }`, including `cooldown_s` / `clear_after_s` / `severity`)
  - **Alerts are per-incident** (key = `(topic, metric)`): while firing, it is held with its current value updated in place, and on clearing a `cleared` is explicitly emitted (retained ~60s for reliable delivery). The UI collapses 1 incident = 1 row.
  - **Auto-derived rules (derived)**: a topic that has an `expected_hz` and no config rule watching its hz auto-gets **exactly one** hz incident synthesized from the measured shortfall — WARNING once `hz < 0.8×expected` is sustained, escalating to DANGER once `hz < 0.5×expected`. Ratios and hysteresis are overridable via the optional `derived_rules:` block in alerts.yaml (`enabled` / `warn_ratio` / `danger_ratio` / `sustain_s` / `clear_after_s` / `cooldown_s`; defaults enabled · 0.8 · 0.5 · 10s · 3s · 10s).
  - **Default DANGER rule (default)**: even for a topic with **no** `expected_hz` (i.e. judged against a learned baseline), if the monitor's own `danger` classification persists ~10 seconds, a default incident fires — so the table's DANGER and Events do not contradict.
  - **Precedence (a topic's hz is owned by exactly one mechanism; no double incident)**: config rule > derived rule > default synthesizer. A config `(topic, hz)` rule overrides derived / default, and a derived rule overrides the default.
  - **Provenance**: every incident carries its origin `rule_origin` (`config` / `derived` / `default`) and `severity` (`warning` / `danger`), surfaced in the `/alerts` / SSE / `/incidents` payloads (so the UI can show where it came from).
  - **Incident history**: each fire→clear episode is retained in a bounded ring buffer (last 500). It outlives the live 60s post-clear retention so a consumer can settle, via `GET /incidents?since_ns=`, "which incidents fired/cleared within a recording window" after the fact.

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
- **Jitter**: `interarrival_p50_ms` / `interarrival_p95_ms` from monotonic receive-time gaps. A decode-free "choppiness" signal (p95 / max gap precede a stall).
- **Loss**: hard to generalize in ROS 2, so `null` by default (computed only for special types where seq is available). True loss is not reported (no seq; DDS sample-lost is the monitor's own subscription drop, not the publisher's/rosbag's).
- **DDS sample-lost**: `dds_samples_lost` (cumulative count from the rmw `message_lost` event). The **only honest "samples actually dropped" count available without sequence numbers** — decode-free, non-destructive. Surfaced as distinct from `rate_shortfall` (observed deficit).
- **Message count**: `messages_total` (**cumulative** received count since subscribe; never evicted by the window). A two-point start/stop delta gives the whole recording window's average rate.
- **Observed shortfall**: `rate_shortfall` (= `max(0, 1 - count / (expected_hz × window))`) and `deficit_per_s` (= `max(0, expected_hz - hz)`). This is **not** true loss but observed shortfall vs the static `expected_hz` (it folds together the monitor's own best_effort drops, executor lag, and a stopped publisher — same condition as a naive count ratio). Named so it never reads as `rosbag loss`. `null` without `expected_hz`.
- **Status**: coarse per-topic health `status` + `status_reason`, with precedence `inactive > danger > warning > ok > unknown`. `inactive` = no messages (silent); `unknown` = no `expected_hz` to judge against; `danger`/`warning` = `rate_shortfall` crossed the threshold (default 5% / 2%); otherwise `ok`. Low-expected-rate topics (expected below `min_status_count` per window) are judged by an absolute message deficit rather than a percentage, to avoid false alarms; a **time hysteresis** (default escalate 2s / recover 1s) keeps one bad tick from turning a row red. Thresholds and hysteresis are configurable in the `RECORDING_CONFIG` monitor block. Derived from observed shortfall, not a true-loss verdict.
- For topics with no `expected_hz` set, only Hz / Bandwidth / Gap. Late / shortfall are `null` + reason, and `status` is `unknown` (or `inactive` when there are no messages).

## API

- `GET /topics` — ROS 2 graph discovery (`name` / `type` / `publisher_count` / `subscriber_count` / `qos` / `last_seen`). The information source for `api_orchestrator`'s `GET /api/v1/topics`.
- `GET /metrics` — periodic snapshot (all topics).
- `GET /metrics/stream` — SSE. Delivers **a periodic snapshot rather than topic diffs** (simpler for the UI).
- `POST /metrics/pause` / `POST /metrics/resume` — pause / resume monitoring (to reduce load, e.g. during recording).
- `GET /alerts` / `GET /alerts/stream` — currently-firing / recently-cleared incidents (including `rule_origin` / `severity`).
- `GET /incidents?since_ns=<int>` — incident history (bounded ring, last 500). Returns episodes whose `fired_at_ns` **or** `cleared_at_ns` is `>= since_ns` (omit `since_ns` = all). The source `api_orchestrator` uses at recording stop to settle "what fired during that window". Timestamps are wall-clock UNIX nanoseconds.
- `GET /healthz` / `GET /readyz`
- The common API conventions (error format / types / time) follow [config](config.md).

## Output schema (example, WebSocket / SSE / JSON)

```json
// GET /metrics (and each tick of /metrics/stream)
{
  "ts": "2026-06-24T01:23:45.123Z",
  "window_s": 5,
  "topics": [
    { "name": "/cam/image_raw", "type": "sensor_msgs/msg/Image",
      "hz": 29.8, "bandwidth_bps": 51200000, "gap_max_ms": 80,
      "inter_arrival_late_ratio": 0.01, "stamp_delay_ms": 12,
      "interarrival_p50_ms": 33, "interarrival_p95_ms": 41,
      "messages_total": 8940, "loss_rate": null, "dds_samples_lost": 0,
      "rate_shortfall": 0.007, "deficit_per_s": 0.2,
      "status": "ok", "status_reason": null, "sensor_preview": null }
  ],
  "alerts": [
    { "topic": "/cam/image_raw", "metric": "hz", "op": "lt", "threshold": 15.0,
      "value": 9.2, "state": "firing", "since": "2026-06-24T01:23:40.000Z",
      "rule_origin": "derived", "severity": "danger" }
  ]
}
```

```json
// GET /incidents?since_ns=<int> — fire→clear history episodes
{
  "incidents": [
    { "id": "/cam/image_raw|hz|7",
      "topic": "/cam/image_raw", "metric": "hz",
      "severity": "danger", "rule_origin": "derived",
      "fired_at_ns": 1750000000000000000, "cleared_at_ns": null,
      "message": "/cam/image_raw hz < 15 (value=9.2)" }
  ]
}
```

## Design points / non-functional

- Prioritize non-destructiveness and lightness above all. Load is bounded by the **allowlist** (explicitly enumerating monitored topics) rather than bulk-subscribing to all topics. Limits via `max_topics` / `max_bytes` are reserved for the future (currently unimplemented).
- Metrics are aggregated by `api_orchestrator` and relayed to the frontend ([api_orchestrator](api_orchestrator.md)).
- Shared configuration is in [config](config.md).
