//! bagflow report aggregator node.
//!
//! Collects the `result` stream of every node (including the source), computes
//! per-input coverage against the bag metadata, writes the final report.json,
//! and broadcasts `done` so every upstream node may exit safely.
//!
//! This is the Rust counterpart of the original `python/report.py` and
//! produces a byte-for-byte equivalent report; it runs as the last node of
//! every flow, so keeping a Python interpreter off that path matters for the
//! post-recording quick gate.

use anyhow::{anyhow, Context, Result};
use arrow::array::{Array, StringArray, UInt8Array};
use dora_node_api::{dora_core::config::DataId, DoraNode, Event, Parameter};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

const SOURCE_ID: &str = "bagflow_source";

fn env_json(key: &str) -> Value {
    std::env::var(key)
        .ok()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_else(|| json!({}))
}

fn round(v: f64, places: i32) -> f64 {
    let f = 10f64.powi(places);
    (v * f).round() / f
}

/// received/sent row counts a node published on its `result` stream
#[derive(Default)]
struct Counts {
    received: BTreeMap<String, u64>,
    sent: BTreeMap<String, u64>,
}

fn counts_from(value: &Value) -> Counts {
    let get = |key: &str| -> BTreeMap<String, u64> {
        value
            .get(key)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default()
    };
    Counts {
        received: get("received"),
        sent: get("sent"),
    }
}

fn main() -> Result<()> {
    let report_path = std::path::PathBuf::from(
        std::env::var("BAGFLOW_REPORT").context("BAGFLOW_REPORT not set")?,
    );
    let expected: BTreeMap<String, u64> =
        serde_json::from_value(env_json("BAGFLOW_EXPECTED")).unwrap_or_default();
    let wiring: BTreeMap<String, BTreeMap<String, String>> =
        serde_json::from_value(env_json("BAGFLOW_WIRING")).unwrap_or_default();
    let mut bag_info = env_json("BAGFLOW_BAGINFO");
    let inputs: BTreeSet<String> = std::env::var("BAGFLOW_INPUTS")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let _guard = rt.enter();
    let (mut node, mut events) = DoraNode::init_from_env().map_err(|e| anyhow!("{e:?}"))?;

    let t0 = Instant::now();
    let mut results: Map<String, Value> = Map::new();
    let mut counts: BTreeMap<String, Counts> = BTreeMap::new();
    let mut eos: BTreeSet<String> = BTreeSet::new();
    // inputs the daemon closed on us, and those that closed without EOS
    let mut closed: BTreeSet<String> = BTreeSet::new();
    let mut crashed: BTreeSet<String> = BTreeSet::new();

    while let Some(event) = events.recv() {
        match event {
            Event::Input { id, metadata, data } => {
                let name = id.to_string(); // "result_<node id>"
                let node_id = name.strip_prefix("result_").unwrap_or(&name).to_string();
                if matches!(metadata.parameters.get("eos"), Some(Parameter::Bool(true))) {
                    eos.insert(name);
                    if inputs.iter().all(|i| eos.contains(i)) {
                        break;
                    }
                    continue;
                }
                let arr: arrow::array::ArrayRef = data.into();
                let Some(strings) = arr.as_any().downcast_ref::<StringArray>() else {
                    continue;
                };
                for i in 0..strings.len() {
                    let record: Value = match serde_json::from_str(strings.value(i)) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if let Some(c) = record.get("_bagflow_counts") {
                        counts.insert(node_id.clone(), counts_from(c));
                    } else if let Some(sent) = record.get("_bagflow_source") {
                        counts.insert(
                            node_id.clone(),
                            Counts {
                                received: BTreeMap::new(),
                                sent: serde_json::from_value(sent.clone()).unwrap_or_default(),
                            },
                        );
                    } else {
                        results
                            .entry(node_id.clone())
                            .or_insert_with(|| Value::Array(Vec::new()))
                            .as_array_mut()
                            .expect("results entries are arrays")
                            .push(record);
                    }
                }
            }
            // a node that dies never sends EOS on its result stream; the daemon
            // closes the input instead. Treat that as "this node is done, but
            // abnormally" so the flow still produces a report and every
            // surviving node gets its `done` ack rather than hanging forever.
            Event::InputClosed { id } => {
                let name = id.to_string();
                if !eos.contains(&name) {
                    crashed.insert(name.clone());
                }
                closed.insert(name);
                if inputs.iter().all(|i| eos.contains(i) || closed.contains(i)) {
                    break;
                }
            }
            Event::Stop(_) => break,
            _ => {}
        }
    }
    if !crashed.is_empty() {
        let nodes: Vec<&str> = crashed
            .iter()
            .map(|n| n.strip_prefix("result_").unwrap_or(n))
            .collect();
        eprintln!(
            "bagflow: node(s) exited without end-of-stream: {} — \
             the report is written anyway and lists them under `incomplete`",
            nodes.join(", ")
        );
    }

    let empty = Counts::default();
    let source_sent = &counts.get(SOURCE_ID).unwrap_or(&empty).sent;
    let mut coverage: Map<String, Value> = Map::new();
    for (node_id, wires) in &wiring {
        for (input_name, reference) in wires {
            let received = counts
                .get(node_id)
                .and_then(|c| c.received.get(input_name))
                .copied()
                .unwrap_or(0);
            let key = format!("{node_id}.{input_name}");
            if reference.starts_with('/') {
                // bag topic subscription
                let in_bag = expected.get(reference).copied();
                coverage.insert(
                    key,
                    json!({
                        "topic": reference,
                        "rows_received": received,
                        "rows_sent_by_source": source_sent.get(reference),
                        "rows_in_bag": in_bag,
                        "ratio_vs_bag": in_bag
                            .filter(|&c| c > 0)
                            .map(|c| round(received as f64 / c as f64, 4)),
                    }),
                );
            } else {
                // node-to-node edge: compare against the producer's sent count
                let (producer, output) = reference.split_once('/').unwrap_or((reference, ""));
                let sent = counts
                    .get(producer)
                    .and_then(|c| c.sent.get(output))
                    .copied();
                coverage.insert(
                    key,
                    json!({
                        "from": reference,
                        "rows_received": received,
                        "rows_sent_upstream": sent,
                        "ratio_vs_upstream": sent
                            .filter(|&c| c > 0)
                            .map(|c| round(received as f64 / c as f64, 4)),
                    }),
                );
            }
        }
    }

    // per-topic stats for the whole bag straight from metadata.yaml — lets a
    // quick post-recording flow flag missing topics / rate drops for free
    let duration_s = bag_info.get("duration_s").and_then(Value::as_f64);
    let mut topics: Map<String, Value> = Map::new();
    for (topic, &count) in &expected {
        topics.insert(
            topic.clone(),
            json!({
                "count": count,
                "hz": duration_s.filter(|d| *d != 0.0).map(|d| round(count as f64 / d, 2)),
            }),
        );
    }
    if let Some(obj) = bag_info.as_object_mut() {
        obj.insert("topics".to_string(), Value::Object(topics));
    }

    let node_received_rows: Map<String, Value> = counts
        .iter()
        .map(|(k, c)| (k.clone(), json!({"received": c.received, "sent": c.sent})))
        .collect();
    let incomplete: Vec<&String> = inputs.iter().filter(|i| !eos.contains(*i)).collect();

    let report = json!({
        "bag": bag_info,
        "results": results,
        "coverage": coverage,
        "node_received_rows": node_received_rows,
        "incomplete": incomplete,
        "wall_s": round(t0.elapsed().as_secs_f64(), 3),
    });

    if let Some(parent) = report_path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    // write atomically so `bagflow run --no-attach` never reads a partial file
    let tmp = report_path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&report)?)?;
    std::fs::rename(&tmp, &report_path)?;
    println!("BAGFLOW_REPORT_WRITTEN {}", report_path.display());

    node.send_output(
        DataId::from("done".to_owned()),
        Default::default(),
        UInt8Array::from(vec![1u8]),
    )
    .map_err(|e| anyhow!("{e:?}"))?;
    // linger until the daemon closes our inputs so `done` is delivered first
    while let Some(event) = events.recv() {
        if matches!(event, Event::Stop(_)) {
            break;
        }
    }
    Ok(())
}
