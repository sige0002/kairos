#!/usr/bin/env bash
# System sampler for the overlap eval: every ~5s append epoch, total CPU
# (/proc/stat), disk I/O (/sys/block/$EVAL_DISK/stat, 512B sectors), and
# per-container CPU (docker stats one-shot). $1 = output log.
OUT="$1"
DISK="${EVAL_DISK:-nvme0n1}"
while :; do
  {
    echo "TS $(date +%s.%N)"
    grep '^cpu ' /proc/stat
    echo "DISK $(cat "/sys/block/$DISK/stat")"
    docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' 2>/dev/null
    echo "---"
  } >> "$OUT"
  sleep 5
done
