<!-- AUTO-GENERATED from config/README.ja.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# config — recording / monitoring config (RECORDING_CONFIG)

**日本語: [README.ja.md](README.ja.md)**

The folder that holds the YAML deciding **which topics to record / monitor**. It is the config entry
point for recording / monitoring.

| File | Role |
|---|---|
| [`recording.yaml`](recording.yaml) | **Generic template (copy from here).** A starting point for a new robot, with `default_topics` / `expected_hz_patterns` / QoS / `validation`. |
| [`airoa_hsr.yaml`](airoa_hsr.yaml) | **Concrete config** matching the bundled sample bag (HSR, `data/airoa-moma-mcap/`). For Stage 1–2 local verification. |

## Usage

Point the **`RECORDING_CONFIG` environment variable** at one file.

```bash
# To use the sample bag (HSR), e.g. in .env
RECORDING_CONFIG=config/airoa_hsr.yaml
```

- Under Docker, `config/` is mounted into each service at `/config` (`compose.yaml`). The default is
  `/config/recording.yaml`. When replaying the sample bag, switch to
  `RECORDING_CONFIG=/config/airoa_hsr.yaml` (the template's `default_topics` are `/joint_states`
  etc., which do not match the HSR `/hsrb/*` topics, so as-is the monitor subscribes to nothing and
  `GET /metrics` is empty).
- **A new robot**: copy `recording.yaml`, edit the topic names / expected Hz / QoS, and point
  `RECORDING_CONFIG` at that file.

## Who consumes it (this one file is shared)

- `rosbag2_recorder` … `default_topics` (default record targets) + recording QoS.
- `topic_monitor` … `expected_hz_patterns` (Late judgement) + subscribe QoS.
- `dora_runner` … `validation.required_topics` (post-record fast_validation).
- `frontend` (UI) … via `GET /api/v1/config`'s `defaults.default_topics`, the Record tab
  **pre-selects the topics to record** and the Monitor tab shows a **configured badge**.

Topics support globs (fnmatch); pattern lists are first-match-wins. See each YAML's comments and
[`docs/specs/en/config.md`](../docs/specs/en/config.md) for details.
