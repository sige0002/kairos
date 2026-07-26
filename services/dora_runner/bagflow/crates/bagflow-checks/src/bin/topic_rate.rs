//! Topic presence / rate check (Rust) straight from the bag metadata — costs
//! no decoding and subscribes to nothing. Drop-in replacement for
//! `nodes/topic_rate_check.py` — same env, same report fields.
//!
//! env (set via the flow file):
//!   EXPECT_HZ  JSON map of topic -> expected rate in Hz, e.g.
//!              '{"/camera/x/image_raw/compressed": 30}'
//!   TOLERANCE  accept actual_hz >= expected_hz * TOLERANCE (default 0.9)

use anyhow::Result;
use bagflow_checks::{env_f64, round2};
use bagflow_node::BagflowNode;
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn env_json(key: &str) -> Value {
    std::env::var(key)
        .ok()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_else(|| json!({}))
}

fn main() -> Result<()> {
    let expect_hz: BTreeMap<String, f64> =
        serde_json::from_value(env_json("EXPECT_HZ")).unwrap_or_default();
    let tolerance = env_f64("TOLERANCE", 0.9);
    let expected: BTreeMap<String, u64> =
        serde_json::from_value(env_json("BAGFLOW_EXPECTED")).unwrap_or_default();
    let duration = env_json("BAGFLOW_BAGINFO")
        .get("duration_s")
        .and_then(Value::as_f64);

    // no data inputs: the helper returns immediately and we just report
    let mut node = BagflowNode::init()?;
    while node.next_message()?.is_some() {}

    let mut failures: Vec<Value> = expected
        .iter()
        .filter(|(_, &c)| c == 0)
        .map(|(t, _)| json!({"topic": t, "reason": "no messages recorded"}))
        .collect();
    for (topic, &hz) in &expect_hz {
        let Some(&count) = expected.get(topic) else {
            failures.push(json!({"topic": topic, "reason": "topic not in bag"}));
            continue;
        };
        let Some(duration) = duration else { continue };
        let actual = count as f64 / duration;
        if actual < hz * tolerance {
            failures.push(json!({
                "topic": topic,
                "reason": "rate below expectation",
                "expected_hz": hz,
                "actual_hz": round2(actual),
            }));
        }
    }

    node.report(json!({
        "check": "topic_rate",
        "topics_in_bag": expected.len(),
        "checked_rates": expect_hz.len(),
        "failures": failures,
        "ok": failures.is_empty(),
    }))?;
    node.close()
}
