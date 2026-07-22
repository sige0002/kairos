#!/usr/bin/env bash
# =============================================================================
# kairos load overview (`make load`) — every number a load discussion needs,
# with explicit denominators:
#   * CPU: machine-wide busy%, loadavg, and per-container %/core AND %/machine
#     (docker stats alone reports 100% = ONE core, which reads alarming on a
#     many-core host — 400% on a 64-thread Xeon is ~6% of the machine).
#   * LAN: per physical NIC, measured RX/TX MB/s against the link speed
#     (utilization %) — the "is the wire the bottleneck" answer for split mode.
#   * Live DDS bandwidth: what the monitored topics actually carry
#     (sum of the monitor's per-topic bandwidth_bps; honest source, not a guess).
#   * Recording disk: free space on the data volume (the recorder refuses to
#     start below its MIN_FREE_BYTES floor — "no space" shows up as a morning
#     line-down, so it belongs on the load view).
# =============================================================================
set -uo pipefail

NPROC="$(nproc)"

# ---- 1 s sample window (CPU busy% + NIC throughput share one sleep) ---------
cpu_snap() { awk '/^cpu /{print $2+$3+$4+$7+$8+$9, $5+$6}' /proc/stat; }
phys_ifs() {
    for d in /sys/class/net/*; do
        i="$(basename "$d")"
        [ -e "$d/device" ] && echo "$i"
    done
}
net_snap() { # if -> "rx tx"
    awk -v ifname="$1" -F'[: ]+' '$0 ~ ifname":" {sub(/^ */,""); print $2, $10}' /proc/net/dev
}

read CPU_BUSY0 CPU_IDLE0 <<<"$(cpu_snap)"
declare -A RX0 TX0
IFS=$'\n'
for i in $(phys_ifs); do
    read -r r t <<<"$(net_snap "$i")" || continue
    RX0[$i]="${r:-0}"; TX0[$i]="${t:-0}"
done
unset IFS
sleep 1
read CPU_BUSY1 CPU_IDLE1 <<<"$(cpu_snap)"

# ---- CPU --------------------------------------------------------------------
BUSY=$((CPU_BUSY1 - CPU_BUSY0)); IDLE=$((CPU_IDLE1 - CPU_IDLE0))
TOTALT=$((BUSY + IDLE))
MACHINE_PCT=0
[ "$TOTALT" -gt 0 ] && MACHINE_PCT=$(awk -v b="$BUSY" -v t="$TOTALT" 'BEGIN{printf "%.1f", 100*b/t}')
echo "== CPU  (machine: ${NPROC} threads, busy ${MACHINE_PCT}%  loadavg $(cut -d' ' -f1-3 /proc/loadavg))"
docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}' \
    | grep kairos | sort -t"$(printf '\t')" -k2 -rn \
    | awk -F'\t' -v n="$NPROC" '{v=$2; sub(/%/,"",v); total+=v; mem=$3; sub(/ \/.*/,"",mem); \
        printf "  %-34s %8.1f%%/core %6.2f%%/machine  mem=%-10s pids=%s\n", $1, v, v/n, mem, $4} \
        END {printf "  %-34s %8.1f%%/core %6.2f%%/machine\n", "TOTAL (kairos)", total, total/n}'

# ---- LAN --------------------------------------------------------------------
echo "== LAN  (per physical NIC, 1 s sample; util = max(rx,tx) vs link speed)"
IFS=$'\n'
for i in $(phys_ifs); do
    read -r r1 t1 <<<"$(net_snap "$i")" || continue
    r0="${RX0[$i]:-$r1}"; t0="${TX0[$i]:-$t1}"
    speed="$(cat "/sys/class/net/$i/speed" 2>/dev/null || echo -1)"
    state="$(cat "/sys/class/net/$i/operstate" 2>/dev/null || echo '?')"
    # Idle "down" ports are wiring noise, not load information.
    [ "$state" != "up" ] && [ "$((r1 - r0))" -eq 0 ] && [ "$((t1 - t0))" -eq 0 ] && continue
    awk -v ifn="$i" -v r0="$r0" -v r1="$r1" -v t0="$t0" -v t1="$t1" -v sp="$speed" -v st="$state" 'BEGIN{
        rx=(r1-r0)/1048576; tx=(t1-t0)/1048576;
        line=(sp>0)? sp" Mb/s" : "?";
        util="";
        if (sp>0) { m=(rx>tx?rx:tx)*8*1048576/1e6; util=sprintf("  util=%5.1f%%", 100*m/sp); }
        printf "  %-12s %-5s rx=%8.2f MB/s  tx=%8.2f MB/s  link=%-10s%s\n", ifn, st, rx, tx, line, util}'
done
unset IFS

# ---- Live DDS bandwidth (monitor's own measurement) -------------------------
for port in 8005 8001; do
    if curl -sf -m 2 "http://localhost:${port}/metrics" >/tmp/.kairos_load_metrics 2>/dev/null; then
        python3 - "$port" <<'PYEOF'
import json, sys
d = json.load(open("/tmp/.kairos_load_metrics"))
topics = d.get("topics", [])
tot = sum(t.get("bandwidth_bps") or 0 for t in topics)
msgs = sum(t.get("hz") or 0 for t in topics)
print(f"== LIVE DDS  (monitor:{sys.argv[1]})  {tot/1048576:.2f} MB/s over {len(topics)} topics, {msgs:.0f} msg/s")
for t in sorted(topics, key=lambda x: -(x.get("bandwidth_bps") or 0))[:3]:
    bw = (t.get("bandwidth_bps") or 0) / 1048576
    print(f"  {t['name']:50s} {bw:7.2f} MB/s  {t.get('hz') or 0:6.1f} Hz")
PYEOF
        break
    fi
done

# ---- Recording disk ---------------------------------------------------------
DATA_DIR="${DATA_DIR:-./data}"
df -h "$DATA_DIR" 2>/dev/null | awk 'NR==2 {printf "== DISK  (%s)  used=%s/%s (%s), free=%s\n", "'"$DATA_DIR"'", $3, $2, $5, $4}'
