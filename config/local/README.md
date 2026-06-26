# config/local/ — untracked local robot configs

Put `RECORDING_CONFIG` / validation YAML for **confidential robots** here (robot
names and topic names that must not be committed). Everything in this directory
is **gitignored** except this README and `.gitkeep`, so these files stay local.

The whole `config/` directory is mounted read-only into the containers
(`./config:/config:ro` in `compose.yaml`), so a file here is reachable inside as
`/config/local/<robot>.yaml` — no extra mount needed.

## Use a local config

```bash
# point the stack at a local robot config (recording + monitoring)
make up RECORDING_CONFIG=/config/local/realman.yaml
# or set it persistently in your (gitignored) .env:  RECORDING_CONFIG=/config/local/realman.yaml
```

For validation templates, either keep the template inline under the YAML's
`validation:` block, or point `VALIDATION_DIR=/config/local/validation` (also
untracked) at a local templates dir.

## Sample data goes under data/

Recordings/bags for a confidential robot go under `data/` (also gitignored) —
e.g. `data/realman/<run>/`. Replay with `make rosbag BAG=realman/<run>`.
**MCAP** is preferred (it embeds message schemas, so `dora_runner` validation /
conversion works without building the custom-message packages). A `.db3`
(sqlite3) bag or `ros2 bag play` of custom-type topics needs the custom messages
built into `deploy/msgs_overlay/` (see that dir's README).
