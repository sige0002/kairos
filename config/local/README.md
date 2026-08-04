# config/local/ — untracked local robot configs

Put **confidential robots** here (robot names / topic names that must not be
committed). Everything under this directory is **gitignored** except this README
and `.gitkeep`, so these files stay local.

The layout mirrors the committed robots, one folder per robot:

```
config/local/<robot>/
├─ recording/<option>.yaml     # default.yaml is the active option
├─ stream/<option>.yaml
├─ validation/<option>.yaml
└─ validators/<option>.yaml
```

The whole `config/` directory is mounted read-only into the containers
(`./config:/config:ro` in `compose/compose.yaml`), so a robot here is reachable inside as
`/config/local/<robot>/...` — no extra mount needed.

## Use a local robot

A single `ROBOT` selects the whole config set; `make` resolves committed
(`config/<robot>/`) vs local (`config/local/<robot>/`) automatically:

```bash
make up ROBOT=<robot>          # uses config/local/<robot>/
# or set it persistently in your (gitignored) .env:  ROBOT=<robot>
```

The Config tab also lists local robots (flagged `local`) so you can switch and
edit them in the UI — edits to a local robot's recording config write back to the
gitignored file, never to a committed one.

## Sample data goes under data/

Recordings/bags for a confidential robot go under `data/` (also gitignored) —
e.g. `data/<robot>/<run>/`. Replay with `make rosbag BAG=<robot>/<run>`.
**MCAP** is preferred (it embeds message schemas, so `dora_runner` validation /
conversion works without building the custom-message packages). A `.db3`
(sqlite3) bag or `ros2 bag play` of custom-type topics needs the custom messages
built into `deploy/msgs_overlay/` (see that dir's README).
