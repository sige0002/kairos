# Kairos dora_runner plugin contract

Use the existing [hello_dora plugin](../../../../services/dora_runner/plugins/hello_dora/)
as the minimal example. The specification is
[dora_plugins.md](../../../../docs/specs/ja/dora_plugins.md); the implementation is
[plugin_loader.py](../../../../services/dora_runner/src/dora_runner/plugin_loader.py).

## Manifest and discovery

`services/dora_runner/plugins/<id>/kairos_plugin.yaml` declares
`apiVersion: kairos.plugin/v1`, a unique lowercase/underscore ID, executor,
entrypoint, parameters, and outputs. Unknown manifest fields are rejected.
Use `entrypoint.dataflow` for `executor: dora` or `entrypoint.callable` for
`executor: in_process`. `params_schema` drives the existing UI form; adding a
plugin should not require a parallel frontend form or central dispatcher.
Discovery rejects broken/duplicate plugins while preserving healthy siblings.

## Node and output contract

Dora graph nodes support both `process(inputs, ctx) -> dict` for in-process
execution and `main()` for the dora event loop. `NodeContext` carries
`plugin_id`, `capture_id`, `data_dir`, `params`, and `report_dir`.
The CLI path passes `KAIROS_CAPTURE_ID`, `KAIROS_DATA_DIR`, `KAIROS_REPORT_DIR`,
and `KAIROS_PARAMS_JSON` to the node process.

A callable plugin takes `(capture_id, data_dir, params, report_dir)`.
Both execution modes write `report_dir/summary.json`; the terminal result uses
the pipeline's established summary schema (`pipeline`, `version`, `result`,
`metrics`, with `pass` / `fail` for validators). Missing summary fails with
`plugin_no_summary`. The runner gathers every file under report_dir as artifacts.

The input capture must exist before creating any report output. Read the capture
under `objects/<capture_id>/`; never mkdir an input to bypass that check or
resurrect a deleted capture. Follow capture store rules for IDs and paths.

## Execution and verification

The in-process interpreter topologically orders the same YAML graph, ignores
built-in timer sources as graph nodes, and routes returned output IDs into
consumer input names. The graph must be a DAG and its port names must match.

`dora_cli_available()` selects based on the CLI binary and the
`KAIROS_DORA_INPROCESS` override; binary presence alone does not prove daemon
readiness. `effective_executor()` reports the selected path. Bundled validation
pipelines separately require both dora and bagflow.

Run affected dora_runner tests for manifest rejection, wiring, input existence,
and summary behavior. When CLI execution or image integration changes, validate
that path in the authorized image/runtime; report it separately from fallback
tests. Image rebuild or stack startup is not implied by a documentation change.
