<!-- AUTO-GENERATED from deploy/perf/README.ja.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# Reproducible live-load measurement

`deploy/perf` is a standard-library-only harness that samples before and after
changes to the same workload in fixed windows and compares them in JSON and
Markdown. The collector reads Linux `/proc`, cgroup v2, and existing localhost
GET APIs. It does not change product state.

## Rationale for selecting the sampling method

On 2026-09-04, the same naturally varying workload was observed for about 20
seconds at a time on the same host with 20 logical CPUs. This is a measurement
for selecting the collector's observer effect and cadence, not an improvement
value for the product load.

| Method | samples / elapsed time | cadence | observer CPU | total container CPU CV | host busy CV | decision |
|---|---:|---:|---:|---:|---:|---|
| Current `make load` | 5 / 18.60 s | 3.72 s | client 1.02 CPU-s (about 5% of one core), about 6.7% of one core including the daemon | 4.78% | 22.86% | intervals too coarse |
| Repeated `docker stats --no-stream` | 9 / 20 s | mean 2.078 s, SD 0.177 s | client 0.37 CPU-s (about 1.85% of one core), about 4.0% of one core including the daemon | 22.09% | — | includes Docker daemon observation load |
| Direct cgroup v2 + `/proc` reads | 20 / 20.05 s | 1.000 s, CV 0.01% | 0.06 CPU-s (about 0.30% of one core) | 13.20% | 17.10% | selected |

The `docker stats` stream mode was rejected because measurement showed duplicate
ANSI lines, an initial stale/spike value, no timestamps, and behavior that did
not terminate on TERM. The CV values above include natural workload variation
as well as the method, so they must not be used to rank product versions.

## Safety boundaries

- The collector accepts only `collection.mode = "read-only"`. It does not start
  or stop containers, pause or resume the monitor, prepare/start/stop recording,
  activate the probe, or offer the stream. The operator explicitly establishes
  the required state before measurement and checks status.
- The probe has no passive status API. The collector does not call side-effecting
  `/fields` or `/stream`; it always records the probe as `unavailable`.
- `tcpdump` is opt-in and bounded by the measurement duration. The collector does
  not use `sudo`, so it is not used unless the executing user has capture rights.
- Only an allowlist of ROS-related environment variables is recorded. Full
  environment, command lines, host names, site-specific topics/IPs, and ICE
  credentials are not put into committed scenarios or reports. Raw JSON is kept
  under gitignored `data/perf/`.
- `make table`'s `topic_table` is an additional DDS reader. Do not start it during
  the benchmark window, and verify beforehand that it is not left running in
  another terminal.

## scenario

`deploy/perf/scenarios/replay-monitor-control.json` is a generic replay sample
for checking structure. `/example/control`, the active RMW, service port, and
the state corresponding to the actual bag vary by site/runtime, so success with
real data is not guaranteed as-is. The design table for all cases is
`scenario-matrix.template.json`; it is not an input to the collector as-is. If
site-specific values are needed, expand one template row into local JSON under
`data/perf/`.

The required fields for a comparison manifest are:

| field | meaning |
|---|---|
| `scenario_name` | name of the case being compared |
| `duration_s`, `warmup_s`, `sample_interval_s` | fixed window, warm-up excluded from aggregation, and sample interval |
| `services` | running state of monitor/streamer/recorder/probe. Runtime `included_container_services` is derived from this state as well |
| `monitor_topic_set`, `camera_topics`, `connected_clients` | monitor topic-set name, complete camera-topic set, and preview client count |
| `camera_count`, `selected_topics` | camera count and complete set of subscribed topics |
| `preview_layout`, `preview_caps` | main/subtile layout and FPS/resolution caps |
| `recorder_state` | one of `created`, `armed`, `recording`, `completed`, or `unavailable` when the state cannot be collected |
| `probe_state`, `probe_topic`, `probe_field` | `idle` / `active` / `unavailable`, plus the topic/field when active |
| `robot_motion` | motion condition of the workload, such as `fixed-replay` |
| `rmw`, `transport_evidence` | RMW and measured transport basis; do not write guesses |
| `config_paths` / `config_hashes` | setting name → path fixed for comparison, or an existing hash. If omitted, the active config hash remains in the result as `unavailable` (`no config files configured`). Hash `config_paths` contents with SHA-256; do not save the paths themselves in results |
| `comparison.allowed_axes` | optional. A one-element array containing only the known manifest path intentionally changed |
| `collection` | the following collection scope and safety settings |

`collection` can contain `mode: "read-only"`, a container service/name allowlist
`containers` (alias `include_containers`), `exclude_containers`, physical NIC
names in `physical_interfaces`, localhost-only `service_urls`, optional
`http_timeout_s`, and `tcpdump.{interface,multicast_host,port}`. If containers
are omitted, running containers whose names begin with `kairos-` or `kairos_`
are targeted. If physical NICs are omitted, they are detected from sysfs, and
`lo` is always sampled separately.

## Execution

First align the workload and service state manually, and use different output
names for baseline and candidate. If `PERF_OUTPUT` is omitted, the result is
saved to `data/perf/result-<UTC timestamp>.json`.

```bash
make perf-run \
  PERF_SCENARIO=data/perf/monitor-control.json \
  PERF_OUTPUT=data/perf/baseline.json

# Apply the change and reproduce the same workload/state before running again.
make perf-run \
  PERF_SCENARIO=data/perf/monitor-control.json \
  PERF_OUTPUT=data/perf/candidate.json

make perf-compare \
  PERF_BASELINE=data/perf/baseline.json \
  PERF_CANDIDATE=data/perf/candidate.json \
  PERF_REPORT=data/perf/comparison.md
```

If `PERF_REPORT` is omitted, Markdown is printed only to stdout. Direct CLI use
is equivalent to:

```bash
python3 deploy/perf/perf_collect.py collect \
  --scenario data/perf/monitor-control.json \
  --output data/perf/baseline.json
python3 deploy/perf/perf_compare.py \
  data/perf/baseline.json data/perf/candidate.json \
  --output data/perf/comparison.md
```

In one before/after pair, set the same `scenario_name` in both manifests and limit
the intentional change to one variable. Normal source revision comparisons allow
only a `git_sha` difference. If the logical `workload.services` axis is allowed,
its derived runtime field `environment.included_container_services` is included in
the same change. If `environment.rmw` is allowed, only its derived
`environment.runtime_rmw` is treated as part of that change. Other derived fields
are not allowed automatically. To compare RMW,
declare the same `comparison.allowed_axes: ["environment.rmw"]` in both
scenarios. Keep transport prerequisites/evidence fixed to the same meaning,
shape, and values on both sides. Only when this declaration is identical in both
manifests is the difference in that one known exact path allowed. An undeclared
workload, timing condition, RMW, transport basis, or config-hash difference,
zero/two-or-more differences, an unknown path, or a one-sided/different
allowlist produces `INVALID COMPARISON`, lists the mismatched fields, and exits
with 2. This distinguishes a run changing only Cyclone/Fast DDS for the same
replay workload from an invalid run that also accidentally changed camera count
or recorder state.

## replay procedure

The minimum procedure using E2E's real bag replay is below. Follow the normal E2E
harness procedure for first-time dependency acquisition and image builds after
service changes.

```bash
make test-e2e-up

# Copy the committed example and adjust the real bag's control topic, active RMW,
# and, if needed, NIC and config_paths only in the local JSON. Perform state
# transitions manually here as well.
mkdir -p data/perf
cp deploy/perf/scenarios/replay-monitor-control.json \
  data/perf/replay-monitor-control.json
make perf-run \
  PERF_SCENARIO=data/perf/replay-monitor-control.json \
  PERF_OUTPUT=data/perf/replay-baseline.json

make test-e2e-down
```

This sample uses a generic topic and fixed localhost endpoints, so the real bag's
topics, active RMW, container names, service ports, and recorder/probe states may
not match. Before measuring, set site/runtime values in local JSON and have the
operator start and prepare required services manually. Verify before and after
collection that the bag, topics, camera/client count, preview caps,
recorder/probe state, and measurement duration are identical. Also verify replay
Hz and the monitor receive rate in raw JSON; do not accept a run where
functionality is missing even if CPU is lower.

## result JSON and denominators

The result top-level `schema_version` is `kairos.perf.result/v1`. `manifest` has
its own `schema_version: 1` and is a self-describing record in which the collector
complements scenario input with runtime facts. It fixes the
scenario/workload/environment, config hash, git identity, CPU count, detected
physical NICs, included/excluded container identities and allowlist environment,
and availability of collection endpoints. If configuration is unspecified or
unreadable, the hash is not omitted: it is explicitly retained as
`{"status":"unavailable","reason":"..."}`. It also has
`started_at` / `completed_at`, collector and child-process `observer_overhead`,
`raw_samples` including warm-up, exclusion and accepted counts, and a `summary`
with `count/min/mean/max` for numeric leaves.
Missing data is never converted to 0 and is always retained in this form:

```json
{"status": "unavailable", "reason": "field absent"}
```

- Host `cpu_busy_pct_machine` treats the capacity of all logical CPUs as 100%.
  `cpu_busy_core_equivalents` is the equivalent number of used cores.
- Container/process `pct_per_core` uses 1 core = 100%. `pct_machine` divides it
  by the number of logical CPUs for the host-wide ratio, and `cores_used` is the
  equivalent number of cores.
- Network separates physical NICs and `lo`, and saves byte/packet/multicast
  deltas and per-second rates. Comparison reports also show RX/TX separately for
  each physical NIC and `lo`.
- Container memory, PID count, and block I/O come from cgroup v2; init-process
  RSS/threads come from `/proc`; monitor Hz/bandwidth/count/self-load, streamer,
  and recorder status come from GET APIs.

Some values are `unavailable` because they cannot be established from the current
APIs. If `/stream/status` lacks fields for received/decoded/output FPS and output
resolution, do not fabricate them from its existing ambiguous `fps`; browser
decode/render FPS is also unreadable by the collector. Recorder drop/integrity/
post-stop validation are missing until those fields exist in its status response.
The probe has no passive status as described above. `tcpdump` is off by default,
and unreachable endpoints or unset fields are unavailable with a reason.

## transport basis

For Fast DDS, any one of `ipc: host`, presence of a `/dev/shm` segment, or low
traffic on a physical NIC does not prove that a sample was delivered by SHM.
Until evidence is available at the payload level for publisher and reader on the
same host, the same RMW, and transport negotiation, set
`fastdds_shm_verified` to `false` and report SHM effects as unverified.

For the Cyclone DDS issue #69 check only, set the actually observed user-data
multicast group/port and physical NIC in the scenario for the target domain, and
opt in after preparing permissions in advance.

```bash
make perf-run PERF_TCPDUMP=1 \
  PERF_SCENARIO=data/perf/cyclone-evidence.json \
  PERF_OUTPUT=data/perf/cyclone-evidence-result.json
```

Capture ends at `duration_s`, and the filter is limited to
`udp and dst host <multicast_host> and dst port <port>`. Zero packets when the
port was not measured and the default was left in place are not evidence. When
confirming application of the shared-LAN profile, retain not only packet counts
for the target physical NIC but also `lo`/physical-NIC bandwidth, host/container
CPU, and topic receive rate in the same window. If multiple manifest paths change
before and after applying the profile, place each JSON alongside the issue #69
transport evidence. Do not hide differences to make comparison pass. For an
automated comparison, isolate the change to one variable and declare only that
known exact path in the same `comparison.allowed_axes` in both scenarios.
