<!-- AUTO-GENERATED from README.ja.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# kairos

**日本語版: [README.ja.md](README.ja.md)**

A system for **recording, monitoring, validating, and converting robot data** from ROS 2.
The authoritative recording format is **MCAP**; every other stream (live video, live metrics,
post-hoc validation) is built around that record.

> **Status:** greenfield, pre-design. The architecture below is transcribed from the diagrams in
> `fig_const/`; no implementation, repository structure, or tooling has been decided yet.

## Architecture

```
                ROS 2 Robot / Sim  ──►  ROS 2 Topics
                                          │
        ┌──────────────┬──────────────────┼──────────────────────────┐
        ▼              ▼                   ▼                          ▼
  webrtc_streamer  topic_monitor    rosbag2_recorder            (selected topics)
   (live preview)  (live metrics)   ──► MCAP  /data/recorded/run_xxxx.mcap  ◄── source of truth
        │              │                   │
        ▼              ▼                   ▼  (after recording)
     Browser  ◄──  api_orchestrator  ──►  dora_runner ──► reports / converted datasets
                  (job & state hub)        (validate / convert pipeline)
                         ▲
                         │ REST / WebSocket / SSE
                      frontend (Vite + React + TS)
```

## Services

| Service | Role |
|---|---|
| [rosbag2_recorder](docs/specs/en/rosbag2_recorder.md) | Records selected ROS 2 topics to **MCAP** — the single source of truth. |
| [topic_monitor](docs/specs/en/topic_monitor.md) | Lightweight, non-destructive live health metrics (Hz, late, gap, loss, bandwidth). Does **not** decode payloads. |
| [webrtc_streamer](docs/specs/en/webrtc_streamer.md) | Low-latency camera **preview** (ROS 2 image → browser). Not a recording path. |
| [api_orchestrator](docs/specs/en/api_orchestrator.md) | The single API hub: job lifecycle, state, settings, result aggregation. |
| [dora_runner](docs/specs/en/dora_runner.md) | Post-record **validation / conversion** pipeline (built on dora). |
| [frontend](docs/specs/en/frontend.md) | Backend-driven web UI: record control, live video, topic health, run/validation/dataset views. |

## Specification docs

See [docs/specs/en/](docs/specs/en/README.md) for the detailed per-service specs — the
**canonical design** based on the `fig_const/` diagrams (unspecified items fixed as recommended designs; no authentication).

## Getting started

> Repository layout, tooling, and build/run instructions are not decided yet. They will be added
> as the design is settled and each service lands.

## Documentation language rule

**Japanese is the source of truth.** Edit the Japanese files (`*.ja.md`); the English files
(`*.md`) are regenerated with the `/sync-docs` skill. Do not edit the English files by hand.

## Contributing

- Code, comments, and commit messages are in English.
- See [CLAUDE.md](CLAUDE.md) for the working agreement and conventions.
