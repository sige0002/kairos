<!-- AUTO-GENERATED from docs/specs/ja/topic_probe.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# topic_probe specification

> Status: design fixed (v1). Specified after the fact from the frontend OL-3.3 (generic field plotter) that was implemented first; unspecified items fixed as the recommended design. Japanese is canonical (the source of truth). The English version `docs/specs/en/topic_probe.md` is an auto-generated mirror (do not edit it by hand). **No authentication.**

A generic plotter container that **plots numeric fields of ROS 2 topics live**. In contrast to `topic_monitor`, which **does not decode the payload**, topic_probe **decodes the selected topic**. Isolating the decode in a dedicated container guarantees its load does not spill over into `rosbag2_recorder` / `topic_monitor` (i.e. recording frequency / monitoring).

Robot-independent by construction: topics come from whatever is actually on the ROS 2 graph, and fields are introspected from the live message type (robot-specific topic / field names are **not hardcoded**).

## Role

- Lightly subscribe to & decode the selected topic, and stream time-series samples of the requested numeric fields.
- Provide topic discovery and **numeric-field introspection** per topic type.

## Inputs

- Topics to plot (selected from ROS 2 graph discovery; there is no allowlist constraint — any topic on the graph can be targeted).
- Numeric field paths per topic (selected from the introspection result; arrays are expanded, below).
- Sample rate Hz (default 10, **selectable per panel**; capped server-side).

## Components

- **ROS2 Subscribers** — subscribe via an rclpy node and decode each message. **Multiple topics can be subscribed concurrently** (see "Concurrent subscription model").
- **Field Introspection** — walk the numeric leaves of a decoded message and enumerate dotted paths. Fixed-size numeric arrays are **index-expanded** as `position[0]`–`position[N]` so the UI can pick them as individual series.
- **Sampler** — per stream connection, at the requested Hz, extract the target field values from the latest decoded message (throttled).
- **Sample Publisher** — delivered over SSE.

## Concurrent subscription model / cost policy

- **Ref-counted subscriptions**: subscribe to a topic that has stream connections, and **unsubscribe when the last connection** using it closes. Multiple connections to the same topic (multiple fields / panels) collapse to a single subscription and share the decode of one message.
- **Cross-topic overlay allowed**: to overlay series from different topics (e.g. left arm / right arm) on one chart, multiple topics can be subscribed & decoded **concurrently** (the old v0 "only one active topic at a time" constraint is removed).
- **No hard cap, warning only**: decode cost grows with `concurrent topics × Hz`. There is **no hard cap**; once a guideline (default 6 topics) is exceeded the UI shows a **warning** (it does not reject the addition). Overlaying many heavy topics can make the probe container itself sluggish, but it **does not spill over into recording / monitoring** (isolation; see "Design points"). Only the preview's responsiveness degrades.

## API

> The probe endpoints live under the reverse proxy at **`/probe/`**, **not** under the orchestrator's `/api/v1` (the frontend's nginx / Vite dev server proxy directly to the topic_probe container).

- `GET /probe/topics` — ROS 2 graph discovery (`name` / `type`).
- `GET /probe/fields?topic=<name>` — list of numeric field paths for that topic type (live introspection). Arrays are index-expanded. Returns an empty list + `reason` when no message has been received / there are no numeric fields.
- `GET /probe/stream?topic=<name>&fields=<a,b,c>&hz=<n>` — SSE sample stream. **One connection carries multiple fields of one topic** as multi-valued samples (the old v0 single `field` is extended to `fields`; a single field is the special case). `hz` is clamped to the server-side max.
- `GET /healthz` / `GET /readyz`
- `/readyz` is ready only after the rclpy node and executor thread start successfully. A partial initialization failure releases every resource and remains retryable; readiness also drops after the thread dies.
- Common API conventions (error format / types / time) follow [config](config.md).

## Output schema (example, SSE / JSON)

```json
{
  "topic": "/right_arm/joint_states",
  "t": 1719446625.123,
  "values": {
    "position[0]": 0.12,
    "position[1]": -0.04,
    "velocity[0]": 0.0
  }
}
```

- A field with no message received yet is `null` (so the stream emits keep-alive samples right after connecting).

## Design points / non-functional

- **Isolation first.** topic_probe is its own container (1 folder = 1 image), a separate process from `rosbag2_recorder` / `topic_monitor`. Subscriptions are best_effort and the monitor does not decode. No matter how many topics probe decodes, it **does not spill over into recording frequency / monitoring metrics** (same reasoning as [topic_monitor](topic_monitor.md)'s non-intrusive policy). Only the probe container's own CPU grows.
- The cap is not hard, **warning only** (favoring free overlaying in the field). Degradation is confined to preview responsiveness; recorded data is untouched.
- Concrete values such as the array-expansion count and the stream Hz cap are adjustable as implementation-side guard parameters (TBD).
- Frontend consumption (integration into the Live Scope, add-style panels, overlay, REC/STOP markers) is described in [frontend](frontend.md).
- Shared config is [config](config.md).
