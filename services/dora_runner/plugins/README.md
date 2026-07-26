# dora_runner plugins

Drop-in pipelines for `dora_runner`. Each subdirectory here is one plugin: a
[dora](https://dora-rs.ai/) dataflow plus a manifest. At startup
`dora_runner.plugin_loader.discover_plugins()` scans every
`*/kairos_plugin.yaml`, validates it, and registers it as a pipeline — so it
shows up in `GET /pipelines` and `POST /jobs` with **no core code change** and
**no frontend change**. The Validation tab is pipeline-agnostic: it renders the
job form from the manifest's `params_schema` **and** renders the result from the
job's `summary.json` generically, so a plugin author never edits the UI (see
[`docs/specs/ja/dora_plugins.md` §2.5](../../../docs/specs/ja/dora_plugins.md)).

Design spec: [`docs/specs/ja/dora_plugins.md`](../../../docs/specs/ja/dora_plugins.md).

## Layout

```
plugins/
├─ hello_dora/                 # example: count messages per topic in an MCAP
│  ├─ kairos_plugin.yaml       #   manifest (required) — id / params_schema / entrypoint
│  ├─ dataflow.yml             #   dora dataflow: mcap_loader -> summarize -> result_writer
│  └─ nodes/                   #   dora nodes (one file per node)
│     ├─ loader.py
│     ├─ summarize.py
│     └─ writer.py
└─ hello_kairos/               # template: take an input, emit "hello kairos!"
   ├─ kairos_plugin.yaml       #   copy-me starting point for a new plugin
   ├─ dataflow.yml             #   dora dataflow: greet -> result_writer
   └─ nodes/                   #   decode-free — ignores the MCAP, just greets
      ├─ greet.py
      └─ writer.py
```

## How a plugin runs

The same `dataflow.yml` drives two execution paths:

- **With the `dora` CLI/daemon installed** — the runner shells out to
  `dora start dataflow.yml`, passing the job context via `KAIROS_*` env vars that
  each node's `main()` reads. (Needs `dora up`; the `dora` CLI is the Rust binary,
  *not* the `dora-rs` Python wheel.)
- **Without it** — a tiny in-process interpreter (`plugin_loader.run_dataflow_in_process`)
  topologically orders the nodes from `dataflow.yml` and calls each node module's
  `process(inputs, ctx)`. This is the path unit tests use, and it runs on a
  CPU-only host with only the `dora-rs` Python bindings (or none at all).

So each node module is **dual-mode**:

```python
def process(inputs, ctx):  # pure logic — in-process interpreter
    ...
def main():  # dora event loop — `dora start`
    from dora import Node

    ...
```

`ctx` is a `NodeContext(plugin_id, run_id, data_dir, params, report_dir)`. The
terminal node must write `report_dir/summary.json`; the runner reads it back and
collects every file under `report_dir` as the job's `artifacts`.

## Writing a new plugin

1. Create `plugins/<id>/` with a `kairos_plugin.yaml` (`id` must match
   `^[a-z0-9_]+$` and be unique across pipelines).
2. Add a `dataflow.yml` and `nodes/` (each node exposing `process()` + `main()`).
   The terminal node writes `summary.json` in the
   `{pipeline, version, result, metrics, ...}` shape.
3. Rebuild the image (`make rebuild dora`). Plugins are baked into the image
   (`KAIROS_PLUGINS_DIR=/app/plugins`), so adding one = adding a folder + rebuild.

A broken plugin is skipped with a warning at startup — it never takes the service
or the other plugins down.
