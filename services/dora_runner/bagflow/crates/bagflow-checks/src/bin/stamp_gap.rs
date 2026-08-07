//! Message-gap check (Rust): looks at log_time intervals of any rostopic to
//! catch dropouts and stalls. Drop-in replacement for
//! `nodes/stamp_gap_check.py` — same env, same report fields.
//!
//! env:
//!   GAP_MS      absolute gap threshold in milliseconds; if unset, uses
//!               GAP_FACTOR x median interval
//!   GAP_FACTOR  relative threshold vs the median interval (default 3.0)
//!   MAX_GAPS    max acceptable number of over-threshold gaps (default 0)

use anyhow::{Context, Result};
use arrow::array::{Array, StructArray, TimestampNanosecondArray};
use bagflow_checks::{env_f64, env_usize, round2};
use bagflow_node::BagflowNode;

fn main() -> Result<()> {
    let gap_ms: Option<f64> = std::env::var("GAP_MS").ok().and_then(|v| v.parse().ok());
    let gap_factor = env_f64("GAP_FACTOR", 3.0);
    let max_gaps = env_usize("MAX_GAPS", 0);

    let mut node = BagflowNode::init()?;
    let mut stamps: Vec<i64> = Vec::new();

    while let Some(msg) = node.next_message()? {
        let batch = msg
            .data
            .as_any()
            .downcast_ref::<StructArray>()
            .context("expected a topic batch (StructArray)")?;
        let ts = batch
            .column_by_name("log_time")
            .context("no log_time column")?
            .as_any()
            .downcast_ref::<TimestampNanosecondArray>()
            .context("log_time is not a timestamp")?;
        stamps.extend_from_slice(ts.values());
    }

    let mut deltas_ms: Vec<f64> = stamps.windows(2).map(|w| (w[1] - w[0]) as f64 / 1e6).collect();
    if deltas_ms.is_empty() {
        node.report(serde_json::json!({
            "check": "stamp_gap",
            "messages": stamps.len(),
            "ok": false,
        }))?;
        return node.close();
    }

    // numpy's median: average of the two middle values for an even count
    let mut sorted = deltas_ms.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let n = sorted.len();
    let median = if n.is_multiple_of(2) {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    } else {
        sorted[n / 2]
    };
    let threshold = gap_ms.unwrap_or(median * gap_factor);
    let over = deltas_ms.iter().filter(|&&d| d > threshold).count();
    let max_gap = deltas_ms.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    deltas_ms.clear();

    node.report(serde_json::json!({
        "check": "stamp_gap",
        "messages": n + 1,
        "median_interval_ms": round2(median),
        "max_gap_ms": round2(max_gap),
        "threshold_ms": round2(threshold),
        "gaps_over_threshold": over,
        "ok": over <= max_gaps,
    }))?;
    node.close()
}
