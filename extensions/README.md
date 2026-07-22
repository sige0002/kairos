# extensions/ — user extension drop-ins (non-destructive)

This directory lets you plug your own processing into two seams **without
touching kairos code**. Everything directly under `extensions/` (except this
README and `_template/`) is **gitignored**, so you can place your own repo here:

```bash
git clone https://github.com/you/my-ext extensions/my_ext
```

If you want `git submodule add`, two caveats (the path is gitignored): it
needs `-f`, and it records `.gitmodules` + a gitlink **in your kairos
checkout's history** (fine on your own fork; prefer a plain clone if you want
kairos history untouched).

Getting started: `cp -r extensions/_template extensions/my_ext` and follow the
README inside (folders starting with `_` are templates and are **never loaded**).

## The two seams

| Seam | Runs where | Contract | Activation |
|---|---|---|---|
| ① Live (dora_live side) | **your own container** (`live/compose.yaml`) | frames pull (`GET :8005/live/frames` index + `GET /live/frame?topic=` ETag/304) and the generic event intake (`POST :8005/internal/analysis/events` → `GET /live/events`) | `make ext-live EXT=my_ext` |
| ② Post-recording validation (dora_runner side) | inside dora_runner (loaded from the mounted `/extensions`) | `kairos_plugin.yaml` manifest + dora `dataflow.yml` + `nodes/` (the kairos.plugin/v1 contract, `docs/specs/en/dora_plugins.md`) | **first time only**: `make rebuild dora_runner` (or `make up`) — the container must be recreated to pick up the mount and env. **Every later add/update needs only `make restart dora_runner`** (no rebuild) |

### Why the live seam is a sidecar, and where it runs

The robot-side dora_live is never modified; **a separate LAN container pulls**
(push was rejected by user ruling: the robot must not depend on knowing any
consumer's address). A dead sidecar costs recording/monitoring nothing. Event
bodies are freeform (`t` = epoch seconds is the only reserved key; stamped with
the receive time when absent).

**Placement is any wired-LAN host** (that is the point of the pull contract).
In the split deployment start it from the recording PC as
`DORA_LIVE_URL=http://<robot>:8005 make ext-live EXT=my_ext` (the default
targets localhost = single-host dev).

### Why the validation seam is a plugin

dora_runner additionally scans `KAIROS_EXTENSIONS_DIR=/extensions` at startup
(compose mounts the repo's `extensions/` read-only). If an id clashes with a
bundled plugin, **the bundled one wins** (first registration). A broken plugin
is skipped; every other pipeline keeps working. The UI (Validation tab) renders
the form from the manifest's `params_schema` — no frontend change needed.

**When your extension doesn't appear**: check `plugin_errors` in
`GET :8020/pipelines` (folders that failed to load, with the reason), and
`make logs dora_runner` for `plugin load failed`.

## Security (honest premise)

An extension is **arbitrary Python executed inside the dora_runner process**
(with write access to /data). `entrypoint.callable` plugins are imported —
i.e. executed — **at discovery time on boot**, before any job runs. "Broken
plugins are skipped" is accident tolerance, not a security boundary — **only
install code you trust**.

## Constraints (honest fine print)

- Live frames are **compressed payloads decimated** to `frames.sample_hz`
  (default 2 Hz). Anything needing every frame / raw pixels belongs in
  post-recording (②), not live.
- `dora run` writes **next to the dataflow YAML**, so the template compose
  copies the extension folder to a writable location before starting (pointing
  it at a read-only mount fails).
- Live events live in a ring (last 500) and are **not persisted**.
- On hosts without the dora CLI, ② runs the same `dataflow.yml` through the
  in-process interpreter (which is why nodes must expose `process(inputs, ctx)`).
- **`git clean -fdx` deletes any unpushed extension placed here** (the path is
  gitignored). Stash/push before repo-wide cleans.

## Template contents

```
_template/
├─ kairos_plugin.yaml   # manifest for ② (change the id after copying)
├─ dataflow.yml         # the ② dora dataflow
├─ nodes/report.py      # the ② node (dual-mode: process() + main(), split-recording aware)
├─ live/
│  ├─ compose.yaml      # the ① sidecar definition (reuses the kairos-dora-live image)
│  ├─ dataflow.yml      # the ① one-node dataflow (tick-driven)
│  ├─ node.py           # the ① node: frames pull → mean brightness → events POST
│  └─ run_node.sh       # wrapper exec'ing the venv python (mandatory-trap fix)
└─ README.ja.md / README.md
```
