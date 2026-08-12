# deploy/lerobot — the LeRobot converter (optional feature)

`lerobot_exporter` (capture_store §6.2) converts a dataset to a LeRobot v3
dataset by running **rosbag2lerobot** as a subprocess. That converter's source
tree is **site-provided and gitignored**, not vendored as a submodule — so a
kairos update never resets it, and a company fork with its own commits can live
here untouched.

## Layout

```
deploy/lerobot/
├─ README.md          # tracked (this file)
└─ converter/         # gitignored — the rosbag2lerobot source tree you provide
   ├─ pyproject.toml  #   must be pip-installable, exposing the `rosbag2lerobot`
   └─ src/…           #   console script (the exporter Dockerfile pip-installs it)
```

## Setting it up

The exporter is opt-in: it only exists when `LEROBOT_EXPORTER=1` is set (in
`.env`, or `.env.split` for the recording/robot split). A site that never
enables it needs nothing here.

To use the feature, put a pip-installable rosbag2lerobot tree at
`deploy/lerobot/converter/`:

```bash
# Standard / upstream:
git clone https://github.com/sige0002/rosbag2lerobot deploy/lerobot/converter

# A company fork with its own customizations — just point at your own repo.
# It is an ordinary git checkout you manage independently of kairos; kairos
# never touches it.
git clone <your-fork-url> deploy/lerobot/converter
```

Then build and start:

```bash
make build lerobot-exporter
make up            # appends compose/lerobot.yaml because LEROBOT_EXPORTER is set
```

`make build` checks this directory exists and prints these instructions if it
does not — it is no longer a submodule, so nothing populates it automatically.

## The contract (what the converter must satisfy)

The exporter depends only on the CLI + progress-file contract, never on the
converter's internals — that is what lets you swap in a fork freely:

- **CLI** (`services/lerobot_exporter/src/lerobot_exporter/registry.py`):
  `convert --config <profile> --bags <staging> --output <dir> --json
  --manifest-extra <json> --workers <n> --no-gpu` (plus `--task <t>` when some
  episode has no label).
- **Progress files** written under `<output>/meta/`: `progress.json`
  (`episode_index`, `episode_total`, `messages_done`, `messages_total`,
  `updated_at`) for the live bar and stall detection, and `job_summary.json`
  (`n_success`, `n_failed`) for the per-episode counts. Missing files only cost
  the progress UI, not the conversion.
- **Config loader** for `/profiles` validation:
  `from rosbag2lerobot.config import load_config`. If a fork changes this,
  profiles show as "not verified" (still runnable), not broken.

Anything satisfying the above works — Docker installs whatever is here via
`pip install ./deploy/lerobot/converter` (see `services/lerobot_exporter/Dockerfile`).
