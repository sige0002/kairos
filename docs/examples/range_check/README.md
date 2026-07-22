# Practice #2: numeric range-check (your own dora validator)

> Verified working (2026-07-22; an adversarial agent built it from the docs alone and
> proved the full event round-trip). The numeric-side twin of the
> [grayscale example](../grayscale/README.md) (images / frames lane).

## What it teaches

- **Bolt on numeric validation via public APIs only**: ① poll `GET :8006/fields` +
  `GET :8006/sample` (probe-compat API) → ② apply a range rule → ③ POST the verdict to
  `POST :8005/internal/analysis/events` → ④ anyone reads it via
  `GET :8005/live/events?since=`. No kairos file is ever modified (proven).
- **The event `t` key contract**: `/live/events?since=` filters on each event's `t`
  (epoch seconds). If you omit `t` the server stamps arrival time for you
  (still good manners to set it yourself).

## Run

```bash
docker run --rm --network host \
  -v $PWD/docs/examples/range_check:/example:ro \
  --entrypoint bash kairos-dora-live:jazzy -lc \
  "mkdir -p /tmp/ex && cp /example/dataflow.yml /tmp/ex/ && cd /tmp/ex && \
   /opt/venv/bin/dora run dataflow.yml"
# in another terminal, read the verdicts:
curl -s "localhost:8005/live/events?since=0" | python3 -m json.tool
```

Env: `TOPIC` (default `/left_arm_controller/joint_states`) / `FIELD` (empty =
auto-pick the first numeric field) / `LO`,`HI` (allowed range; defaults always fire, on purpose).

## Caveats (the grayscale pitfalls + 1)

1. dora runs `.py` with the system python — the `run_node.sh` wrapper is mandatory
2. `dora run` writes next to the dataflow — copy the yml somewhere writable
3. The event ring is **non-persistent** (in-memory, 500 entries, wiped on dora_live
   restart). Verdicts that must survive belong in post-recording dora_runner
   pipelines under the current design
