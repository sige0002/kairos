<!-- AUTO-GENERATED from docs/dora/resources.ja.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# dora (dora-rs) reference resources

> Purpose: a list of **verified existing** dora ecosystem materials for designing and implementing kairos's `dora_runner` service (a post processing pipeline that takes recorded MCAP as input and runs validation, transformation, and AI processing as a dora dataflow).
> Checked: 2026-06-24. Each URL was verified to exist through web retrieval. dora is actively developed, so its APIs and documentation structure may change (Node Hub in particular is considered unstable). If a link breaks, start from the [dora-rs org](https://github.com/dora-rs).
> Related: [getting-started.md](getting-started.md), [dora_runner specification](../specs/en/dora_runner.md).

## 1. Official repositories / documentation

| Resource | URL | Use in kairos |
| --- | --- | --- |
| dora main repository | https://github.com/dora-rs/dora | The dora source of truth. CLI, language APIs, examples, and the ROS2 bridge are consolidated in one repository. `apis/python/node` implements the Python node API. |
| dora official site (landing) | https://dora-rs.ai/ | Entry point for overview, performance comparisons ("zero-copy shared memory" / Apache Arrow), and documentation. |
| dora Book (official guide) | https://dora-rs.ai/dora/ | Current source guide. Chapters cover Getting Started / Concepts / Language APIs / Operations / Advanced / Dora Hub / Development. The primary source for kairos implementation. |
| Installation instructions | https://dora-rs.ai/dora/getting-started/installation | `cargo install dora-cli` + `pip install dora-rs`, one-line installer, and source build instructions. Basis for writing the `dora_runner` Dockerfile. |
| Quick Start | https://dora-rs.ai/dora/getting-started/quickstart | Minimal Python sender/receiver nodes + dataflow.yml + `dora run`. Directly useful for initial verification. |
| Dataflow YAML concepts | https://dora-rs.ai/dora/concepts/dataflow-yaml | `id` / `path` / `inputs` / `outputs` syntax for nodes. Basis for the dataflow YAML managed by kairos's Pipeline Registry. |
| Rust node API reference | https://docs.rs/dora-node-api | Node API on the Rust side. kairos's backend assumes Python, but this is a reference when converting performance-critical nodes to Rust. |

> Note: The documentation has two systems: `dora-rs.ai/dora/...` (the Book and source) and `dora-rs.ai/docs/...` (a separate guide/node-list site). If information conflicts, **prioritize the Book (`/dora/`)**, and ultimately treat repository source/README files as authoritative.

## 2. Python node examples (templates for kairos MCAP Loader / validator / converter nodes)

| Resource | URL | Use in kairos |
| --- | --- | --- |
| python-dataflow example | https://github.com/dora-rs/dora/tree/main/examples/python-dataflow | `sender.py` / `transformer.py` / `receiver.py` + `dataflow.yml`. A minimal example of multiple inputs, PyArrow arrays, StructArray, and event types (INPUT/STOP). An ideal template for kairos node I/O contracts (passing `metrics` / `artifacts` / `report` downstream). |
| Entire examples directory | https://github.com/dora-rs/dora/tree/main/examples | Verified examples: `python-dataflow` / `rust-dataflow` / `benchmark` / `ros2-bridge` / `ros2-comparison` / `multiple-daemons` / `python-yolo-detection` / `cuda-benchmark`. A catalog of pipeline patterns. |
| Python YOLO detection example | https://github.com/dora-rs/dora/tree/main/examples/python-yolo-detection | Typical AI node structure: image input → inference → detection-result output. A minimal model for kairos's design of adding AI nodes as first-class citizens. |

## 3. Node Hub (reusable node catalog)

| Resource | URL | Use in kairos |
| --- | --- | --- |
| dora-hub (community node collection) | https://github.com/dora-rs/dora-hub | A mechanism for importing ready-made nodes with one-line YAML (`hub: <node>@<version>`). Separate repository from dora itself. Reference for external nodes. kairos does not automatically fetch from Hub; integrate them in the corresponding local `path` form. |
| Dora Hub overview (Book) | https://dora-rs.ai/dora/hub/overview | Node Hub usage, node manifests, reproducible builds, and publishing. Design reference when kairos distributes custom nodes. |

Main ready-made nodes (confirmed in dora-hub and useful as kairos AI-node candidates):

- **AI/ML**: `dora-yolo` (object detection), `dora-sam2` (segmentation), `dora-distil-whisper` (speech → text), `dora-qwen` / `dora-qwen2-5-vl` (LLM / VLM), `dora-rdt-1b` (robotic diffusion transformer).
- **Sensors/cameras**: PyRealsense, PyOrbbecSDK, OpenCV Video Capture, Kornia GST/V4L Capture.
- **Visualization**: `opencv-plot`, Rerun (`dora-rerun`).
- **Training data collection**: `llama-factory-recorder` (recording data for LLM/VLM training).

> kairos's input is **recorded MCAP**, so live acquisition nodes for cameras and similar devices cannot be used as-is. Inference nodes such as `dora-yolo` / `dora-sam2`, however, **can be reused by feeding them images extracted from MCAP** as the input (a foundation for automatic-annotation / quality-scoring nodes).

## 4. ROS2 integration

| Resource | URL | Use in kairos |
| --- | --- | --- |
| dora ROS2 bridge (in the main repository) | https://github.com/dora-rs/dora/tree/main/libraries/extensions/ros2-bridge | Bidirectional dora ⇔ ROS2 bridge (experimental). Apache Arrow native conversion and QoS mapping. For bringing **live ROS2 topics (DDS)** into a dataflow. |
| Former dora-ros2-bridge repository (archived) | https://github.com/dora-rs/dora-ros2-bridge | Integrated and archived into the above. Historical reference only; consult the main repository for new work. |
| ROS2 Bridge explanation (discussion) | https://github.com/orgs/dora-rs/discussions/306 | Background on the bridge's design intent and DDS reception policy. |

> Important: **dora's ROS2 bridge targets “live ROS2 topics”** and **does not read recorded MCAP files**. kairos post recording processing reads files without the bridge. Python plugins can read MCAP using `mcap` + `mcap-ros2-support` (`rclpy` is unnecessary). Built-in fast/full validation uses bagflow Rust nodes, and fast checks metadata only. In kairos this bridge remains an option for adding live ingestion in the future.

## 5. Reading MCAP (libraries directly used by kairos's MCAP Loader)

| Resource | URL | Use in kairos |
| --- | --- | --- |
| MCAP Python reader (general) | https://mcap.dev/docs/python/mcap-apidoc/mcap.reader | Low-level reader in the `mcap` package. Used for metadata scans without decoding, such as obtaining topics / types / timestamps / size (for Python plugin loading; built-in fast validation uses metadata). |
| mcap-ros2-support reader | https://mcap.dev/docs/python/mcap-ros2-apidoc/mcap_ros2.reader | Iterates while decoding ROS2 messages with `read_ros2_messages(source, topics=..., start_time=..., end_time=...)`. Topic filters and time ranges are arguments, directly satisfying kairos's node I/O contract of an “MCAP message iterator (with topic filters and time ranges)”. |

> dora's own recording/replay uses the **`.drec` format** (dora-specific record/replay nodes), **not MCAP**. kairos fixes MCAP as the canonical recording, so it does not depend on dora recording/replay and reads with the `mcap` family of libraries above.

## 6. AI / training-dataset conversion (LeRobot integration)

| Resource | URL | Use in kairos |
| --- | --- | --- |
| dora-lerobot | https://github.com/dora-rs/dora-lerobot | Pipeline collection for operating, recording, and replaying LeRobot-compatible hardware (arms and cameras) with dora, handling it in **LeRobot dataset format**. Examples such as Aloha and Reachy are under robots/. The strongest reference implementation for a kairos `dataset_convert` (MCAP → LeRobot format) node. |
| HuggingFace LeRobot main repository | https://github.com/huggingface/lerobot | The authority for LeRobot dataset format, training (such as ACT), and inference. Source specification for the “training dataset format” output by kairos. |
| dora-record → LeRobot conversion PR (#197, **closed**) | https://github.com/huggingface/lerobot/pull/197 | Initial PR for a script converting dora-record data to LeRobot format. **Not merged and replaced by #201**. Reference for the conversion approach at that time; check the follow-up for the implementation. |

> Position in kairos: built-in `dataset_convert` is not implemented; “MCAP (canonical) → LeRobot format” is a future extension. Arbitrary LeRobot exporters are separate services. The authority for LeRobot format is HuggingFace; consult dora-lerobot for dora conversion patterns. Build it to match kairos's AI-node contract of replaceable `params.model`, GPU use, and recording versions in `report`.

## 7. Supplementary / community materials (not primary sources, but helpful)

| Resource | URL | Caution |
| --- | --- | --- |
| DeepWiki: dora-rs/dora | https://deepwiki.com/dora-rs/dora | Automatically generated explanatory wiki. Convenient for understanding the big picture, but **not a primary source**. Verify implementation decisions with the official Book / source. |
| DeepWiki: node-hub | https://deepwiki.com/dora-rs/node-hub | Overview of the node-development flow. Same caution as above. |
| FOSDEM 2024 slides | https://archive.fosdem.org/2024/events/attachments/fosdem-2024-3225-dora-rs-simplifying-robotics-stack-for-next-gen-robots/slides/22303/dora-fosdem_05S0HAi.pdf | Presentation of dora's design philosophy (2024), for background. Content reflects that time. |

---

## Mapping summary for kairos `dora_runner`

- **Node template** → Start with `examples/python-dataflow`, accept capture ID, paths, and params according to the [current plugin contract](../specs/en/dora_plugins.md), and have the author implement loading, communication, and summary output.
- **MCAP reading** → a `mcap` + `mcap-ros2-support` capability rather than a dora feature ([section 5](#5-reading-mcap-libraries-directly-used-by-kairos-s-mcap-loader)). Do not use the ROS2 bridge.
- **AI node** → Use dora-hub inference nodes (such as `dora-yolo`) and the `python-yolo-detection` example as models, implementing a node whose `params.model` can be replaced.
- **dataset_convert** → Refer to dora-lerobot + HuggingFace LeRobot.
- **Dataflow connections** → Follow the notation on the Dataflow YAML concepts page; the Pipeline Registry manages the YAML.
