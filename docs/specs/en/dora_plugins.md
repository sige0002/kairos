<!-- AUTO-GENERATED from docs/specs/ja/dora_plugins.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# dora_runner plugin

## What users provide

Plugin authors provide the definitions, code, and dependencies; installers build the image and apply it to the execution environment. Packages installed with pip on the host are not automatically transferred into the container.

| Role | Required / conditional | Prepare and verify |
| --- | --- | --- |
| Author | Required | `kairos_plugin.yaml`: unique id, display name, entrypoint, input form `params_schema`, and version |
| Author | Required | `dataflow.yml` and all nodes for dora form, or `module:function` for callable form. Nodes terminate as finite batches |
| Author | Required | Output `KAIROS_REPORT_DIR/summary.json` at the end, with pipeline name, version, verdict, and metrics matching the implementation |
| Author | If additional Python dependencies | `requirements.txt` or installable `pyproject.toml`, including local wheels and helper packages; keep `uv.lock` synchronized with pyproject |
| Author | If OS dependencies | Manifest `requires.apt` / `requires.build_apt`; do not put runtime libraries only in build_apt |
| Author | If reading models or dictionaries | Bundle required files and reference them from code; the dependency installer does not fetch or place models |
| Author | If using GPU | `requires.gpu: true` and dependencies such as CUDA-enabled packages |
| Installer | Required | Build environment matching the target CPU architecture, Docker / Compose, access to dependency sources during build, and free image storage |
| Installer | If using GPU | NVIDIA GPU, driver, Container Toolkit, Compose support for `gpus`, and `PLUGIN_GPU=1` for both build and up |
| Author and installer | Required | A validation capture available to kairos, expected verdict and values, and verification of a real job's completion and artifacts |

`process(inputs, ctx)` alone does not run as a real dora node. The dora form requires a `dora.Node` event loop and startup entrypoint; add `process` when compatibility execution without dora is desired. The copied `hello_kairos/nodes/greet.py` and `writer.py` contain both implementations.

## Boundary between configuration and use

```text
dora_runner container
├─ /opt/venv/                 service and pinned shared runtime
├─ /app/plugins/<name>/      plugin definitions, code, and bundled files
└─ /opt/plugin-envs/<id>/    plugin-specific Python environment with extra dependencies
```

Python environments are isolated per plugin, while the container, OS libraries, and data mounts are shared. Introduce trusted code, do not modify input captures, and write outputs to the designated report area. This is not a sandbox that separates plugin permissions.

## 1. Scope and execution contract

Place custom pipelines in `services/dora_runner/plugins/<name>/` and incorporate them with `make build dora_runner` → `make up dora_runner`. They are registered at startup from the manifest, and the existing Validation screen generates the input form and `summary.json` result display. No core or frontend editing is required.

This is a **build-time dependency inclusion** method. There is no runtime pip installation, downloading from external repositories, or hot reloading of the plugin directory. Build the image in a network-enabled environment and transfer it to an offline execution environment.

Supported execution forms:

- `executor: dora` and `entrypoint.dataflow`: a dora graph of Python scripts / executable custom nodes. The actual image connects to the dedicated dora 0.5 coordinator/daemon and waits for completion.
- `executor: in_process` and `entrypoint.callable`: `module:function`. When Python dependencies are declared, it runs in a dedicated Python process and is not imported into the service itself.
- In a source environment without the dora CLI, a compatibility interpreter executes the graph in topological order. With dependencies, this also runs in a separate process using that environment.

This plugin contract targets custom nodes with a local `path`. Remote URL nodes and Python operator forms are rejected at build time. Executables must either be bundled within the plugin or provided by declared dependencies.

The baseline Python is the image's Python 3.12. Plugins requiring another Python major/minor version or OS are not automatically placed in separate containers.

## 2. Minimal structure

```text
plugins/my_validator/
  kairos_plugin.yaml
  dataflow.yml
  nodes/check.py
  requirements.txt             # when adding Python dependencies
```

```yaml
apiVersion: kairos.plugin/v1
id: my_validator
name: My validator
description: Check one capture.
executor: dora
version: 0.1.0
required_inputs: [capture_id]
params_schema:
  type: object
  properties:
    threshold: {type: number, default: 0.5}
outputs:
  - "report/my_validator/<capture_id>/summary.json"
entrypoint:
  dataflow: dataflow.yml
requires:
  gpu: false
  apt: []
  build_apt: []
```

`id` must match `^[a-z0-9_]+$` and must not duplicate another plugin or bundled pipeline. Unrecognized manifest fields or dependency requirements are errors.

```yaml
nodes:
  - id: check
    path: nodes/check.py
    inputs:
      tick: dora/timer/millis/100
```

Source nodes need a trigger such as a timer. Write results and exit as a finite batch.

### Node inputs and outputs

Each node receives job values as environment variables:

| Variable | Contents |
| --- | --- |
| `KAIROS_CAPTURE_ID` | Target UUIDv7 |
| `KAIROS_DATA_DIR` | Absolute path to the data root |
| `KAIROS_REPORT_DIR` | Report output directory for this pipeline and capture |
| `KAIROS_PARAMS_JSON` | JSON of validated parameters |

Nodes read `objects/<capture_id>/`; the terminal node generates `KAIROS_REPORT_DIR/summary.json`. The required result contract is `{pipeline, version, result, metrics, ...}`. `result` is `pass` or `fail`. Artifacts are returned as files under the report. Check the capture exists before creating the report directory; do not recreate a deleted capture.

Compatibility-interpreter node functions are `process(inputs, ctx) -> dict`; `ctx` has `plugin_id / capture_id / data_dir / params / report_dir`. A callable is `(capture_id, data_dir, params, report_dir) -> None` and writes the same summary.

Installed plugins are read-only. Create dora descriptors and logs in a writable job-specific temporary area without modifying the original source. Resolve node-relative paths from the original plugin location. Refer to attached files relative to `Path(__file__)`, rather than the working directory.

## 3. Python dependencies

### requirements.txt

```text
humanize==4.10.0
```

The plugin's `requirements.txt` is read at build time and installed into a dedicated venv. Resolve local wheels relative to the plugin directory. Pin versions for reproducible dependencies.

### pyproject.toml

When distributing as a Python package, place a buildable `pyproject.toml`. Install the project and its dependencies into the dedicated venv.

```toml
[build-system]
requires = ["hatchling==1.27.0"]
build-backend = "hatchling.build"

[project]
name = "my-validator-helpers"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["humanize==4.10.0"]

[tool.hatch.build.targets.wheel]
packages = ["my_helpers"]
```

Put the package in `my_helpers/` so nodes can import it. If `uv.lock` exists, extract pinned dependencies with `uv export --locked --no-dev --no-emit-project` and install them with the project. Stop the build if pyproject and lock disagree. If `requirements.txt` also exists, pass both to one resolution; inconsistencies are errors.

### Environment isolation and compatibility

- Create `/opt/plugin-envs/<id>/` for each plugin with additional dependencies; different plugins may use different versions of the same library.
- The dedicated venv references the image's pinned runtime packages. Added or overridden Python packages stay in that venv and do not alter the service or other plugins.
- Constrain `dora-rs`, `pyarrow`, and `kairos-common` to runtime versions to preserve dora communication and shared contracts.
- Plugins without dependency declarations, such as bundled hello examples, use the existing shared runtime.
- Save resolved versions in each venv's `requirements.resolved.txt`. Dynamic imports without declarations cannot be fully verified automatically, so also validate with an actual job run.
- A plugin with declarations but no built venv is not registered as available. Do not install it automatically at source-environment startup.

## 4. OS libraries and GPU

```yaml
requires:
  apt: [libmagic1]          # needed at build and runtime
  build_apt: [gcc]         # needed only to build Python extensions, etc.
  gpu: false
```

Declare OS dependencies by Debian package name (with version/architecture where needed). Fail Docker build if installation is impossible. OS libraries are shared by the image, with no venv-like version isolation; conflicting OS requirements cannot coexist. Do not add arbitrary apt repositories or install packages on the host.

GPU plugins set `requires.gpu: true` and explicitly run:

```bash
make build dora_runner PLUGIN_GPU=1
make up dora_runner PLUGIN_GPU=1
```

Make adds `compose/plugins.gpu.yaml`, permits GPU-dependent builds, and sets `gpus: all` on dora_runner at runtime. For continued use, set `PLUGIN_GPU=1` in `.env`. Do not add GPU requirements to the normal configuration. A build containing a GPU plugin without opt-in stops with the reason.

This assumes an NVIDIA GPU and NVIDIA Container Toolkit on the host. CUDA-compatible Python packages and similar dependencies are declared by the plugin. GPU hardware, drivers, and compatibility between GPU models are not installed or resolved automatically.

## 5. Build, execution, and failures

1. Place the manifest, nodes, and dependency declarations in the folder.
2. Run `make build dora_runner`, completing dependency installation and consistency checks.
3. Run `make up dora_runner`; the plugin is added to the Validation screen.
4. Select a validation capture, run it with inputs whose expected values are known, and check the result, metrics, and artifacts. The hello examples also require selecting a valid capture.

Do not ignore installation errors with `|| true`. A Python dependency resolution failure stops the build with an error containing the plugin name. Apply timeout/cancellation to plugin processes at runtime, and scope dora cleanup to that job name only. Do not stop other plugins or recordings together.

The bundled `hello_kairos` is a minimal greeting; `hello_dora` counts MCAP messages by topic. Dependency-enabled test examples are in `services/dora_runner/tests/fixtures/dependency_plugins/`. Test examples need not be included in the normal image.

`make test-plugin-dependencies` builds a test image with dependencies and verifies execution in containers without network access and with temporary data areas, covering different Python dependency versions, OS libraries, and packaged helpers.

## 6. Post-install checks and troubleshooting

1. Check startup and plugin-registration errors with `make logs dora_runner`.
2. Select the pipeline in the Validation screen and confirm that the specified form fields appear.
3. Run a known validation capture and check the verdict, metrics, and artifacts.
4. Check job completion, summary verdict and metrics, and artifacts such as images. Distinguish `result: fail` from a job failure caused by an exception or timeout.
5. Rebuild and recreate the image after changing code or dependencies; restarting alone does not include changes in the image.

| Symptom | What the user should check |
| --- | --- |
| Dependency resolution fails during build | Plugin name, package name and pinned version, Python 3.12 compatibility, and requirements/pyproject conflicts |
| `uv.lock` is stale | Confirm the intended dependency change, update the lock in the author's environment, place it with pyproject, and rebuild |
| Pipeline is not shown | Direct-child folder placement, valid manifest fields and id, rebuilt/recreated image, and registration errors |
| `ModuleNotFoundError` / missing shared library | Undeclared Python dependency, undeclared OS runtime dependency, and bundled-file path |
| No summary / job does not finish | Dora event loop, timer, terminal handling, output environment variable, and node exceptions |
| GPU requirement error | Build/up opt-in and host GPU preparation as well as the manifest |

`make test-plugin-dependencies` verifies the bundled dependency-test examples; it does not automatically cover added user plugins. Verify your plugin with the real job checks above.
