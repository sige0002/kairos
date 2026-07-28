<!-- Mirror of docs/dora/README.ja.md (Japanese is the source of truth). Edit the Japanese side first, then update this file by hand. -->

# dora_runner — validation dev guide (current state / adding a check / unit tests / debugging)

**日本語: [README.ja.md](README.ja.md)**

> The canonical design is [docs/specs/en/dora_runner.md](../specs/en/dora_runner.md). This is a
> developer guide to the **current implementation** and the workflow (kept in sync with the code).
> Related (Japanese): a dora intro at [getting-started.ja.md](getting-started.ja.md) and a curated
> resource list at [resources.ja.md](resources.ja.md).

## Current state (updated 2026-07-26)
- There are **6 enabled pipelines: `fast_validation` / `full_validation` / `dataset_export` /
  `loss_report` / `video_check` / `signal_report`** (`dataset_convert` / `dataset_validation` are
  `enabled=false` placeholders; `POST /jobs` rejects them with `pipeline_unavailable`).
- The registry is **implemented**: `registry.py`'s `build_default_registry()` registers the 6 bundled
  pipelines, and `plugin_loader.discover_plugins()` scans manifests under `KAIROS_PLUGINS_DIR`
  (default `services/dora_runner/plugins/`) and auto-registers them (example plugin `hello_dora`
  included).
- **Both validation gates are bagflow flows on real dora** (`fast_validation` / `full_validation`).
  The dora CLI (0.5.0) and the bundled bagflow Rust nodes **ship in the dora_runner image**, but a
  source checkout / CI has neither, so there both gates degrade to `enabled=false` (with the reason
  in their description). A plugin's `executor: dora` still runs through the **in-process
  interpreter** (`/readyz`'s `components.dora` / `components.bagflow` and `/pipelines`'s
  `effective_executor` faithfully report the actual execution path).
- **What `fast_validation` is made of** (`fast_validation.py` + `flows/fast_validation.yml`):
  - The flow **ships with the service** (in the image at `/opt/kairos/flows/fast_validation.yml`).
    Placing `config/<robot>/flows/fast_validation.yml` overrides it.
  - One check node, `bagflow-topic-presence` (Rust). It **subscribes to no topic**: it never reads the
    MCAP and matches against the topic list and types from `metadata.yaml` (glob = fnmatch; when
    `type` is given, the type must match too).
  - `bagflow_pipeline.py` holds the execution machinery both gates share (materialization, timeouts,
    cleanup, artifacts).
  - `fast_validation.summarize()` adapts bagflow's `report.json` into `summary.json`
    (`{template, result, missing, extra, checked_at, engine, checks, metrics}`).
  - What remains in `validation.py` is **draft template generation** (`mcap_loader` /
    `generate_template`) and nothing else.
- HTTP (via `api_orchestrator` or directly):
  `GET /pipelines` / `POST /jobs` / `GET /jobs/{id}/status` / `GET /jobs/{id}/result` /
  `POST /jobs/{id}/cancel` / `POST /validation/templates/generate` / `GET,POST /validation/templates`.
  The **job / template store is persisted in SQLite** (`store.py`; in-flight jobs are reconciled to a
  terminal state on restart).

## How to add a validation check

### A. Just tighten the required-topic rules (no code)
Edit the template. `required_topics` is a **glob name + optional type**:
```yaml
name: hsr_teleop_v1
version: 1
required_topics:
  - { name: "/hsrb/joint_states", type: "sensor_msgs/msg/JointState" }
  - { name: "/hsrb/*/image_raw/compressed" }   # glob allowed (type optional)
```

### B. Add a new kind of check (e.g. expected_hz / min_duration / image quality)
Validation IS a bagflow flow, so "add a check" means "add a node and write it into the flow".
1. **No code when a bundled node already covers it** — add one node to `config/<robot>/flows/*.yml`
   (`bagflow-stamp-gap` / `-topic-rate` / `-blur` / `-brightness` / `-freeze` / `-decode`).
   Thresholds go in `env:`; values that already live in kairos config arrive through tokens such as
   `${KAIROS_EXPECT_HZ}`.
2. **Writing a new node** — add
   `services/dora_runner/bagflow/crates/bagflow-checks/src/bin/<name>.rs`, list it under `[[bin]]` in
   `Cargo.toml` and in the `Dockerfile`'s cp list. The node contract is `BagflowNode::init()` → a
   `next_message()` loop → `report(json!({"check": …, "ok": …}))` → `close()`. Factor the decision out
   into a pure function and unit-test it with `#[cfg(test)]` (`topic_presence.rs` is the model).
3. **The overall pass/fail verdict is decided by the kairos adapter** (`bagflow_summary.summarize` /
   `fast_validation.summarize`): any check with `ok: false` fails the run, as does a non-empty
   `incomplete`.
4. **To add a template field**, extend `ValidationTemplate` in `models.py` and pass it to the flow as a
   new token from `bagflow_pipeline` (`required_topics` / `topic_expectations`).

### C. Add a new pipeline (beyond fast_validation)
1. **As a bundled pipeline**: add a `RegisteredPipeline(id=..., runner=..., enabled=True, schema=...)`
   to `build_default_registry()` in `registry.py`. `runner` follows the contract `async (job, store,
   data_dir) -> {"summary":…, "artifacts":[…]}` (same in/out as `validation.py` / `loss_report.py` and
   friends). Leaving `runner=None` makes it a placeholder (`enabled=false`) and `POST /jobs` returns
   `pipeline_unavailable`.
2. **As a plugin** (no core changes needed): put a manifest (`kairos_plugin.yaml`) and the
   implementation under `KAIROS_PLUGINS_DIR`. `discover_plugins()` auto-registers it at startup (see
   `hello_dora` for reference).
3. For reproducibility, include `pipeline` / `version` in the summary (same convention as the 4
   bundled pipelines).
4. Running as a dataflow on the dora daemon is a future direction
   ([dora_plugins.md](../specs/en/dora_plugins.md)). Today it runs via the in-process interpreter.

## How to unit test
```bash
cd services/dora_runner && uv run --extra test pytest -q          # the Python side
# The Rust nodes (bundled bagflow) — use a container if the host has no rust
cargo test -p bagflow-checks --manifest-path services/dora_runner/bagflow/Cargo.toml
```
- **The matching logic (glob / type / empty-topic tolerance) is tested on the Rust side** — the
  `#[cfg(test)]` block in `bagflow-checks`' `topic_presence.rs` (no MCAP, no dora — the fastest
  iteration unit).
- **The report → summary adapter** — `tests/test_fast_validation_summary.py`. Hand-build a bagflow
  `report.json` and assert the `summary.json` contract (`missing` / `extra` / `result`). No dora.
- **Flow materialization** — `tests/test_bagflow_flow.py` (`${KAIROS_*}` substitution, path
  resolution, search order, the bundled flow).
- **Real-MCAP flow test** — `tests/test_fast_validation.py`. Depends on a real recording at
  `data/recorded/<RUN_ID>` **and** on the bagflow/dora binaries; it auto-skips when either is missing
  (i.e. it only runs inside the image). For how to produce a recording, see the integration recipes in
  [CLAUDE.md](../../CLAUDE.md).

## Debugging / iteration (an easy-to-debug workflow)
- **Local CLI** (no HTTP server needed). It uses real dora, so run it **inside the image**:
  ```bash
  # auto-generate a template and run (build a draft from the run's topics and compare)
  docker compose exec dora_runner python -m dora_runner.cli <run_id> --data-dir /data
  # swap the template or the flow and re-run as many times as you like
  docker compose exec dora_runner python -m dora_runner.cli <run_id> --data-dir /data --template my.yaml
  docker compose exec dora_runner python -m dora_runner.cli <run_id> --data-dir /data --json  # raw summary
  ```
  - The pass/fail maps to the **exit code (0/1)**. Output is `/data/report/fast_validation/<run_id>/summary.json`.
  - On a host without the binaries it **says so and exits 2** (it never silently falls back to another
    implementation).
- **When a flow fails**: the failed job's `details.node_logs` points at
  `data/report/<pipeline>/<run_id>/flow/.bagflow/out/<uuid>/log_<node>.txt`. The flow that actually ran
  is `flow/flow.yml` in the same directory (after `${KAIROS_*}` substitution).
- **Drive bagflow directly** (the smallest repro, with kairos out of the picture):
  ```bash
  docker compose exec dora_runner bagflow run --no-attach \
    --bag /data/recorded/<run_id> --report /tmp/report.json /opt/kairos/flows/fast_validation.yml
  ```
- **Note**: dora_runner owns its coordinator/daemon (127.0.0.1:6112 by default). Pass
  `--coordinator-port 6112` when running `dora list` and friends by hand (6012 is dora's own default,
  deliberately left to any other dora on the host).

## Known gaps (vs the spec / TODO)
- **A plugin's `executor: dora` still runs through the in-process interpreter.** Real dora is used by
  the two validation gates only; moving plugin dataflows onto it is separate work.
- The **Python bagflow check nodes and the CUDA decoder are not bundled** (see
  `services/dora_runner/bagflow/VENDOR.md` for why) — a flow may only use the bundled Rust binaries or
  an absolute path to something the operator installed.
- `dataset_convert` / `dataset_validation` are interface-only (`enabled=false`).
- AI nodes / LeRobot conversion are not implemented.
