#!/usr/bin/env python3
"""Compare the overlap-eval scenarios: per-topic recorded Hz, drops, CPU, disk.

Reads OUT_DIR (default /tmp/kairos_overlap_eval) for run_<S>.txt / sample_<S>.log
/ rsync_<S>.log written by scenario.sh, and each run's metadata.yaml +
manifest.json under <repo>/data/recorded. See README.md for the protocol.
"""

import json
import os
import re
from pathlib import Path

import yaml

OUT = Path(os.environ.get("OUT_DIR", "/tmp/kairos_overlap_eval"))
REPO = Path(__file__).resolve().parents[3]
REC = REPO / "data" / "recorded"
SCN = [p.stem.removeprefix("run_") for p in sorted(OUT.glob("run_*.txt"))]
BASE = SCN[0] if SCN else "A"  # first scenario (alphabetical) is the baseline

runs, hz, meta = {}, {}, {}
for s in SCN:
    rid = (OUT / f"run_{s}.txt").read_text().strip()
    runs[s] = rid
    m = yaml.safe_load((REC / rid / "metadata.yaml").open())[
        "rosbag2_bagfile_information"
    ]
    dur = m["duration"]["nanoseconds"] / 1e9
    manifest = json.load((REC / rid / "manifest.json").open())
    meta[s] = {
        "dur": dur,
        "msgs": m["message_count"],
        "dropped": manifest.get("dropped_messages"),
        "integrity": manifest.get("integrity"),
    }
    hz[s] = {
        t["topic_metadata"]["name"]: t["message_count"] / dur
        for t in m["topics_with_message_count"]
    }

print("== runs ==")
for s in SCN:
    mm = meta[s]
    print(
        f"{s} {runs[s]}  dur={mm['dur']:.1f}s msgs={mm['msgs']}"
        f" dropped={mm['dropped']} integrity={mm['integrity']}"
    )

common = sorted(
    set.intersection(*(set(hz[s]) for s in SCN)), key=lambda t: -hz[BASE][t]
)
print(f"\n== per-topic recorded Hz (top 15 of {len(common)} common topics) ==")
header = f"{'topic':52s} " + " ".join(f"{s:>8s}" for s in SCN)
print(header + "  vs " + BASE)
worst = dict.fromkeys(SCN, 0.0)
for t in common[:15]:
    base = hz[BASE][t]
    cells = " ".join(f"{hz[s][t]:8.2f}" for s in SCN)
    deltas = " ".join(f"{(hz[s][t] / base - 1) * 100:+5.1f}%" for s in SCN if s != BASE)
    print(f"{t[:52]:52s} {cells}  {deltas}")
# Worst regression across ALL common topics with baseline >= 5 Hz.
for t in common:
    base = hz[BASE][t]
    if base < 5:
        continue
    for s in SCN:
        worst[s] = min(worst[s], (hz[s][t] / base - 1) * 100)
print(
    "\nworst-topic regression (baseline>=5Hz): "
    + "  ".join(f"{s}={worst[s]:+.1f}%" for s in SCN if s != BASE)
)


def parse_sampler(path: Path):
    """(cpu_busy_pct, disk_rd_MBps, disk_wr_MBps, {container: avg_cpu_pct})."""
    cpu_pairs, disk_pairs, containers = [], [], {}
    ts = None
    for line in path.read_text().splitlines():
        if line.startswith("TS "):
            ts = float(line.split()[1])
        elif line.startswith("cpu "):
            f = [int(x) for x in line.split()[1:]]
            cpu_pairs.append((ts, sum(f), f[3] + f[4]))  # total, idle+iowait
        elif line.startswith("DISK "):
            f = [int(x) for x in line.split()[1:]]
            # /sys/block stat: rd_sectors=f[2], wr_sectors=f[6] (512B sectors)
            disk_pairs.append((ts, f[2] * 512, f[6] * 512))
        elif re.match(r"^kairos-\S+ ", line):
            name, pct = line.split()[:2]
            containers.setdefault(name, []).append(float(pct.rstrip("%")))
    total = cpu_pairs[-1][1] - cpu_pairs[0][1]
    idle = cpu_pairs[-1][2] - cpu_pairs[0][2]
    span = disk_pairs[-1][0] - disk_pairs[0][0]
    rd = (disk_pairs[-1][1] - disk_pairs[0][1]) / span / 1e6
    wr = (disk_pairs[-1][2] - disk_pairs[0][2]) / span / 1e6
    cavg = {n: sum(v) / len(v) for n, v in containers.items()}
    return (1 - idle / total) * 100, rd, wr, cavg


print("\n== system load (window average) ==")
for s in SCN:
    busy, rd, wr, cavg = parse_sampler(OUT / f"sample_{s}.log")
    rec = cavg.get("kairos-recorder-1", 0)
    mon = cavg.get("kairos-monitor-1", 0)
    print(
        f"{s} cpu_busy={busy:5.1f}%  disk rd={rd:6.1f} wr={wr:6.1f} MB/s"
        f"  recorder={rec:.1f}% monitor={mon:.1f}%"
    )

print("\n== rsync passes ==")
for s in SCN:
    log = OUT / f"rsync_{s}.log"
    if not log.exists():
        continue
    passes = re.findall(r"PASS (\d+) size_mb=(\d+) elapsed=([\d.]+)s", log.read_text())
    if passes:
        els = [float(e) for _, _, e in passes]
        thr = [int(mb) / e for _, mb, e in passes]
        print(
            f"{s}: {len(passes)} full passes, avg {sum(els) / len(els):.1f}s/pass"
            f" = {sum(thr) / len(thr):.0f} MB/s effective"
        )
    else:
        print(f"{s}: 0 completed passes (still mid-first-pass at window end)")
