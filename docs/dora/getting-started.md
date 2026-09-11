<!-- AUTO-GENERATED from docs/dora/getting-started.ja.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# Getting started with dora (dora-rs)

> Audience: people using dora for the first time. This guide covers dora's concepts, a minimal Python node, and running a dataflow, then shows how these map to kairos's `dora_runner` design.
> Checked: 2026-06-24. Commands and APIs were verified against the official sources ([dora Book](https://dora-rs.ai/dora/)). dora is actively updated, so treat the official documentation as authoritative if anything differs.
> Related: [resources.md](resources.md) (a collection of verified resources), [dora_runner specification](../specs/en/dora_runner.md).

## 1. What is dora?

**dora (dora-rs / Dataflow-Oriented Robotic Architecture)** is middleware for building robotics and AI applications as **dataflows (directed graphs = pipelines)**. Its core is written in Rust; data between nodes is passed in **Apache Arrow** format, targeting low latency through shared-memory **zero-copy**.

The two key points for kairos are:

- **Split processing into nodes (components), then make a pipeline simply by wiring them in YAML** → validation, transformation, and AI processing are easy to replace and chain.
- **Nodes can be written in Python** → this works well with kairos's Python-based backend.

Official: https://github.com/dora-rs/dora / https://dora-rs.ai/

## 2. Core concepts

| Concept | Description |
| --- | --- |
| **Dataflow (YAML)** | The definition of the entire application. Declaratively specifies which nodes to connect and with what inputs and outputs. In kairos, 1 pipeline = 1 dataflow YAML. |
| **Node** | A processing unit that runs as an independent process (such as a Python script). It subscribes to `inputs` and publishes `outputs`. |
| **Operator** | A lightweight processing unit that runs inside the dora runtime. It is lighter because it does not split into a separate process. Starting with nodes is easier to understand. |
| **Input / Output** | Nodes connect through named inputs and outputs. The input side specifies which output of which node to subscribe to as `<node-id>/<output-name>`. |
| **Apache Arrow** | The format of data exchanged between nodes. In Python, use PyArrow (such as `pa.array(...)`). |

Dataflow YAML syntax: https://dora-rs.ai/dora/concepts/dataflow-yaml

## 3. Installation

```bash
# dora CLI (the dora command itself)
cargo install dora-cli

# Python node/operator API
pip install dora-rs        # PyPI package name is dora-rs; import name is dora
```

One-line installer (CLI only; cargo not required):

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/dora-rs/dora/releases/latest/download/dora-cli-installer.sh | sh
```

Verify:

```bash
dora --version
dora status
```

Source: https://dora-rs.ai/dora/getting-started/installation

## 4. Minimal Python node example (Hello World)

The minimal setup connects a sender node and a receiver node in one dataflow.

**sender.py** — sends 0–99 in order:

```python
import pyarrow as pa
from dora import Node

node = Node()
for i in range(100):
    node.send_output("message", pa.array([i]))
```

**receiver.py** — receives and displays them (event loop):

```python
from dora import Node

node = Node()
for event in node:
    if event["type"] == "INPUT":
        values = event["value"].to_pylist()
        print(f"Received {event['id']}: {values}")
    elif event["type"] == "STOP":
        break
```

**dataflow.yml** — wires the two nodes together:

```yaml
nodes:
  - id: sender
    path: sender.py
    outputs:
      - message

  - id: receiver
    path: receiver.py
    inputs:
      message: sender/message      # Connect the sender's "message" output to the receiver's "message" input
```

Key points:

- A node starts with `from dora import Node` → `node = Node()`, then receives events with `for event in node:`.
- Events have a type (`INPUT` = input arrival, `STOP` = stop request). Use `event["id"]` to identify the input; `event["value"]` is Arrow data.
- Outputs use `node.send_output("<output name>", <pyarrow array>)`.

Source: https://dora-rs.ai/dora/getting-started/quickstart

## 5. Running a dataflow (dora CLI)

The shortest way to run one locally:

```bash
dora run dataflow.yml
```

For distributed or persistent execution (operations-oriented):

```bash
dora up                      # Start the coordinator / daemon
dora start dataflow.yml      # Start the dataflow
dora stop                    # Stop
```

> If you want separate dependency environments per node, use the YAML `build:` specification or per-node environment management with `--uv` (there is an example in `examples/python-dataflow`). dora's own recording/replay uses the `.drec` format (dora-specific); note that it is **not MCAP**.

## 6. Mapping to kairos `dora_runner`

The commands up to the previous section are for a standalone dora introduction. kairos uses a dedicated coordinator/daemon and build-time dependency management, so follow the [user instructions](../../services/dora_runner/plugins/README.md) for plugin installation.

kairos's `dora_runner` is a container that "runs validation, transformation, and AI as asynchronous jobs, with recorded MCAP as input." dora concepts correspond as follows (see the [dora_runner specification](../specs/en/dora_runner.md) for details).

| dora | kairos `dora_runner` |
| --- | --- |
| Dataflow (YAML) | A dora-format pipeline. Used for built-in bagflow validation and custom plugins. Pipelines can also use the Python callable form. |
| Node | A local custom node in the dataflow. kairos automatically registers pipelines with `kairos_plugin.yaml`, rather than individual nodes. |
| Input / Output | Pass `KAIROS_CAPTURE_ID` / `KAIROS_DATA_DIR` / `KAIROS_REPORT_DIR` / `KAIROS_PARAMS_JSON` to nodes. The author implements MCAP loading and inter-node communication, then outputs a summary at the end. |
| Operator | Unsupported by kairos's current plugin contract. Use a custom node with a local `path`. |

### Reading MCAP (important)

The input is **recorded MCAP**. Do not use dora's ROS2 bridge (for live DDS) or `.drec` replay; **read MCAP directly with `mcap` + `mcap-ros2-support` (`rclpy` is not required)**. Topic filters and time ranges can be specified directly through the arguments to `read_ros2_messages()`:

```python
# Image of an MCAP Loader node (conceptual example)
from mcap_ros2.reader import read_ros2_messages

for msg in read_ros2_messages(
    "/data/objects/<capture_id>/<capture_id>_0.mcap",
    topics=["/joint_states", "/camera/head/image_raw"],  # Only the required topics
    # start_time / end_time can also specify a time range
):
    decoded = msg.ros_msg          # Decoded ROS2 message
    topic = msg.channel.topic
    t = msg.log_time
    # ... Convert to Arrow and send to validator / converter / AI nodes
```

If you only need metadata (topic list, types, timestamps, and size), scan with the low-level reader in the `mcap` package without decoding. kairos's `fast_validation` has bagflow's `topic-presence` node compare topic names and types in `metadata.yaml`; it does not decode the MCAP body.

Source: https://mcap.dev/docs/python/mcap-ros2-apidoc/mcap_ros2.reader

### Adding AI nodes as first-class citizens

Wire inference, automatic annotation, quality scoring, and training-dataset conversion (for example, **LeRobot** format) as **AI dora nodes**. Examples to follow are inference nodes from dora-hub (such as `dora-yolo`) and `examples/python-yolo-detection`; for dataset conversion, use `dora-lerobot` (see [resources.md](resources.md)).

For authors of custom AI plugins:

- Models are expected to be replaceable (such as `params.model`).
- Provide model files and Python/OS dependencies. GPU use requires `requires.gpu: true`, `PLUGIN_GPU=1`, and a host GPU environment.
- For reproducibility, record pipeline, node, and model versions in `report`.

### What is currently available in kairos

Built-in pipelines are `fast_validation` / `full_validation` / `loss_report` / `clock_check` / `video_check` / `signal_report`. `hello_dora` / `hello_kairos` are included as examples, and custom plugins can be built and registered with their dependencies. `dataset_convert` / `dataset_validation` are not implemented; arbitrary LeRobot exporters are separate services.

See the [plugin specification](../specs/en/dora_plugins.md) for dependency isolation, the Python 3.12 prerequisite, and checking actual jobs.

---

## Summary

1. dora is a dataflow platform that wires nodes in YAML. Python nodes can be written.
2. A node can be written with three elements: `Node()` + `for event in node:` + `send_output(...)`.
3. Run it with `dora run dataflow.yml`.
4. kairos registers plugins at the pipeline level and treats node inputs/outputs and the summary in the dataflow as the contract. **MCAP is not a dora feature; read it directly with `mcap`-family libraries**. AI nodes are treated as first-class citizens.
