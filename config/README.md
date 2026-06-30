<!-- AUTO-GENERATED from config/README.ja.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# config — per-robot recording / monitoring / validation config

**日本語: [README.ja.md](README.ja.md)**

A folder for the YAML that decides **which topics to record / monitor** (and more),
organized **per robot**. The entry point for recording / monitoring / validation config.

## Layout (robot-first)

```
config/
├─ <robot>/                  # one folder per robot (committed)
│  ├─ recording/<option>.yaml     # recording/monitoring (default.yaml is active)
│  ├─ stream/<option>.yaml        # Stream tab initial layout
│  ├─ validation/<option>.yaml    # fast_validation template
│  └─ validators/loss_report.yaml # validator parameters
├─ airoa_hsr/               # bundled sample robot (HSR, data/airoa-moma-mcap/)
├─ template/                # starting point for a new robot (copy of airoa_hsr)
└─ local/<robot>/           # your own robots (gitignored)
```

Each aspect can hold multiple options (`*.yaml`); `default.yaml` is the active one.

## Usage (a single ROBOT switches everything)

```bash
make up ROBOT=airoa_hsr      # bundled HSR sample (default)
make up ROBOT=<robot>        # config/local/<robot>/ (gitignored, your own robot)
```

- Choosing `ROBOT` switches recording / stream / validation / validators **together**.
  The Makefile resolves `config/<robot>/` (committed) vs `config/local/<robot>/`
  (gitignored) and passes the paths to each service (`docker compose` honors `ROBOT`
  too, via nested interpolation).
- The **Config tab** also lets you select / edit robot → aspect → option
  (`GET /api/v1/config/options` · `POST /api/v1/config/select`). Local robots
  (gitignored) appear in the list too, and editing their recording config writes
  back to the gitignored file (never a committed one).
- **A new robot**: copy `config/template/` into `config/<robot>/` (publishable) or
  `config/local/<robot>/` (private), then edit topic names / expected Hz / QoS.

> ⚠️ If your `.env` sets `RECORDING_CONFIG=...` directly it overrides the `ROBOT`-derived
> path. Normally set only `ROBOT=` and drop the explicit path lines (`.env.example`
> shows the new shape).

## Where it applies

- `rosbag2_recorder` … recording `default_topics` (default capture set) + recording QoS.
- `topic_monitor` … recording `expected_hz_patterns` (Late judgement) + subscription QoS.
- `dora_runner` … validation `required_topics` (fast_validation) + validators (loss_report).
- `frontend` (UI) … via `GET /api/v1/config`: Record/Monitor pre-selection + badges, Stream initial panes.

Topics support globs (fnmatch), first-match-wins. See each YAML's comments and
[`docs/specs/en/config.md`](../docs/specs/en/config.md), `config/local/README.md` for details.
