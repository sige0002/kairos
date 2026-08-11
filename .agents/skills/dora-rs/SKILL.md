---
name: dora-rs
description: >
  Best practices, current CLI/API surface, and dataflow patterns for dora-rs (dora), the Arrow-based,
  dataflow-oriented robotic architecture framework (https://dora-rs.ai, github.com/dora-rs/dora). Use this
  skill when building or debugging a dora dataflow, writing a dora node in Python/Rust/C/C++, editing a
  dataflow YAML, using the dora CLI (dora new/build/run/up/start/stop/logs/hub), the dora Node Hub, the
  dora-ros2-bridge, or Apache Arrow message passing between nodes. Trigger whenever the user mentions
  dora, dora-rs, dora-cli, dora node, dora dataflow, dataflow YAML, `from dora import Node`,
  DoraNode::init_from_env, send_output, dora hub, adora, or the v1.0 / adora→dora rewrite. ALSO trigger for
  kairos's own dora_runner plugin work: kairos_plugin.yaml, the plugin_loader / in-process dataflow
  interpreter, a plugin's dual-mode `process()`/`main()` node contract, summary.json output, or adding a
  new validation/conversion pipeline to services/dora_runner.
---

# dora-rs (dora) Skill

dora ("Dataflow-Oriented Robotic Architecture") is a framework for building robotics/AI applications as a
**graph of nodes** connected by typed data streams. Nodes are separate processes (or in-process operators);
data flows between them as **Apache Arrow** buffers with (by design) zero-copy, zero-serialization overhead.
It is the substrate kairos's `dora_runner` uses for post-recording validation/conversion pipelines.

## When to use this skill
- Writing or debugging a dora dataflow (the `dataflow.yml` graph) or a node (Python/Rust/C/C++).
- Using the `dora` CLI or the Node Hub package manager.
- Wiring the `dora-ros2-bridge` or moving Arrow tensors/images between nodes.
- **kairos-specific:** authoring a `dora_runner` plugin (a `kairos_plugin.yaml` + a dataflow + dual-mode
  nodes), or reasoning about the in-process interpreter / plugin contract. See **§8**.

---

## 0. ⚠️ FIRST: dora is in a two-version split — check which surface you're on

This is the single most important fact right now, and the easiest way to write code that doesn't run. As of
mid-2026 there are **two different, both-"current" dora surfaces**, and they diverge on CLI, YAML, and API:

| | **Installable today** (PyPI / crates.io) | **`main` branch + docs site (dora-rs.ai)** |
|---|---|---|
| Version | **v0.5.0** (the newest published release) | **v1.0.0-rc.1** (git tag only, *not* on any registry) |
| CLI | `dora build`, `dora run`; simpler surface | full `dora up/start/stop/restart/down`, `dora hub …`, `dora node …`, `dora topic …`, `dora cluster …` |
| Node Hub | none (only the separate example-nodes repo) | real: `hub:` YAML key, `dora build --locked`, `dora hub search/info/publish` |
| YAML | `id`/`path`/`build`/`inputs`/`outputs`/`env`/`args` | adds `git`, `hub`, `restart_policy`, `health_check_timeout`, `_unstable_deploy`, module params, … |
| Naming | "DORA" | "Dora" (agentic); `adora`→`dora` consolidation done |

**Why:** the Q1-2026 Rust-first rewrite (originally the archived `dora-rs/adora` repo) was squash-merged into
`dora-rs/dora` `main` on 2026-04-17 as `v1.0.0-rc.1`, but **nothing past 0.5.0 has been published to a
registry yet** (tracker: dora-rs/dora#1626). So `pip install dora-rs` / `cargo install dora-cli` still gives
you the **0.5.0** surface, while the README and docs site describe the **unreleased rewrite**.

**Practical rule:** confirm the version before trusting any command or YAML field.
```bash
dora --version              # 0.5.x → old surface; 1.0.0-rc.x → you built from main
pip show dora-rs | grep Version
```
If the user is on a registry install, prefer the **0.5.0** subset (`dora run`, `dora build`, plain YAML) and
treat `dora hub`, `restart_policy`, `_unstable_deploy`, daemon `up/start` split as *not necessarily present*.
When something below is rewrite-only, it's marked **[v1.0-rewrite]**.

> kairos note: `dora_runner` does **not** ship the Rust `dora` binary at all — it runs dataflows through its
> own in-process interpreter (see §8). So for kairos work, the CLI surface below is background/context;
> what actually matters is the dataflow-YAML shape and the node `process()` contract.

---

## 1. Mental model (stable across versions)

- A **dataflow** is a YAML file listing **nodes** and their input→output wiring.
- A **node** is a program that loops over incoming **events** and emits **outputs**. Each output has a
  string id; an input subscribes to `<producer_node>/<output_id>`.
- Data on the wire is an **Apache Arrow array** (`pyarrow.Array` in Python). Not JSON, not a ROS msg — Arrow.
- **Sources** need a trigger to fire. Use a built-in timer input `dora/timer/millis/<N>` or `dora/timer/hz/<N>`
  — a node with no inputs otherwise never gets an event.
- Nodes are **decoupled**: a node only knows its input ids and output ids. Anything with the same I/O can be
  swapped in. (This decoupling is exactly what kairos's plugin contract leans on — §8.)

---

## 2. CLI quick reference

**Lifecycle**
```bash
dora new my_project --kind dataflow --lang python   # scaffold (--lang rust|python|c|cxx; --kind dataflow|node)
dora run path/to/dataflow.yml                        # run locally, NO coordinator/daemon needed
dora build path/to/dataflow.yml                      # run each node's `build:` step (installs deps, compiles)
dora build dataflow.yml --uv                         # [v1.0] build Python nodes into per-node uv venvs
```

**[v1.0-rewrite] coordinator/daemon mode** (multi-node / hot-reload / remote):
```bash
dora up                                # start coordinator + daemon (idempotent)
dora start dataflow.yml --name run1    # start on the running coordinator (--attach, --detach, --hot-reload)
dora list        # (alias: dora ps)    dora logs <id> [--node <name>]     dora stop [<id>]     dora restart <id>
dora down        # (alias: dora destroy) tear down coordinator+daemon
```

**Inspect / debug:** `dora graph dataflow.yml --mermaid` (visualize), `dora validate` (+`--strict-types`),
`dora doctor`, `dora top` (resource TUI). **[v1.0]** `dora topic list/hz/echo/pub`, `dora record`/`dora replay`.

**[v1.0-rewrite] Node Hub** (cargo-style, per-dataflow, no global install; whole subsystem marked *unstable*):
```bash
dora hub search <query>        dora hub info <pkg>[@<ver>]        dora hub outdated dataflow.yml
# usage: add `hub: <name>@^0.5` to a node in YAML, then `dora build` resolves + locks it.
```
`dora hub install` is a stub that just prints guidance — the real mechanism is the `hub:` YAML key + `dora build`.

---

## 3. Dataflow YAML

Minimal, works on both versions (from the official `examples/python-dataflow/dataflow.yml`):
```yaml
nodes:
  - id: sender
    path: sender.py
    outputs:
      - message                 # output ids this node emits

  - id: transformer
    path: transformer.py
    inputs:
      message: sender/message   # input_name: <producer>/<output_id>
    outputs:
      - transformed

  - id: receiver
    path: receiver.py
    inputs:
      message: sender/message
      transformed: transformer/transformed
```

**Per-node fields (core):** `id` (required, no `/`), `path` (script/executable — can be a URL), `inputs`
(map), `outputs` (list of ids), `env` (map), `args`, `build` (shell run at `dora build` time).

**Input long form** (backpressure / timeouts) **[v1.0]**:
```yaml
inputs:
  frames:
    source: camera/frames
    queue_size: 10             # default 10
    queue_policy: drop_oldest  # or `backpressure`
    input_timeout: 5.0         # circuit breaker → node gets an InputClosed-style event
```

**Built-in inputs (no producer node):** `dora/timer/millis/<N>`, `dora/timer/hz/<N>` (triggers), and log taps
`dora/logs`, `dora/logs/error`.

**[v1.0-rewrite] additional per-node fields** — do NOT assume these on a 0.5.0 install:
- Source alternatives: `git:` (+ one of `branch`/`tag`/`rev`), `hub: <name>@^0.5`, `module:` + `params:`.
- Fault tolerance: `restart_policy: never|on-failure|always`, `max_restarts`, `restart_delay` (exp backoff),
  `restart_window`, `health_check_timeout`.
- Logging: `send_stdout_as: <output>` (route stdout lines as a data output), `send_logs_as`, `min_log_level`.
- Placement: `_unstable_deploy: { machine, working_dir, labels }`, `cpu_affinity: [0,1]` (Linux).
- Types (opt-in, never required): `output_types`/`input_types` map ports to URNs like `std/media/v1/Image`;
  enforced only via `dora validate` / `dora build --strict-types` / env `DORA_RUNTIME_TYPE_CHECK=warn|error`.
- ROS2: a `ros2: { topic, message_type, direction }` key auto-spawns a bridge node (see §6).

Root-level: `nodes` (required), plus **[v1.0]** `strict_types`, `type_rules`, `health_check_interval`,
`_unstable_deploy`. A JSON Schema (`dora-schema.json` at repo root) gives editor autocompletion.

---

## 4. Python node API

Import name is **`dora`** but the package is **`dora-rs`** (`pip install dora-rs`; `pip install dora` is an
unrelated project — a classic footgun). Data in/out is **pyarrow**.

```python
# receiver.py — the canonical for-loop form (from the official examples)
from dora import Node

node = Node()
for event in node:                       # blocks for the next event
    if event["type"] == "INPUT":
        if event["id"] == "message":
            values = event["value"].to_pylist()   # event["value"] is a pyarrow.Array
    elif event["type"] == "STOP":
        break
```
```python
# sender.py — emit outputs; poll with a timeout instead of blocking
import pyarrow as pa
from dora import Node

node = Node()
for i in range(100):
    node.send_output("message", pa.array([i]))     # send_output(id, pyarrow.Array, metadata=None)
    event = node.next(timeout=0.1)                  # None if nothing arrived within the timeout
    if event is not None and event["type"] == "STOP":
        break
```

**Confirmed API** (from the shipped `dora/__init__.pyi`): `Node(node_id=None)`; iterate with
`for event in node:` or call `node.next(timeout=None)`; `event["type"]` ∈ `{"INPUT", "STOP", …}`;
`event["id"]` (input name); `event["value"]` (a `pyarrow.Array` — `.to_pylist()` for Python values,
`.to_numpy()` for numpy); `node.send_output(output_id, data, metadata=None)`; structured logging via
`node.log_info/log_error/...`. Module-level `dora.run(path)`, `dora.build(path)` mirror the CLI.

**Gotchas / honesty flags:**
- The `main`-branch README's quick-start shows `node.try_recv()`, but `try_recv` is **not** in the shipped
  `.pyi` and no real example uses it — treat it as stale. Use `node.next(timeout=...)` for non-blocking.
- Beyond `"INPUT"`/`"STOP"`, an `InputClosed`-style event type exists (mirrors Rust's `Event::InputClosed`),
  but its exact Python `event["type"]` string wasn't verifiable — check with a `print(event)` before relying.
- `node.recv_async()` exists but is marked **experimental**.

---

## 5. Rust node API (brief)

```rust
use dora_node_api::{DoraNode, Event, IntoArrow, dora_core::config::DataId};

fn main() -> eyre::Result<()> {
    let (mut node, mut events) = DoraNode::init_from_env()?;
    let out = DataId::from("random".to_owned());
    while let Some(event) = events.recv() {
        match event {
            Event::Input { id, metadata, data } => match id.as_str() {
                "tick" => {
                    let value: u64 = fastrand::u64(..);
                    node.send_output(out.clone(), metadata.parameters, value.into_arrow())?;
                }
                _ => {}
            },
            Event::Stop(_) => {}
            Event::InputClosed { id } => println!("input {id} closed"),
            _ => {}
        }
    }
    Ok(())
}
```
Crate: `dora-node-api` (currently 0.5.0 on crates.io). `DoraNode::init_from_env() -> (DoraNode, EventStream)`;
`events.recv() -> Option<Event>`; `IntoArrow` converts primitives to Arrow. Rust edition 2024, MSRV 1.88.0 on `main`.

---

## 6. Data conventions & ROS2 bridge

- **Everything is Arrow.** Node-to-node payloads are raw zero-copy Arrow buffers by default; opt into
  self-describing framing per output with `output_framing: {name: arrow-ipc}` **[v1.0]**.
- **Media types** (opt-in URNs under `std/media/v1`): `Image` is an Arrow **Struct** with fields
  `width`/`height`/`encoding`/`data`; `CompressedImage` is `LargeBinary` (JPEG/PNG bytes) with a `format`
  param; also `PointCloud`, `AudioFrame`. Runtime type-checking *skips* struct types — only primitives/
  String/Bytes/Bool are validated.
- **dora-ros2-bridge** (marked *Experimental*): a **pure-Rust DDS stack** (`ros2-client` + `rustdds`) — it
  never links `rcl`/`rclcpp`. Two ways in: (1) a `ros2:` key on a node auto-spawns a bridge that converts
  ROS2 CDR ↔ Arrow `StructArray`, no custom code; (2) native Python `dora.Ros2Context`/`Ros2Node` APIs
  (all annotated *unstable*). Relevant to kairos since the rest of the stack is rclpy-based ROS 2.

---

## 7. Common pitfalls

- **Version mismatch (see §0).** Writing `dora hub`/`restart_policy`/`dora start` YAML against a 0.5.0 install
  → silently unsupported. Always check `dora --version` first.
- **A source node with no trigger never fires.** Give it a `dora/timer/...` input.
- **`pip install dora` ≠ dora-rs.** Install `dora-rs`, import `dora`.
- **Forgetting outputs are Arrow.** `send_output("x", my_dict)` fails — wrap in `pa.array(...)` (or a
  struct/`RecordBatch`). On receive, `event["value"]` is a `pyarrow.Array`, not your Python object.
- **Node ids can't contain `/`** (the `/` separates producer/output in an input ref).
- **Type URNs are optional documentation**, not a runtime contract for struct types — don't rely on them to
  catch shape bugs in images/tensors.

---

## 8. kairos `dora_runner` integration (the practical part)

kairos does not bundle the Rust `dora` binary. Instead `services/dora_runner` treats **dora as a contract**:
a pipeline is a dataflow + nodes, and as long as the **I/O contract** is honored, the same graph runs either
under `dora start` (if the CLI is ever present) **or** through kairos's own in-process interpreter — with **no
core-code and no frontend change**. This is the design the user summarized as *"inputs and outputs just have
to match the contract."* It's true, and here is exactly what the contract is.

### The two-level contract

**Level 1 — the plugin manifest `kairos_plugin.yaml`** (validated by `plugin_loader.PluginManifest`,
`extra="forbid"` so typos are rejected):
```yaml
apiVersion: kairos.plugin/v1        # must equal PLUGIN_API_MAJOR, else the plugin is skipped
id: my_pipeline                     # ^[a-z0-9_]+$, unique across all pipelines
name: My pipeline
description: One-line summary shown in the UI.
executor: dora                      # `dora` (dataflow) or `in_process` (a plain callable)
version: 0.1.0
required_inputs: [run_id]           # defaults to [run_id]
params_schema:                      # JSON Schema — the frontend renders the job form from THIS
  type: object
  properties:
    min_messages: { type: integer, default: 1, minimum: 0 }
outputs:
  - "report/my_pipeline/<run_id>/summary.json"
entrypoint:
  dataflow: dataflow.yml            # executor=dora → a dataflow file …
  # callable: module:function       # … or executor=in_process → a "<module>:<function>" callable
requires: { gpu: false }
```
Drop this folder under `services/dora_runner/plugins/<id>/`, `make rebuild dora`, and `discover_plugins()`
auto-registers it: it appears in `GET /pipelines` and is startable via `POST /jobs`. A broken plugin is
skipped with a warning at boot — it never takes the service or sibling plugins down.

**Level 2 — the node contract.** Each node module in `nodes/` is **dual-mode**:
```python
def process(inputs: dict, ctx) -> dict:      # pure logic — used by the in-process interpreter (+ unit tests)
    # inputs = {input_name: value_from_upstream_node}
    ...
    return {"summary": {...}}                 # {output_id: value} → routed into downstream nodes' inputs

def main() -> None:                           # dora event-loop form — used under `dora start`
    from dora import Node
    node = Node()
    for event in node:
        ...
```
`ctx` is `NodeContext(plugin_id, capture_id, data_dir, params, report_dir)` — the same job context the dora path
passes as `KAIROS_CAPTURE_ID` / `KAIROS_DATA_DIR` / `KAIROS_REPORT_DIR` / `KAIROS_PARAMS_JSON` env vars.
The capture must already exist: nodes **read** `objects/<capture_id>/` and never create it — a job that
mkdirs its way to a missing capture resurrects a deleted one behind the reaper's back.

**Level 2 output requirement (the one hard rule):** the **terminal node must write
`report_dir/summary.json`** in the shape `{pipeline, version, result, metrics, ...}` (`result` ∈
`pass`/`fail` for validators). The runner reads it back (`_collect_result`) and gathers **every file under
`report_dir`** as the job's `artifacts`. No `summary.json` → the job fails with `plugin_no_summary`.

### How the in-process interpreter runs your dataflow
`run_dataflow_in_process` parses the **same** `dataflow.yml`, builds edges from each node's `inputs:`
(`<producer>/<output>`), **topologically orders** them (Kahn's algorithm; a cycle raises), ignores built-in
`dora/timer/...` sources, then calls each node's `process(inputs, ctx)` and routes outputs into downstream
inputs. So your dataflow wiring must be a DAG, and node ids/output ids in `process()`'s return must match the
YAML edges — that's the whole contract.

### Which path runs, and how it's reported
`dora_cli_available()` picks the path: it returns `False` when the Rust `dora` binary is absent (the normal
kairos case) or when `KAIROS_DORA_INPROCESS` is set (forces in-process, used by tests). `effective_executor()`
maps a declared `executor: dora` to the honest string `in-process` when no CLI is present — so `/pipelines`
and `/readyz` never claim dora is bundled when it isn't. **Keep that honesty**: dora is a deliberate future
bet in kairos, not a shipped dependency — label pipelines truthfully.

### Reference implementation
`services/dora_runner/plugins/hello_dora/` is the canonical minimal example (loader → summarize → writer,
decode-free topic counts). Copy it as the starting template for a new pipeline. Spec:
`docs/specs/ja/dora_plugins.md` and `docs/specs/ja/dora_runner.md`.

### Checklist for a new pipeline
1. `plugins/<id>/kairos_plugin.yaml` — `apiVersion: kairos.plugin/v1`, unique `id`, a `params_schema` (the UI
   form), `entrypoint.dataflow` (or `.callable`).
2. `plugins/<id>/dataflow.yml` — a DAG of nodes; give any source a `dora/timer/...` trigger.
3. `plugins/<id>/nodes/*.py` — each node dual-mode (`process()` + `main()`); the terminal node writes
   `summary.json`.
4. `uv run --extra test pytest -q` in `services/dora_runner` (in-process path needs no ROS/dora), then
   `make rebuild dora`.
5. Verify it shows up: `GET /pipelines`, then run it via `POST /jobs {pipeline, run_id, params}`.

---

## Sources (verified mid-2026; re-check before relying on version-specific detail)

- Repo: https://github.com/dora-rs/dora — `README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/{cli,yaml-spec,types,ros2-bridge}.md`, `apis/python/node/dora/__init__.pyi`, `examples/{python,rust}-dataflow/`.
- Docs site: https://dora-rs.ai — describes the **v1.0-rewrite** surface (not yet on registries).
- Registries (what installs today = **0.5.0**): https://pypi.org/project/dora-rs/ , https://crates.io/crates/dora-cli , https://crates.io/crates/dora-node-api
- v1.0 status / consolidation: dora-rs/dora#1626 (RC tracker), commit `145ccce04` (adora→dora squash-merge, 2026-04-17), archived `dora-rs/adora`.
- Node Hub examples index: https://github.com/dora-rs/dora-hub
- kairos internal: `services/dora_runner/plugins/README.md`, `services/dora_runner/src/dora_runner/plugin_loader.py`, `docs/specs/ja/dora_plugins.md`, `docs/specs/ja/dora_runner.md`.

> Community `dora-skills` packs exist (`ZhangHanDong/dora-skills`, mirrored at `dora-rs/dora-skills`) but were
> last updated ~2026-01 against the pre-1.0 CLI and are stale on Node Hub / the adora→dora rename. This skill
> supersedes them for kairos and is written against the verified current sources above.
