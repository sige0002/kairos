<!-- AUTO-GENERATED from services/dora_runner/plugins/README.ja.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# Adding dora_runner plugins

Place a custom plugin's definition, implementation, and dependency declarations in a child folder of this directory, then rebuild the image. The Validation screen's form and result display are generated automatically.

## What the author provides

- `kairos_plugin.yaml`: a unique id, display name, version, entrypoint, and `params_schema`.
- For dora form, `dataflow.yml` and all nodes, with a `dora.Node` event loop that terminates as a finite batch. For callable form, a `module:function` implementation.
- A terminal step that writes `summary.json` to the designated report directory.
- Additional Python dependencies in `requirements.txt` or an installable `pyproject.toml`; keep `uv.lock` consistent with pyproject when used.
- OS dependencies in `requires.apt`, build-only dependencies in `requires.build_apt`, and required model, dictionary, or local wheel files.

The baseline environment is Python 3.12. Additional Python dependencies go into a plugin-specific venv, while the OS and data area are shared. Do not modify the input capture; write outputs to `KAIROS_REPORT_DIR`.

## What the installer does

Run from the repository root. Replace `my_plugin` with an unused name.

```bash
cp -R services/dora_runner/plugins/hello_kairos services/dora_runner/plugins/my_plugin
```

After copying, change the id, version, and outputs in `kairos_plugin.yaml`, and `PIPELINE_ID` and `VERSION` in `nodes/greet.py`. Edit the form, verdict handling, and dependency declarations, then build. The build rejects a duplicate id.

```bash
make build dora_runner
make up dora_runner
make logs dora_runner
```

The build environment needs access to dependency sources and an environment matching the target CPU architecture. Installing dependencies with pip on the host does not affect the image. Runtime downloads are unnecessary.

For GPU use, set `requires.gpu: true`, prepare an NVIDIA GPU, driver, and Container Toolkit on the host, and pass `PLUGIN_GPU=1` to both build and up.

## Confirming completion

1. Your pipeline and input form appear in the Validation screen.
2. Select a test capture and run it with inputs whose expected values are known. Hello examples also require selecting a capture.
3. The job finishes and the summary verdict, metrics, and artifacts match expectations.
4. Rebuild and recreate after changing code or dependencies.

`make test-plugin-dependencies` checks the bundled dependency test fixtures. Test your own plugin separately using the procedure above.

See the [plugin specification](../../../docs/specs/en/dora_plugins.md) for required files, node I/O, dependency isolation, unsupported forms, and error diagnostics.
