<!-- AUTO-GENERATED from docs/dora/README.ja.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# dora_runner — validation dev guide (current state / adding a check / unit tests / debugging)

**日本語: [README.ja.md](README.ja.md)**

> The canonical design is [docs/specs/en/dora_runner.md](../specs/en/dora_runner.md). This is a
> developer guide to the **current implementation** and the workflow (kept in sync with the code).
> Related (Japanese): a dora intro at [getting-started.ja.md](getting-started.ja.md) and a curated
> resource list at [resources.ja.md](resources.ja.md).

## Current state (the v1 implementation, as built)
- The only enabled pipeline is **`fast_validation`** (`full_validation` / `dataset_convert` /
  `dataset_validation` are `enabled=false` placeholders). `pipelines.py`'s `PIPELINES` is a **static list**.
- The Plugin/Pipeline Registry, dora dataflow (YAML), and dora daemon from the spec are **not
  implemented**. Instead `fast_validation` is implemented as **plain in-process Python functions**
  (`validation.py`):
  - `mcap_loader(run_id, data_dir)` → opens `/data/recorded/<run_id>/*.mcap` and enumerates the
    topic list (**no ROS decoding**, `mcap` + `mcap-ros2-support`).
  - `validator(loaded, template)` → matches the topic list against `template.required_topics`
    (**glob = fnmatch**; when `type` is given, the type must match too). Returns
    `{template, result, missing, extra, checked_at}`.
  - `result_writer(summary, data_dir, run_id)` → writes `/data/report/fast_validation/<run_id>/summary.json`.
  - `run_fast_validation(...)` chains the three in-process (runs in CI/tests with no dora coordinator).
- HTTP (via `api_orchestrator` or directly):
  `GET /pipelines` / `POST /jobs` / `GET /jobs/{id}/status` / `GET /jobs/{id}/result` /
  `POST /jobs/{id}/cancel` / `POST /validation/templates/generate` / `GET,POST /validation/templates`.
  The **job / template store is in-memory** (lost on process restart).
- **Node contract** (the key to swapping and unit testing): each node is a pure function with
  `dict`/model in/out. Input = `run_id` / `data_dir`, `loaded` (topics), `template`, `params`;
  output = `summary` (dict) / `artifacts` (path list).

## How to add a validation check
There is no registry yet, so the steps are "**add functions and models**".

### A. Just tighten the required-topic rules (no code)
Edit the template. `required_topics` is a **glob name + optional type**:
```yaml
name: hsr_teleop_v1
version: 1
required_topics:
  - { name: "/hsrb/joint_states", type: "sensor_msgs/msg/JointState" }
  - { name: "/hsrb/*/image_raw/compressed" }   # glob allowed (type optional)
```

### B. Add a new kind of check (e.g. expected_hz / min_duration / message_count)
1. **Extend the model**: add fields to `RequiredTopicTemplate` / `ValidationTemplate` in `models.py`
   (e.g. `min_hz`).
2. **Add the logic**: extend `validator()` in `validation.py`. Checks that only need topic name/type
   are done from `loaded["topics"]`. Checks that need **counts/rates/content** decode messages via
   `mcap_utils.iter_decoded_ros2_messages(mcap_path, topics=[...])` and aggregate (add the
   aggregation to `mcap_loader`, or write a new node function).
3. **Surface the result**: include the failure detail in `summary`.
4. **Test**: `validator()` is a pure function → **unit test it with a synthetic `loaded` dict** (below).

### C. Add a new pipeline (beyond fast_validation)
1. Add a `PipelineDefinition(id=..., enabled=True, schema=...)` to `PIPELINES` in `pipelines.py`.
2. Implement its executor (**same in/out contract** as `run_fast_validation`; in `validation.py` or
   a new module).
3. `main.py`: extend the `create_job` **guard** (today it 400s when `pipeline != "fast_validation"`)
   into a branch, and pick the executor per pipeline in `_execute_job`.
4. To move toward the spec's registry/dataflow, that is a separate design (not implemented).

## How to unit test
```bash
cd services/dora_runner && uv run --extra test pytest -q
```
- **Call `validator()` directly (no MCAP — the recommended debug unit)** — `tests/test_validator.py`.
  Build `loaded = {"topics": [{"name","type"}, ...]}` by hand and assert the verdict. Fast,
  deterministic, no local recording needed.
- **Real-MCAP flow test** — `tests/test_fast_validation.py`. Depends on a real recording at
  `data/recorded/<RUN_ID>` and **auto-skips when it is absent** (`data/` is gitignored). For how to
  produce a recording, see the integration recipes in [CLAUDE.md](../../CLAUDE.md).

## Debugging / iteration (an easy-to-debug workflow)
- **Local CLI** (runs immediately without the HTTP server → ideal for trying things):
  ```bash
  cd services/dora_runner
  # auto-generate a template and run (build a draft from the run's topics and compare)
  uv run python -m dora_runner.cli <run_id> --data-dir ../../data
  # swap the template and re-run as many times as you like
  uv run python -m dora_runner.cli <run_id> --data-dir ../../data --template my.yaml
  uv run python -m dora_runner.cli <run_id> --data-dir ../../data --json   # raw summary
  ```
  - The pass/fail maps to the **exit code (0/1)**. Output is `/data/report/fast_validation/<run_id>/summary.json`.
  - Once installed it also runs as `dora-validate <run_id> ...` (console script).
- **Try parts in isolation**: nodes are pure functions, so you can call
  `mcap_loader`→`validator`→`result_writer` individually in a REPL/test. `validator()` lets you swap
  the template and try many variants instantly.
- **Note**: the job/template store is in-memory (lost on restart). Persistence (a DB) is future work (see the spec).

## Known gaps (vs the spec / TODO)
- The Plugin/Pipeline Registry, dora dataflow (YAML), and dora daemon are **not implemented** (the spec is the future vision).
- `full_validation` / `dataset_convert` / `dataset_validation` are interface-only (`enabled=false`).
- AI nodes / LeRobot conversion and job/template persistence are not implemented.
