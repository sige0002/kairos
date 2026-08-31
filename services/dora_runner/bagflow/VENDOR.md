# Vendored: bagflow + mcap2dora

## License status — redistribution blocked

The two referenced upstream revisions do not contain a `LICENSE`, `COPYING`, or
equivalent permission grant, and the additional uncommitted changes have no
separate provenance record. Therefore this directory is **not covered by the
repository's Apache-2.0 license** and must not be redistributed, nor used to
publish derived images or binaries, until all copyright holders provide an
explicit license. A release gate deliberately refuses to publish while the two
upstream license files are absent. Do not infer permission from repository
visibility or from dependency licenses.

To clear the block, obtain the license/provenance for both sources, store each
verbatim license and required copyright notice in this directory, identify the
authors and permission for the uncommitted deltas, and update `NOTICE` after a
review. If permission cannot be obtained, remove or replace this code before a
public release.

This directory is a **vendored copy** of two upstream repositories, built into the
`dora_runner` image and used by the `fast_validation` / `full_validation`
pipelines — every validation kairos performs runs on this code. They are vendored
rather than referenced as submodules/clones so that a kairos checkout builds a
runnable image with no extra fetch step (user ruling, 2026-07-26).

| Source | Upstream | Vendored from |
|---|---|---|
| `Cargo.toml`, `crates/bagflow-*`, `python/` | https://github.com/sige0002/bagflow | commit `9c0ef75` **plus the uncommitted working tree** at `~/bagflow` on 2026-07-26 |
| `crates/mcap2dora/` | https://github.com/sige0002/mcap2dora | commit `1249b6d` **plus the uncommitted working tree** at `~/mcap2dora` on 2026-07-26 |

Both upstreams are research/experiment repos; kairos is now the place where this
code ships. Upstream `README.md` (Japanese) is kept next to this file as the
framework's own documentation — how kairos *uses* it is specified in
`docs/specs/ja/dora_runner.md`.

## What was changed while vendoring

1. **`crates/mcap2dora/` became a workspace member.** Upstream `bagflow-source`
   depends on a sibling checkout (`path = "../../../mcap2dora"`); here it is
   `path = "../mcap2dora"`. mcap2dora's own `[profile.release]` was dropped
   (ignored — and warned about — in a non-root manifest).
2. **`crates/bagflow-decode-cuda` is not vendored.** The nvJPEG PoC measured
   *slower* than the CPU decoder on small images (4.1 s vs 0.35 s on the
   reference bag) and only pays off with a batch API + pinned memory. Re-vendor
   it from upstream if that work lands.
3. **`nodes/` (the Python reference check nodes) are not vendored.** They need
   `pyarrow` + `dora-rs` + `opencv` in the image; the Rust nodes are the
   production default and ~10x cheaper in CPU time. Consequence: a flow may only
   use the bundled Rust binaries (or an absolute path to something the operator
   installed). See "Python nodes" below.
4. **`crates/bagflow-cli` gained two kairos-driven options** (marked
   `kairos vendoring` in the source):
   - `--name <NAME>` — passed through to `dora start --name`, so cleanup after a
     timeout is `dora stop --name <job_id>` instead of guessing from `dora list`.
   - `DORA_COORDINATOR_ADDR` / `DORA_COORDINATOR_PORT` — every `dora` subcommand
     the CLI shells out to gets `--coordinator-addr/--coordinator-port`. dora
     0.5's `dora up` cannot bind a custom port, so with a non-default endpoint
     the CLI refuses to fall back to `dora up` and tells you to start
     `dora coordinator` / `dora daemon` yourself (dora_runner does that at
     service start). Without this, a bagflow run on a host that also runs any
     other dora would talk to *whatever* answers on 127.0.0.1:6012.
5. **A new check node: `bagflow-topic-presence`** (`crates/bagflow-checks/src/bin/
   topic_presence.rs`). kairos' `fast_validation` gate asks a question upstream
   has no node for: *are the topics this recording template declares mandatory in
   the bag, with the message type it declares* — glob names, optional type, and
   **0-message topics count as present** (a "record everything" bag legitimately
   carries dozens of empty service-result topics, which `bagflow-topic-rate`
   fails by design). Judged from the metadata inventory, subscribing to nothing.
6. **`BAGFLOW_TOPIC_TYPES` is injected into every node's env** by the CLI, next
   to the existing `BAGFLOW_EXPECTED` (counts): the same `metadata.yaml` table,
   message type instead of message count. Needed by the node above; harmless to
   nodes that ignore it.
7. **A metadata-only flow is legal.** Upstream bails with "no rostopic inputs —
   at least one node must subscribe to a bag topic"; a flow whose checks read
   only the inventory (`-topic-presence`, `-topic-rate`) is now accepted and
   prints a note instead. `bagflow-source` additionally **skips the bag scan
   entirely** when nothing is subscribed — otherwise it would walk every message
   only to discard it (seconds on a multi-GB recording), which would defeat the
   point of the fast gate.

## Re-syncing with upstream

```bash
# from a fresh upstream checkout
cp -r ~/bagflow/crates/bagflow-*  services/dora_runner/bagflow/crates/
cp    ~/bagflow/Cargo.lock ~/bagflow/README.md services/dora_runner/bagflow/
cp -r ~/bagflow/python    services/dora_runner/bagflow/python
cp -r ~/mcap2dora/src ~/mcap2dora/tests services/dora_runner/bagflow/crates/mcap2dora/
```

Then re-apply the seven changes above (`git diff` against the previous vendored
tree is the quickest check — the kairos-added source carries a `kairos vendoring`
marker comment) and rebuild:
`make rebuild dora_runner`.

## Python nodes

`bagflow` embeds `python/bagflow/__init__.py` in the CLI binary
(`include_str!`) and writes it into each run's `.bagflow/pylib`, so a Python node
would find its helper — but the image installs neither `pyarrow` nor `dora-rs`,
so a flow that points at a `.py` node fails at node start. Adding them is a
deliberate size/scope decision, not an oversight; the Rust nodes cover every
bundled check with an identical contract.
