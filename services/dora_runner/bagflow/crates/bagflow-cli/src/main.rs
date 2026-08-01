//! bagflow CLI: preflight-checks a validation flow against the bag metadata,
//! generates the dora dataflow (source node, report aggregator, done/EOS
//! wiring), and runs it.

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE_ID: &str = "bagflow_source";
const REPORT_ID: &str = "bagflow_report";
/// conservative built-in default: bounds worst-case shm backlog per edge
const DEFAULT_QUEUE: usize = 256;

const PY_HELPER: &str = include_str!("../../../python/bagflow/__init__.py");

#[derive(Parser)]
#[command(about = "Offline rosbag validation flows on dora")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Preflight-check and run a flow
    Run {
        flow: PathBuf,
        /// Start detached and return as soon as report.json is written,
        /// leaving dataflow teardown to the daemon (fastest turnaround;
        /// pair with a pre-started `dora up` daemon)
        #[arg(long)]
        no_attach: bool,
        /// Override the flow's `bag` (per-job invocation without editing YAML)
        #[arg(long)]
        bag: Option<PathBuf>,
        /// Override the flow's `report` output path
        #[arg(long)]
        report: Option<PathBuf>,
        /// Give up if the report has not appeared after this many seconds
        /// (a dataflow that dies is detected immediately regardless)
        #[arg(long, default_value_t = 3600)]
        timeout: u64,
        /// Name the dora dataflow (kairos vendoring): makes cleanup after a
        /// timeout deterministic — `dora stop --name <NAME>` targets exactly
        /// this run instead of guessing from `dora list`
        #[arg(long)]
        name: Option<String>,
    },
    /// Preflight-check only
    Check {
        flow: PathBuf,
        #[arg(long)]
        bag: Option<PathBuf>,
    },
}

// ---------- user flow definition ----------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Flow {
    bag: PathBuf,
    #[serde(default = "default_report")]
    report: PathBuf,
    /// flow-wide defaults, overridable per node and per input
    #[serde(default)]
    defaults: Defaults,
    /// source batching (rows/bytes per Arrow batch sent per topic)
    #[serde(default)]
    source: SourceCfg,
    nodes: Vec<FlowNode>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Defaults {
    #[serde(default)]
    queue_size: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct SourceCfg {
    #[serde(default)]
    batch_rows: Option<usize>,
    #[serde(default)]
    batch_bytes: Option<usize>,
}

fn default_report() -> PathBuf {
    PathBuf::from("report.json")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FlowNode {
    id: String,
    path: PathBuf,
    #[serde(default)]
    inputs: BTreeMap<String, FlowInput>,
    #[serde(default)]
    outputs: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    /// default queue_size for every input of this node
    #[serde(default)]
    queue_size: Option<usize>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum FlowInput {
    /// "/some/rostopic" or "node_id/output"
    Short(String),
    Long {
        #[serde(default)]
        topic: Option<String>,
        #[serde(default)]
        node: Option<String>,
        #[serde(default)]
        queue_size: Option<usize>,
    },
}

impl FlowInput {
    fn reference(&self) -> Result<&str> {
        match self {
            FlowInput::Short(s) => Ok(s),
            FlowInput::Long { topic, node, .. } => match (topic, node) {
                (Some(t), None) => Ok(t),
                (None, Some(n)) => Ok(n),
                _ => bail!("input must set exactly one of `topic` or `node`"),
            },
        }
    }
    fn queue_size(&self) -> Option<usize> {
        match self {
            FlowInput::Short(_) => None,
            FlowInput::Long { queue_size, .. } => *queue_size,
        }
    }
}

// ---------- rosbag2 metadata.yaml ----------

#[derive(Deserialize)]
struct MetaRoot {
    rosbag2_bagfile_information: MetaInfo,
}

#[derive(Deserialize)]
struct MetaInfo {
    #[serde(default)]
    duration: Option<MetaNanos>,
    #[serde(default)]
    message_count: Option<u64>,
    #[serde(default)]
    topics_with_message_count: Vec<MetaTopic>,
}

#[derive(Deserialize)]
struct MetaNanos {
    nanoseconds: u64,
}

#[derive(Deserialize)]
struct MetaTopic {
    topic_metadata: MetaTopicMeta,
    message_count: u64,
}

#[derive(Deserialize)]
struct MetaTopicMeta {
    name: String,
    r#type: String,
}

// ---------- generated dora dataflow ----------

#[derive(Serialize)]
struct DoraFlow {
    nodes: Vec<DoraNodeDef>,
}

#[derive(Serialize)]
struct DoraNodeDef {
    id: String,
    path: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    inputs: BTreeMap<String, DoraInput>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    outputs: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    env: BTreeMap<String, String>,
}

#[derive(Serialize)]
struct DoraInput {
    source: String,
    queue_size: usize,
}

fn sanitize_topic(topic: &str) -> String {
    let s = topic.trim_start_matches('/').replace('/', "__");
    if s.is_empty() {
        "_root".to_string()
    } else {
        s
    }
}

fn abs(base: &Path, p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        base.join(p)
    }
}

struct Plan {
    dataflow: DoraFlow,
    report_path: PathBuf,
    topics: Vec<(String, Option<u64>)>, // subscribed topic, rows in bag
    workdir: PathBuf,
}

fn cwd_abs(p: PathBuf) -> Result<PathBuf> {
    if p.is_absolute() {
        Ok(p)
    } else {
        Ok(std::env::current_dir()?.join(p))
    }
}

fn preflight(
    flow_path: &Path,
    bag_override: Option<PathBuf>,
    report_override: Option<PathBuf>,
) -> Result<Plan> {
    let flow_dir = flow_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let flow_dir = flow_dir.canonicalize().unwrap_or(flow_dir);
    let flow: Flow = serde_yaml::from_str(
        &std::fs::read_to_string(flow_path)
            .with_context(|| format!("read {}", flow_path.display()))?,
    )
    .context("parse flow yaml")?;

    let bag = match bag_override {
        Some(b) => cwd_abs(b)?,
        None => abs(&flow_dir, &flow.bag),
    };
    if !bag.exists() {
        bail!("bag not found: {}", bag.display());
    }

    // bag metadata (optional but strongly recommended: enables preflight + coverage)
    let meta_path = if bag.is_dir() {
        bag.join("metadata.yaml")
    } else {
        bag.parent().unwrap_or(Path::new(".")).join("metadata.yaml")
    };
    let meta: Option<MetaInfo> = if meta_path.exists() {
        let root: MetaRoot = serde_yaml::from_str(&std::fs::read_to_string(&meta_path)?)
            .with_context(|| format!("parse {}", meta_path.display()))?;
        Some(root.rosbag2_bagfile_information)
    } else {
        eprintln!(
            "warning: {} not found — topic preflight and coverage are disabled",
            meta_path.display()
        );
        None
    };
    let bag_topics: BTreeMap<String, (String, u64)> = meta
        .as_ref()
        .map(|m| {
            m.topics_with_message_count
                .iter()
                .map(|t| {
                    (
                        t.topic_metadata.name.clone(),
                        (t.topic_metadata.r#type.clone(), t.message_count),
                    )
                })
                .collect()
        })
        .unwrap_or_default();

    // validate node ids and wiring
    let mut node_outputs: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for n in &flow.nodes {
        if n.id.starts_with("bagflow") {
            bail!("node id `{}` is reserved", n.id);
        }
        if node_outputs.contains_key(&n.id) {
            bail!("duplicate node id `{}`", n.id);
        }
        node_outputs.insert(n.id.clone(), n.outputs.clone());
    }

    let mut subscribed: BTreeMap<String, String> = BTreeMap::new(); // topic -> output id
    let mut wiring: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for n in &flow.nodes {
        for (input_name, input) in &n.inputs {
            if input_name == "done" || input_name == "result" {
                bail!("input name `{input_name}` is reserved (node `{}`)", n.id);
            }
            let re = input.reference()?;
            if re.starts_with('/') {
                if let Some(m) = &meta {
                    if !bag_topics.contains_key(re) {
                        let mut avail: Vec<String> = bag_topics
                            .iter()
                            .map(|(k, (ty, c))| format!("  {k}  [{ty}] ({c} msgs)"))
                            .collect();
                        avail.sort();
                        let _ = m;
                        bail!(
                            "topic `{re}` (node `{}`, input `{input_name}`) is not in the bag.\navailable topics:\n{}",
                            n.id,
                            avail.join("\n")
                        );
                    }
                }
                subscribed
                    .entry(re.to_string())
                    .or_insert_with(|| sanitize_topic(re));
            } else {
                let (nid, out) = re
                    .split_once('/')
                    .with_context(|| format!("bad node reference `{re}` — expected `node_id/output`"))?;
                let outs = node_outputs
                    .get(nid)
                    .with_context(|| format!("unknown node `{nid}` referenced by `{}`", n.id))?;
                if !outs.iter().any(|o| o == out) {
                    bail!("node `{nid}` has no output `{out}` (referenced by `{}`)", n.id);
                }
            }
            wiring
                .entry(n.id.clone())
                .or_default()
                .insert(input_name.clone(), re.to_string());
        }
    }
    // kairos vendoring: a flow whose checks read only the bag metadata
    // (`bagflow-topic-presence`, `bagflow-topic-rate`) subscribes to nothing and
    // is still a complete flow — the source node then skips the scan entirely
    // and only reports its counts. Upstream rejected this case.
    if subscribed.is_empty() && !flow.nodes.is_empty() {
        eprintln!("note: no rostopic inputs — metadata-only flow (the bag is not read)");
    }
    if flow.nodes.is_empty() {
        bail!("flow declares no nodes");
    }

    let workdir = flow_dir.join(".bagflow");
    let pylib = workdir.join("pylib");
    let report_path = match report_override {
        Some(r) => cwd_abs(r)?,
        None => abs(&flow_dir, &flow.report),
    };

    let exe_dir = std::env::current_exe()?
        .parent()
        .context("exe dir")?
        .to_path_buf();
    let source_bin = exe_dir.join("bagflow-source");
    let report_bin = exe_dir.join("bagflow-report");

    // ----- build the dora dataflow -----
    let mut nodes = Vec::new();
    let done_input = || DoraInput {
        source: format!("{REPORT_ID}/done"),
        queue_size: 100,
    };

    let mut source_outputs: Vec<String> = subscribed.values().cloned().collect();
    source_outputs.push("result".to_string());
    let mut source_env = BTreeMap::from([
        ("BAGFLOW_BAG".to_string(), bag.display().to_string()),
        (
            "BAGFLOW_TOPICS".to_string(),
            serde_json::to_string(&subscribed)?,
        ),
    ]);
    if let Some(rows) = flow.source.batch_rows {
        source_env.insert("BAGFLOW_BATCH_ROWS".to_string(), rows.to_string());
    }
    if let Some(bytes) = flow.source.batch_bytes {
        source_env.insert("BAGFLOW_BATCH_BYTES".to_string(), bytes.to_string());
    }
    nodes.push(DoraNodeDef {
        id: SOURCE_ID.to_string(),
        path: source_bin.display().to_string(),
        inputs: BTreeMap::from([("done".to_string(), done_input())]),
        outputs: source_outputs,
        env: source_env,
    });

    let expected: BTreeMap<&String, u64> = bag_topics.iter().map(|(k, (_, c))| (k, *c)).collect();
    let expected_json = serde_json::to_string(&expected)?;
    // kairos vendoring: the message type per topic, the metadata counterpart of
    // BAGFLOW_EXPECTED. `bagflow-topic-presence` needs it to check that a
    // required topic carries the type the recording template declares.
    let topic_types: BTreeMap<&String, &String> =
        bag_topics.iter().map(|(k, (ty, _))| (k, ty)).collect();
    let topic_types_json = serde_json::to_string(&topic_types)?;
    let bag_info = serde_json::json!({
        "path": bag.display().to_string(),
        "duration_s": meta.as_ref().and_then(|m| m.duration.as_ref()).map(|d| d.nanoseconds as f64 / 1e9),
        "message_count": meta.as_ref().and_then(|m| m.message_count),
    });

    for n in &flow.nodes {
        let mut inputs = BTreeMap::new();
        inputs.insert("done".to_string(), done_input());
        for (input_name, input) in &n.inputs {
            let re = input.reference()?;
            let source = if re.starts_with('/') {
                format!("{SOURCE_ID}/{}", subscribed[re])
            } else {
                re.to_string()
            };
            // precedence: per-input > per-node > flow defaults > built-in
            let queue_size = input
                .queue_size()
                .or(n.queue_size)
                .or(flow.defaults.queue_size)
                .unwrap_or(DEFAULT_QUEUE);
            inputs.insert(input_name.clone(), DoraInput { source, queue_size });
        }
        let mut outputs = n.outputs.clone();
        outputs.push("result".to_string());

        let mut env = n.env.clone();
        env.insert(
            "BAGFLOW_INPUTS".to_string(),
            n.inputs.keys().cloned().collect::<Vec<_>>().join(","),
        );
        env.insert("BAGFLOW_OUTPUTS".to_string(), n.outputs.join(","));
        env.insert("BAGFLOW_NODE_ID".to_string(), n.id.clone());
        env.insert("BAGFLOW_EXPECTED".to_string(), expected_json.clone());
        env.insert("BAGFLOW_TOPIC_TYPES".to_string(), topic_types_json.clone());
        env.insert("BAGFLOW_BAGINFO".to_string(), bag_info.to_string());
        let pypath = pylib.display().to_string();
        env.entry("PYTHONPATH".to_string())
            .and_modify(|v| *v = format!("{pypath}:{v}"))
            .or_insert(pypath);

        nodes.push(DoraNodeDef {
            id: n.id.clone(),
            path: abs(&flow_dir, &n.path).display().to_string(),
            inputs,
            outputs,
            env,
        });
    }

    // report aggregator
    let mut report_inputs = BTreeMap::new();
    report_inputs.insert(
        format!("result_{SOURCE_ID}"),
        DoraInput {
            source: format!("{SOURCE_ID}/result"),
            queue_size: DEFAULT_QUEUE,
        },
    );
    for n in &flow.nodes {
        report_inputs.insert(
            format!("result_{}", n.id),
            DoraInput {
                source: format!("{}/result", n.id),
                queue_size: DEFAULT_QUEUE,
            },
        );
    }
    let report_input_names = report_inputs.keys().cloned().collect::<Vec<_>>().join(",");
    nodes.push(DoraNodeDef {
        id: REPORT_ID.to_string(),
        path: report_bin.display().to_string(),
        inputs: report_inputs,
        outputs: vec!["done".to_string()],
        env: BTreeMap::from([
            (
                "BAGFLOW_REPORT".to_string(),
                report_path.display().to_string(),
            ),
            ("BAGFLOW_EXPECTED".to_string(), expected_json.clone()),
            (
                "BAGFLOW_WIRING".to_string(),
                serde_json::to_string(&wiring)?,
            ),
            ("BAGFLOW_BAGINFO".to_string(), bag_info.to_string()),
            ("BAGFLOW_INPUTS".to_string(), report_input_names),
        ]),
    });

    let topics = subscribed
        .keys()
        .map(|t| (t.clone(), bag_topics.get(t).map(|(_, c)| *c)))
        .collect();

    Ok(Plan {
        dataflow: DoraFlow { nodes },
        report_path,
        topics,
        workdir,
    })
}

fn write_workdir(plan: &Plan) -> Result<PathBuf> {
    let pylib = plan.workdir.join("pylib");
    std::fs::create_dir_all(pylib.join("bagflow"))?;
    std::fs::write(pylib.join("bagflow/__init__.py"), PY_HELPER)?;
    let dataflow_path = plan.workdir.join("dataflow.yml");
    std::fs::write(&dataflow_path, serde_yaml::to_string(&plan.dataflow)?)?;
    Ok(dataflow_path)
}

/// dora's own defaults for the coordinator control endpoint.
const DEFAULT_COORDINATOR_ADDR: &str = "127.0.0.1";
const DEFAULT_COORDINATOR_PORT: &str = "6012";

/// Coordinator control endpoint (kairos vendoring: `DORA_COORDINATOR_ADDR` /
/// `DORA_COORDINATOR_PORT`).
///
/// dora 0.5's `dora up` has no port option, so a service that wants its own
/// coordinator has to spawn `dora coordinator` / `dora daemon` itself. kairos
/// does exactly that on a private port so a co-located dora stack on the same
/// host network can never be reached by accident.
fn coordinator_endpoint() -> (String, String) {
    (
        std::env::var("DORA_COORDINATOR_ADDR")
            .unwrap_or_else(|_| DEFAULT_COORDINATOR_ADDR.to_string()),
        std::env::var("DORA_COORDINATOR_PORT")
            .unwrap_or_else(|_| DEFAULT_COORDINATOR_PORT.to_string()),
    )
}

/// `--coordinator-addr/-port` args for every `dora` subcommand we shell out to.
fn coordinator_args() -> Vec<String> {
    let (addr, port) = coordinator_endpoint();
    vec![
        "--coordinator-addr".to_string(),
        addr,
        "--coordinator-port".to_string(),
        port,
    ]
}

/// Whether the endpoint is dora's default one (i.e. the one `dora up` binds).
fn is_default_endpoint() -> bool {
    let (addr, port) = coordinator_endpoint();
    addr == DEFAULT_COORDINATOR_ADDR && port == DEFAULT_COORDINATOR_PORT
}

/// `dora up` costs ~0.15s even when everything is already running, which is a
/// fifth of a quick gate's wall time. Probing the coordinator first keeps the
/// documented "dora up once at service start" pattern free.
///
/// With a non-default endpoint we never call `dora up` (it can only bind the
/// default port, so it would start a coordinator we are not going to talk to):
/// an unreachable private coordinator is an error the caller must fix.
fn ensure_dora_up() -> Result<bool> {
    let (addr, port) = coordinator_endpoint();
    let reachable = format!("{addr}:{port}")
        .parse()
        .ok()
        .map(|addr| {
            std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(100))
                .is_ok()
        })
        .unwrap_or(false);
    if !reachable {
        if !is_default_endpoint() {
            bail!(
                "no dora coordinator at {addr}:{port} (DORA_COORDINATOR_ADDR/PORT). \
                 Start one with `dora coordinator --control-port {port}` plus a \
                 `dora daemon --coordinator-port <daemon-port>`."
            );
        }
        let _ = Command::new("dora").arg("up").status();
    }
    Ok(reachable)
}

/// Size of the /dev/shm tmpfs in MiB, when the mount declares one (containers
/// always do; on a bare host it defaults to half of RAM and is reported as
/// `None`). dora puts every queued message here, so a small tmpfs is the most
/// common way for an image flow to die.
fn shm_limit_mib() -> Option<u64> {
    let mounts = std::fs::read_to_string("/proc/mounts").ok()?;
    let line = mounts.lines().find(|l| {
        let mut f = l.split_whitespace();
        f.next();
        f.next() == Some("/dev/shm")
    })?;
    line.split_whitespace()
        .nth(3)?
        .split(',')
        .find_map(|opt| opt.strip_prefix("size="))
        .and_then(|s| s.strip_suffix('k'))
        .and_then(|s| s.parse::<u64>().ok())
        .map(|kib| kib / 1024)
}

/// Warn when the shared-memory tmpfs is too small to hold the queues a flow
/// declares. There is no way to know message sizes up front, but the failure
/// this prevents is silent (nodes die with no log at all), so a heads-up when
/// the tmpfs is at container-default size is worth the line.
fn warn_if_shm_tight(plan: &Plan) {
    let Some(mib) = shm_limit_mib() else { return };
    let queued: usize = plan
        .dataflow
        .nodes
        .iter()
        .flat_map(|n| n.inputs.values())
        .map(|i| i.queue_size)
        .sum();
    eprintln!("/dev/shm: {mib} MiB, {queued} messages of queue declared across all edges");
    if mib < 256 {
        eprintln!(
            "warning: {mib} MiB of /dev/shm is small for decoded-image flows — a node that \
             runs out of it is killed without writing anything to its log.\n         \
             Raise it (docker run --shm-size=2g) or lower `queue_size`."
        );
    }
}

/// `dora start --detach` prints "dataflow start triggered: <uuid>"; the uuid
/// lets us watch that specific dataflow and find its node logs.
fn parse_dataflow_uuid(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .filter(|l| l.contains("dataflow start") || l.contains("dataflow started"))
        .filter_map(|l| l.rsplit(':').next())
        .map(str::trim)
        .find(|s| s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
        .map(str::to_string)
}

/// Status of one dataflow as reported by `dora list` (JSON Lines).
fn dataflow_status(uuid: &str) -> Option<String> {
    let out = Command::new("dora")
        .args(["list", "--format", "json"])
        .args(coordinator_args())
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|v| v.get("uuid").and_then(|u| u.as_str()) == Some(uuid))
        .and_then(|v| v.get("status")?.as_str().map(str::to_string))
}

/// Turn a stuck or dead dataflow into something actionable: where the node
/// logs are, what they said, and which node is no longer running.
fn diagnostics(plan: &Plan, uuid: Option<&str>) -> String {
    let Some(uuid) = uuid else {
        return String::new();
    };
    let dir = plan.workdir.join("out").join(uuid);
    let mut s = format!("\n  node logs: {}", dir.display());
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(node) = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_prefix("log_"))
                .and_then(|n| n.strip_suffix(".txt"))
            else {
                continue;
            };
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            let mut errs: Vec<&str> = content
                .lines()
                .rev()
                .filter(|l| {
                    let l = l.to_lowercase();
                    l.contains("error") || l.contains("panic") || l.contains("traceback")
                })
                .take(2)
                .collect();
            errs.reverse();
            for line in errs {
                s.push_str(&format!("\n  {node}: {}", line.trim()));
            }
        }
    }
    // which of this flow's nodes still have a live process: a stuck flow is
    // almost always one node gone while the rest wait for its end-of-stream
    let (alive, gone) = node_liveness(plan);
    if !gone.is_empty() {
        s.push_str(&format!("\n  no live process: {}", gone.join(", ")));
        if !alive.is_empty() {
            s.push_str(&format!(
                "\n  still waiting:   {}\n  \
                 (a node that exits before sending end-of-stream leaves the rest \
                 blocked; the source and decode nodes legitimately exit early once \
                 their work is done)",
                alive.join(", ")
            ));
        }
    }
    if shm_limit_mib().is_some_and(|m| m < 256) {
        s.push_str(
            "\n  /dev/shm is small — a node killed by shared-memory exhaustion dies \
             without writing anything to its log; raise --shm-size or lower `queue_size`",
        );
    }
    s
}

/// Split the flow's nodes into those with a live process and those without,
/// by matching each node's configured path against /proc/<pid>/cmdline.
fn node_liveness(plan: &Plan) -> (Vec<String>, Vec<String>) {
    let mut cmdlines = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/proc") {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if !name.to_string_lossy().chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            if let Ok(raw) = std::fs::read(entry.path().join("cmdline")) {
                cmdlines.push(String::from_utf8_lossy(&raw).replace('\0', " "));
            }
        }
    }
    if cmdlines.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let (mut alive, mut gone) = (Vec::new(), Vec::new());
    for n in &plan.dataflow.nodes {
        if cmdlines.iter().any(|c| c.contains(&n.path)) {
            alive.push(n.id.clone());
        } else {
            gone.push(n.id.clone());
        }
    }
    (alive, gone)
}

/// Wait for the report node to write report.json, giving up as soon as the
/// dataflow itself is gone instead of blocking until the timeout.
fn wait_for_report(plan: &Plan, uuid: Option<&str>, timeout_s: u64) -> Result<()> {
    let start = std::time::Instant::now();
    let deadline = start + std::time::Duration::from_secs(timeout_s);
    // a healthy quick gate finishes in well under a second, so the liveness
    // probe (which shells out to `dora list`) only starts once it is overdue
    let mut next_probe = start + std::time::Duration::from_secs(1);
    loop {
        if plan.report_path.exists() {
            return Ok(());
        }
        let now = std::time::Instant::now();
        if now > deadline {
            bail!(
                "timed out after {timeout_s}s waiting for {}{}",
                plan.report_path.display(),
                diagnostics(plan, uuid)
            );
        }
        if now >= next_probe {
            next_probe = now + std::time::Duration::from_millis(500);
            if let Some(uuid) = uuid {
                if let Some(status) = dataflow_status(uuid) {
                    if status != "Running" {
                        // the report is written just before the dataflow winds
                        // down, so re-check before calling it a failure
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        if plan.report_path.exists() {
                            return Ok(());
                        }
                        bail!(
                            "dataflow {uuid} ended with status `{status}` without writing {}{}",
                            plan.report_path.display(),
                            diagnostics(plan, Some(uuid))
                        );
                    }
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Check { flow, bag } => {
            let plan = preflight(&flow, bag, None)?;
            println!("preflight OK — subscribed topics:");
            for (t, count) in &plan.topics {
                match count {
                    Some(c) => println!("  {t} ({c} msgs)"),
                    None => println!("  {t} (count unknown)"),
                }
            }
            println!("report: {}", plan.report_path.display());
            warn_if_shm_tight(&plan);
            Ok(())
        }
        Cmd::Run {
            flow,
            no_attach,
            bag,
            report,
            timeout,
            name,
        } => {
            let plan = preflight(&flow, bag, report)?;
            let dataflow_path = write_workdir(&plan)?;
            warn_if_shm_tight(&plan);
            let skipped_up = ensure_dora_up()?;
            // `dora up` can only bind the default port, so retrying through it
            // is only meaningful on the default endpoint.
            let retry_via_up = skipped_up && is_default_endpoint();
            let name_args: Vec<String> = match &name {
                Some(n) => vec!["--name".to_string(), n.clone()],
                None => Vec::new(),
            };

            let t0 = std::time::Instant::now();
            if no_attach {
                let _ = std::fs::remove_file(&plan.report_path);
                let start = || {
                    Command::new("dora")
                        .arg("start")
                        .arg(&dataflow_path)
                        .arg("--detach")
                        .args(&name_args)
                        .args(coordinator_args())
                        .output()
                        .context("failed to run `dora` — is the dora CLI installed?")
                };
                let mut out = start()?;
                if !out.status.success() && retry_via_up {
                    // the coordinator answered but the dataflow would not start:
                    // bring the stack up properly and try once more
                    let _ = Command::new("dora").arg("up").status();
                    out = start()?;
                }
                // dora logs node spawning on stdout but prints the dataflow id
                // on stderr, so both are needed
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                print!("{stdout}");
                eprint!("{stderr}");
                // the wait below can be killed by an outer timeout; make sure
                // what we already know reaches the user's log either way
                use std::io::Write;
                let _ = std::io::stdout().flush();
                let _ = std::io::stderr().flush();
                if !out.status.success() {
                    bail!("dora start failed with {}", out.status);
                }
                let uuid = parse_dataflow_uuid(&stderr).or_else(|| parse_dataflow_uuid(&stdout));
                wait_for_report(&plan, uuid.as_deref(), timeout)?;
            } else {
                let start = || {
                    Command::new("dora")
                        .arg("start")
                        .arg(&dataflow_path)
                        .arg("--attach")
                        .args(&name_args)
                        .args(coordinator_args())
                        .status()
                        .context("failed to run `dora` — is the dora CLI installed?")
                };
                let mut status = start()?;
                if !status.success() && retry_via_up {
                    let _ = Command::new("dora").arg("up").status();
                    status = start()?;
                }
                if !status.success() {
                    bail!("dora start failed with {status}");
                }
            }
            let wall = t0.elapsed().as_secs_f64();
            println!("\nflow finished in {wall:.2}s");
            println!("report: {}", plan.report_path.display());
            if let Ok(report) = std::fs::read_to_string(&plan.report_path) {
                println!("{report}");
            }
            Ok(())
        }
    }
}
