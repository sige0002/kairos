---
name: dora-rs
description: Build or debug dora dataflows and nodes, including kairos dora_runner plugins. Match CLI, YAML, and node APIs to the installed runtime.
---

# dora dataflows and kairos plugins

Check the runtime/package version and the relevant command's `--help` before
using version-sensitive CLI/YAML/API features. Upstream `main`, docs, registry
releases, and the image's pinned runtime can differ. Do not copy a dated
"latest version" table or infer command support from a major-version label.

The Python distribution is `dora-rs`; its import is `dora`. Use the installed
type stubs and version-matched examples for node event and Arrow payload APIs.
Declare output IDs and wire inputs as `<producer>/<output>`. For event-driven
sources, provide the required trigger. Verify payload shape and transport costs;
Arrow usage alone is not measured proof of end-to-end zero-copy.

## Kairos work

Use [plugin-contract.md](references/plugin-contract.md) for a new pipeline or
changes to loader/interpreter behavior. The canonical runnable example is
[hello_dora](../../../services/dora_runner/plugins/hello_dora/); full contracts
are [dora_plugins.md](../../../docs/specs/ja/dora_plugins.md) and
[dora_runner.md](../../../docs/specs/ja/dora_runner.md).

The dora_runner Dockerfile pins a CLI compatible with bundled bagflow nodes.
`fast_validation` / `full_validation` need those image binaries. Plugin graphs
also support the in-process fallback on source-only hosts. Verify which path
actually ran; a passing fallback test does not validate the CLI/daemon path.
Never recreate a missing capture while preparing a job or its report.

## Upstream work

Use the [official repository](https://github.com/dora-rs/dora) tag matching the
runtime for CLI definitions, schema, node stubs, and examples. The
[documentation site](https://dora-rs.ai) may describe a newer surface.
Consult registry release metadata only when choosing/installing a version; do
not change the repository's pinned runtime merely because a newer one exists.
For ROS bridge work, verify the version-specific bridge and type support instead
of assuming it behaves like kairos's rclpy services.
