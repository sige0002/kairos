//! bagflow source node: streams the subscribed rostopics of a rosbag (mcap)
//! into dora as Arrow StructArrays (one per batch, all decoded columns).
//!
//! Termination protocol: after the bag is exhausted it sends an `eos`-flagged
//! empty message on every output, a final counts record on `result`, and then
//! waits for the report node's `done` signal before exiting (dora reclaims
//! unconsumed shared-memory buffers shortly after a node exits).

use anyhow::{anyhow, bail, Context, Result};
use arrow::array::{Array, LargeBinaryArray, StringArray, StructArray, TimestampNanosecondArray};
use dora_node_api::{dora_core::config::DataId, DoraNode, Event, Parameter};
use mcap2dora::{map_file, McapArrowReader, Mode, ReaderOptions};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::Instant;

fn mcap_files(bag: &Path) -> Result<Vec<PathBuf>> {
    if bag.is_file() {
        return Ok(vec![bag.to_path_buf()]);
    }
    let mut v: Vec<PathBuf> = std::fs::read_dir(bag)
        .with_context(|| format!("read bag dir {}", bag.display()))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "mcap"))
        .collect();
    v.sort();
    if v.is_empty() {
        bail!("no .mcap files in {}", bag.display());
    }
    Ok(v)
}

fn eos_params() -> BTreeMap<String, Parameter> {
    BTreeMap::from([("eos".to_string(), Parameter::Bool(true))])
}

fn main() -> Result<()> {
    let bag = PathBuf::from(std::env::var("BAGFLOW_BAG").context("BAGFLOW_BAG not set")?);
    // topic name -> dora output id
    let topics: HashMap<String, String> =
        serde_json::from_str(&std::env::var("BAGFLOW_TOPICS").context("BAGFLOW_TOPICS not set")?)?;

    let batch_rows: usize = std::env::var("BAGFLOW_BATCH_ROWS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(64);
    let batch_bytes: usize = std::env::var("BAGFLOW_BATCH_BYTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8 << 20);

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let _guard = rt.enter();
    let (mut node, mut events) = DoraNode::init_from_env().map_err(|e| anyhow!("{e:?}"))?;

    let t0 = Instant::now();
    let mut counts: HashMap<String, u64> = HashMap::new();
    let mut bytes = 0u64;
    // the reader keeps going when a topic fails to decode, so its stats are the
    // only place a partial read shows up; accumulate them across split files and
    // report them, otherwise the loss reaches report.json as an unexplained
    // coverage shortfall
    let mut skipped = 0u64;
    let mut failed_topics: Vec<serde_json::Value> = Vec::new();
    let mut fallback_topics: Vec<serde_json::Value> = Vec::new();
    // A recording killed by a power cut or SIGKILL leaves a half-written final
    // chunk, which is exactly the kind of bag this framework exists to flag.
    // Treat a read error as "the data ends here": stop reading, but still send
    // EOS and the counts so the flow completes and report.json says what
    // happened. Bailing out instead would leave every downstream node waiting
    // for an end-of-stream that can no longer come.
    let mut read_error: Option<String> = None;

    // kairos vendoring: a metadata-only flow (only `bagflow-topic-presence` /
    // `bagflow-topic-rate`) subscribes to nothing. Scanning the bag would then
    // walk every message just to discard it — seconds on a multi-GB recording —
    // so skip the read and report empty counts.
    let files = if topics.is_empty() {
        Vec::new()
    } else {
        mcap_files(&bag)?
    };
    'files: for file in files {
        let mapped = match map_file(&file) {
            Ok(m) => m,
            Err(e) => {
                read_error = Some(format!("{}: {e:#}", file.display()));
                break 'files;
            }
        };
        let mut reader = match McapArrowReader::new(
            &mapped,
            ReaderOptions {
                mode: Mode::Decoded,
                max_batch_rows: batch_rows,
                max_batch_bytes: batch_bytes,
                // decode only what the flow subscribes to: on a bag with many
                // topics the messages nobody reads dominate the scan otherwise
                topics: Some(topics.keys().cloned().collect()),
                // deliberately not strict: a topic that fails to decode should
                // not stop the rest of the bag from being validated. The loss
                // is surfaced in the `source_read` record instead.
                ..Default::default()
            },
        ) {
            Ok(r) => r,
            Err(e) => {
                read_error = Some(format!("{}: {e:#}", file.display()));
                break 'files;
            }
        };
        loop {
            let tb = match reader.next_batch() {
                Ok(Some(tb)) => tb,
                Ok(None) => break,
                Err(e) => {
                    read_error = Some(format!("{}: {e:#}", file.display()));
                    eprintln!("bagflow_source: read stopped early — {e:#}");
                    break;
                }
            };
            let Some(out_id) = topics.get(&tb.topic) else {
                continue;
            };
            let batch = tb.batch;
            let n = batch.num_rows();
            if n == 0 {
                continue;
            }
            let log_time = batch
                .column_by_name("log_time")
                .context("no log_time column")?
                .as_any()
                .downcast_ref::<TimestampNanosecondArray>()
                .context("log_time is not a timestamp column")?;
            let params = BTreeMap::from([
                ("rows".to_string(), Parameter::Integer(n as i64)),
                ("t0".to_string(), Parameter::Integer(log_time.value(0))),
                ("t1".to_string(), Parameter::Integer(log_time.value(n - 1))),
            ]);
            let sa = StructArray::from(batch);
            bytes += sa.get_array_memory_size() as u64;
            *counts.entry(tb.topic.clone()).or_default() += n as u64;
            node.send_output(DataId::from(out_id.clone()), params, sa)
                .map_err(|e| anyhow!("{e:?}"))?;
        }
        let stats = reader.stats();
        skipped += stats.skipped;
        let file_name = file.display().to_string();
        for (topic, reason) in &stats.failed_topics {
            failed_topics
                .push(serde_json::json!({"topic": topic, "reason": reason, "file": file_name }));
        }
        for (topic, reason) in &stats.fallback_topics {
            fallback_topics
                .push(serde_json::json!({"topic": topic, "reason": reason, "file": file_name }));
        }
        if read_error.is_some() {
            break 'files;
        }
    }

    for out_id in topics.values() {
        node.send_output(
            DataId::from(out_id.clone()),
            eos_params(),
            LargeBinaryArray::from_vec(Vec::<&[u8]>::new()),
        )
        .map_err(|e| anyhow!("{e:?}"))?;
    }

    let result = DataId::from("result".to_owned());
    // read health, so a topic that failed to decode is named in report.json
    // instead of only showing up as a coverage number that does not add up
    let health = serde_json::json!({
        "check": "source_read",
        "messages_skipped": skipped,
        "failed_topics": failed_topics,
        "fallback_topics": fallback_topics,
        // set when the bag could not be read to the end — a truncated
        // recording. `coverage` then shows how much of each topic was reached.
        "read_error": read_error,
        "ok": skipped == 0 && failed_topics.is_empty() && read_error.is_none(),
    });
    node.send_output(
        result.clone(),
        BTreeMap::new(),
        StringArray::from(vec![health.to_string()]),
    )
    .map_err(|e| anyhow!("{e:?}"))?;
    let record = serde_json::json!({ "_bagflow_source": counts }).to_string();
    node.send_output(
        result.clone(),
        BTreeMap::new(),
        StringArray::from(vec![record]),
    )
    .map_err(|e| anyhow!("{e:?}"))?;
    node.send_output(
        result,
        eos_params(),
        StringArray::from(Vec::<String>::new()),
    )
    .map_err(|e| anyhow!("{e:?}"))?;

    let wall = t0.elapsed().as_secs_f64();
    let total: u64 = counts.values().sum();
    println!(
        "BAGFLOW_SOURCE_DONE rows={total} topics={} mb={:.1} wall_s={wall:.2}",
        counts.len(),
        bytes as f64 / 1e6
    );

    while let Some(event) = events.recv() {
        match event {
            Event::Input { id, .. } if id.as_str() == "done" => break,
            Event::Stop(_) => break,
            _ => {}
        }
    }
    Ok(())
}
