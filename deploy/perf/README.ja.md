# 再現可能なライブ負荷計測

`deploy/perf` は、同じ workload の変更前後を固定時間窓で採取し、JSON と
Markdown で比較するための標準ライブラリのみの harness である。collector は
Linux の `/proc` と cgroup v2、localhost の既存 GET API を読む。製品の状態は
変更しない。

## 採取方式の選定根拠

2026-09-04、20 logical CPU の同一 host で、自然変動する同じ workload を
20 秒程度ずつ観測した。これは collector の observer effect と cadence を選ぶ
ための実測であり、製品負荷の改善値ではない。

| 方式 | sample / 実時間 | cadence | observer CPU | container CPU 合計 CV | host busy CV | 判定 |
|---|---:|---:|---:|---:|---:|---|
| 現行 `make load` | 5 / 18.60 s | 3.72 s | client 1.02 CPU-s（約 5% of one core）、daemon 込み約 6.7% of one core | 4.78% | 22.86% | 間隔が粗い |
| `docker stats --no-stream` 反復 | 9 / 20 s | 平均 2.078 s、SD 0.177 s | client 0.37 CPU-s（約 1.85% of one core）、daemon 込み約 4.0% of one core | 22.09% | — | Docker daemon の観測負荷を含む |
| cgroup v2 + `/proc` 直接読取 | 20 / 20.05 s | 1.000 s、CV 0.01% | 0.06 CPU-s（約 0.30% of one core） | 13.20% | 17.10% | 採用 |

`docker stats` の stream mode は ANSI 行の重複、最初の stale/spike、timestamp
不在、TERM で終了しない挙動が実測されたため不採用とした。上表の CV は方式
だけでなく workload の自然変動も含むため、製品間の優劣には使わない。

## 安全境界

- collector は `collection.mode = "read-only"` だけを受け付ける。container の
  start/stop、monitor の pause/resume、録画の prepare/start/stop、probe の
  activate、stream の offer は実行しない。必要な状態は operator が計測前に
  明示的に作り、status を確認する。
- probe は passive な status API を持たない。副作用のある `/fields` や
  `/stream` は collector から呼ばず、常に `unavailable` と記録する。
- `tcpdump` は opt-in で計測時間に束縛する。collector は `sudo` しないため、
  実行 user に capture 権限がなければ使用しない。
- env は ROS 関連の allowlist だけを記録する。全 env、command line、host 名、
  site 固有の topic/IP、ICE credential は committed scenario や report に入れない。
  生 JSON は gitignore 済みの `data/perf/` に置く。
- `make table` の `topic_table` は追加 DDS reader である。benchmark window 中は
  起動しない。別 terminal に残っていないことも事前に確認する。

## scenario

`deploy/perf/scenarios/replay-monitor-control.json` は、構造を確認するための
generic replay sample である。`/example/control`、active RMW、service port、実際の
bag に対応する state は site/runtime ごとに異なるため、そのまま実データで成功する
ことを保証しない。全ケースの設計表は `scenario-matrix.template.json` であり、そのまま
collector へ渡す入力ではない。site 固有値が必要なら template の 1 行を
`data/perf/` のローカル JSON に展開する。

比較 manifest を構成する必須 field は次のとおり。

| field | 意味 |
|---|---|
| `scenario_name` | 比較するケース名 |
| `duration_s`, `warmup_s`, `sample_interval_s` | 固定窓、集計から除く warm-up、sample 間隔 |
| `services` | monitor/streamer/recorder/probe の実行状態。runtime の `included_container_services` もこの状態から派生する |
| `monitor_topic_set`, `camera_topics`, `connected_clients` | monitor の topic 集合名、camera topic の完全な集合、preview client 数 |
| `camera_count`, `selected_topics` | camera 数と購読 topic の完全な集合 |
| `preview_layout`, `preview_caps` | main/subtile 配置と FPS/解像度 cap |
| `recorder_state` | `created`, `armed`, `recording`, `completed`、または状態を採取できない `unavailable` |
| `probe_state`, `probe_topic`, `probe_field` | `idle` / `active` / `unavailable` と、active 時の topic/field |
| `robot_motion` | `fixed-replay` など workload の運動条件 |
| `rmw`, `transport_evidence` | RMW と実測済み transport 根拠。推測は書かない |
| `config_paths` / `config_hashes` | 比較に固定する設定名→path、または既に得た hash。未指定なら active config hash は `unavailable`（`no config files configured`）として結果に残る。`config_paths` の内容は SHA-256 化し、path 自体は結果に保存しない |
| `comparison.allowed_axes` | 任意。意図して変更する既知の manifest path だけを入れた 1 要素配列 |
| `collection` | 以下の採取範囲と安全設定 |

`collection` は `mode: "read-only"`、container service/name の allowlist
`containers`（別名 `include_containers`）、`exclude_containers`、物理 NIC 名の
`physical_interfaces`、localhost 限定の `service_urls`、任意の
`http_timeout_s`、`tcpdump.{interface,multicast_host,port}` を持てる。container
指定を省略すると、名前が `kairos-` または `kairos_` で始まる稼働 container
を対象にする。物理 NIC を省略すると sysfs から検出し、`lo` は常に別枠で採取する。

## 実行

まず workload と service 状態を手動で揃え、baseline と candidate に別の出力名を
使う。`PERF_OUTPUT` を省略した場合は
`data/perf/result-<UTC timestamp>.json` に保存する。

```bash
make perf-run \
  PERF_SCENARIO=data/perf/monitor-control.json \
  PERF_OUTPUT=data/perf/baseline.json

# 変更を適用し、同じ workload/state を再現してから実行する。
make perf-run \
  PERF_SCENARIO=data/perf/monitor-control.json \
  PERF_OUTPUT=data/perf/candidate.json

make perf-compare \
  PERF_BASELINE=data/perf/baseline.json \
  PERF_CANDIDATE=data/perf/candidate.json \
  PERF_REPORT=data/perf/comparison.md
```

`PERF_REPORT` を省略すれば Markdown は標準出力だけに出る。CLI を直接使う場合は
次と同じである。

```bash
python3 deploy/perf/perf_collect.py collect \
  --scenario data/perf/monitor-control.json \
  --output data/perf/baseline.json
python3 deploy/perf/perf_compare.py \
  data/perf/baseline.json data/perf/candidate.json \
  --output data/perf/comparison.md
```

1 つの before/after pair では、両方の manifest に同じ `scenario_name` を設定し、
意図した変更を 1 変数に限定する。collector は既定で tracked 差分と untracked file
の両方が無い clean workspace だけを受理し、source revision 比較では `git_sha` の違い
だけを許容する。workspace fingerprint が異なる、または dirty な artifact は
`INVALID COMPARISON` になる。論理軸 `workload.services` を許可する場合は、その派生 runtime
field `environment.included_container_services` も同じ変更に含める。`environment.rmw`
を許可する場合も、派生した `environment.runtime_rmw` だけを同じ変更として扱う。
それ以外の派生 field は自動的に許可しない。RMW を比較するなら、両方の
scenario に同じ `comparison.allowed_axes: ["environment.rmw"]` を宣言する。
transport prerequisite/evidence は両側で同じ意味・shape・値に固定する。この宣言が
両 manifest で同じ場合だけ、その 1 個の既知 exact path の差を許容する。未宣言の
workload、時間条件、RMW、transport 根拠、config hash の差、0/2 個以上、未知 path、
片側だけまたは異なる allowlist は `INVALID COMPARISON` と不一致 field を表示して
exit 2 になる。これにより、例えば同じ replay workload で Cyclone/Fast DDS だけを
変えた run と、偶発的に camera 数や recorder state まで変わった無効な run を
区別する。

## replay 手順

E2E の実 bag replay を使う最小手順は次のとおり。初回依存取得と、service 変更後の
image build は E2E harness の通常手順に従う。

```bash
make test-e2e-up

# committed 例をコピーし、実 bag の control topic、active RMW、必要なら NIC と
# config_paths をローカル JSON 側だけで合わせる。状態遷移もここで手動実行する。
mkdir -p data/perf
cp deploy/perf/scenarios/replay-monitor-control.json \
  data/perf/replay-monitor-control.json
make perf-run \
  PERF_SCENARIO=data/perf/replay-monitor-control.json \
  PERF_OUTPUT=data/perf/replay-baseline.json

make test-e2e-down
```

この sample は generic topic と固定の localhost endpoint を使うため、実 bag の
topic、active RMW、container 名、service port、recorder/probe state が一致するとは
限らない。実測前にローカル JSON へ site/runtime の値を設定し、必要な service を
operator が手動で起動・準備する。採取前後で bag、topic、camera/client 数、preview
cap、recorder/probe state、計測時間が同じことを確認する。replay の Hz と monitor の
受信率も raw JSON で確認し、CPU が下がっても機能が欠けた run は採用しない。

## result JSON と分母

result の top-level `schema_version` は `kairos.perf.result/v2`。compare は v2 だけを
明示的に受理し、legacy v1 を曖昧に比較しない。`manifest` は別に
`schema_version: 1` を持ち、collector が scenario の入力を runtime の事実で補完した
self-describing な記録である。scenario/workload/environment、config hash、git
identity、CPU 数、検出した物理 NIC、included/excluded container の identity と
allowlist env、採取 endpoint の有無を固定する。設定が指定されていない、または
読めない場合も hash を省略せず、`{"status":"unavailable","reason":"..."}` として
明示する。
ほかに `started_at` / `completed_at`、collector 自身と child process の
`observer_overhead`、warm-up を含む `raw_samples`、除外数と採用数、数値 leaf の
`count/min/mean/max` を持つ `summary` がある。`cadence` は expected/actual sample 数、
各 monotonic 間隔、expected deadline、deadline error、最大 gap/overrun、最終 elapsed を持つ。
counter delta が window 全体を被覆するよう collector は各 interval の終端 deadline まで sleep して
から採取する。例えば `3/1` は `[1,2,3]`、`2.5/1` は `[1,2,2.5]`、`0.5/1` は `[0.5]` 秒である。
各 deadline の scheduler 許容値は `min(250 ms, max(50 ms, interval の 25%))` と明示し、sample の
不足/過剰、deadline 逸脱、zero-sleep catch-up burst は collector が fail-close する。compare も
cadence evidence を raw sample から再検証し、timing/warm-up/件数が不正な artifact を拒否する。
collector は採取後にも clean workspace の SHA/fingerprint が開始時と一致することを確認し、途中変更が
あれば結果を破棄する。欠測は 0 にせず、常に次の形で残る。

```json
{"status": "unavailable", "reason": "field absent"}
```

- host `cpu_busy_pct_machine` は全 logical CPU 容量を 100% とする。
  `cpu_busy_core_equivalents` は使用 core 相当数。
- container/process `pct_per_core` は 1 core = 100%。`pct_machine` はそれを
  logical CPU 数で割った host 全体比、`cores_used` は core 相当数。
- network は物理 NIC と `lo` を分離し、bytes/packet/multicast の差分と毎秒値を
  保存する。比較 report も各物理 NIC と `lo` の RX/TX を別々に表示する。
- cgroup v2 から container memory、PID 数、block I/O、`/proc` から init process
  の RSS/thread、GET API から monitor の Hz/bandwidth/count/self-load、streamer、
  recorder の status を採る。

現在の API から確定できず `unavailable` になる値もある。streamer の
received/decoded/output FPS と出力解像度は `/stream/status` に field が無い場合、
既存の曖昧な `fps` から捏造しない。browser 側の decode/render FPS も collector
からは読めない。recorder の drop/integrity/post-stop validation は status 応答に
無い段階では欠測となる。probe は前述のとおり passive status が無い。tcpdump は
default off、endpoint 不達や未設定 field も理由付き欠測とする。

## transport 根拠

Fast DDS では `ipc: host`、`/dev/shm` の segment 存在、物理 NIC の低 traffic の
どれか一つだけでは、その sample が SHM で配送された証明にならない。publisher と
reader の同一 host、同一 RMW、transport negotiation を payload 単位で確認できる
根拠が揃うまで `fastdds_shm_verified` は `false` とし、SHM 効果は未確認と報告する。

Cyclone DDS の issue #69 確認だけは、対象 domain で実際に観測した user-data
multicast group/port と物理 NIC を scenario に設定し、権限を事前に用意して opt-in
する。

```bash
make perf-run PERF_TCPDUMP=1 \
  PERF_SCENARIO=data/perf/cyclone-evidence.json \
  PERF_OUTPUT=data/perf/cyclone-evidence-result.json
```

capture は `duration_s` で終了し、filter は
`udp and dst host <multicast_host> and dst port <port>` に限定される。port を実測せず
既定値のまま使った 0 packet は証拠にならない。共有 LAN profile の適用確認では、
物理 NIC の対象 packet 数だけでなく `lo`/物理 NIC 帯域、host/container CPU、
topic 受信率を同じ窓で残す。profile を変える前後で manifest の複数 path が
変わるなら、各 JSON を issue #69 の transport evidence として並べる。比較を
通すために差を隠さない。自動比較する場合は変更を 1 変数に分離し、その既知
exact path だけを両 scenario の同じ `comparison.allowed_axes` に宣言する。
