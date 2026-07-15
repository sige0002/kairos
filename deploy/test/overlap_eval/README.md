# Transfer × recording overlap evaluation

Measures the split deploy's worst-load case: an importer rsync pull (a previous
run leaving the robot's disk over ssh) **overlapping an active recording** on
the same host. The primary criterion is deployment_topology §5's: recorded
topic frequency must not drop (>1% = NO-GO); secondary: recorder
`dropped_messages` / `integrity` (manifest.json), CPU, disk throughput.

Three scenarios, each a fresh 120 s recording window inside one pass of a
441 s sample bag replay (no loop restart inside the window):

| scenario | concurrent transfer |
|---|---|
| A | none (baseline) |
| B | rsync pull loop, unlimited (pessimistic hammer) |
| C | rsync pull loop, `--bwlimit` 20 MB/s (real-link intensity) |

The pull loops over **loopback ssh** (this host is both robot and puller), so
ssh crypto CPU is double-counted and disk read+write land on one device —
deliberately pessimistic. The one component loopback cannot exercise is real
NIC/WiFi contention; that affects the WebRTC preview's latency, not the
recording (recording never rides the NIC in the split), and needs a two-host
run to quantify.

## Measured 2026-07-16 (gx10, NVMe, wired-GbE class; robot role of the split)

Load: sample bag 064423 replay (+ a second bag loop that happened to be
running — recording rate was effectively doubled to ~2.6 k msg/s; more
pessimism, constant across scenarios).

| | A baseline | B unlimited | C 20 MB/s |
|---|---|---|---|
| messages recorded (120 s) | 155,349 | 155,405 | 155,256 |
| dropped_messages | 0 | **0** | **0** |
| integrity | ok | **ok** | **ok** |
| worst-topic rate vs A (≥5 Hz, 22 topics) | — | **−0.1 %** | **−0.2 %** |
| host CPU busy | 4.1 % | 16.3 % | 4.5 % |
| transfer effective rate | — | **715 MB/s** (32×2.6 GB passes) | 20 MB/s |

**Verdict: GO.** At 30–60× the intensity any real link can produce, recording
was unaffected. `BWLIMIT` is therefore a *preview-protection* lever for thin
links (WiFi/Tailscale), not a recording-protection one. **Rerun this on the
real robot before relying on it there** (an HSR-class onboard PC has less CPU
headroom and possibly slower storage than this box):

```
# on the robot host, with the kairos stack up and a sample bag under data/:
ssh-keygen -t ed25519 -f /tmp/eval_key -N '' -C overlap-eval
cat /tmp/eval_key.pub >> ~/.ssh/authorized_keys       # remove after the eval
EVAL_SSH_KEY=/tmp/eval_key bash deploy/test/overlap_eval/scenario.sh A none
EVAL_SSH_KEY=/tmp/eval_key bash deploy/test/overlap_eval/scenario.sh B 0
EVAL_SSH_KEY=/tmp/eval_key bash deploy/test/overlap_eval/scenario.sh C 20000
python3 deploy/test/overlap_eval/analyze.py
# cleanup: delete the three runs via DELETE /api/v1/runs/<id>, remove the key
# line from ~/.ssh/authorized_keys, rm -rf $OUT_DIR
```

Knobs (env): `BAG` (default `airoa-moma-mcap/064423`), `EVAL_SRC` (transfer
corpus; default the same bag dir), `EVAL_SSH` (pull peer; default
`$USER@127.0.0.1` — point it at a second host for the NIC-real variant),
`EVAL_DISK` (default `nvme0n1`), `OUT_DIR` (default
`/tmp/kairos_overlap_eval`), `RECORD_S` (default 120), `ORCH` (default
`http://localhost:8000`).
