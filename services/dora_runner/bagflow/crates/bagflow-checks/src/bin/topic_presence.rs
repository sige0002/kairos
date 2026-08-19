//! Required-topic presence check (Rust) straight from the bag metadata — costs
//! no decoding and subscribes to nothing, so it is the whole of kairos'
//! `fast_validation` gate.
//!
//! Where `bagflow-topic-rate` answers "did every topic record, and fast enough",
//! this one answers the narrower question a recording template asks: **are the
//! topics I declared mandatory in this bag, with the message type I expect** —
//! and it never fails a topic merely for being empty (a bag recorded with "all
//! topics" legitimately carries dozens of service-result topics with 0 messages).
//!
//! env (set via the flow file):
//!   REQUIRED_TOPICS  JSON list of required topics. Either bare names
//!                    `["/joint_states"]` or specs
//!                    `[{"name": "/cam/*/image_raw", "type": "sensor_msgs/msg/Image"}]`.
//!                    A name is a glob (fnmatch: `*`, `?`, `[seq]`, `[!seq]`), so
//!                    one entry may cover several topics; `type` is optional and
//!                    filters the matches when present.
//!   MIN_MESSAGES     require each matched topic to hold at least this many
//!                    messages (default 0 = presence only).
//!
//! The bag's topic inventory comes from the CLI (`BAGFLOW_EXPECTED` = counts,
//! `BAGFLOW_TOPIC_TYPES` = message types), i.e. from `metadata.yaml`. Without it
//! there is no inventory to judge and the check reports `ok: false` with
//! `bag_metadata: false` rather than declaring every topic missing on no evidence.

use anyhow::Result;
use bagflow_node::BagflowNode;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

fn env_json(key: &str) -> Value {
    std::env::var(key)
        .ok()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_else(|| json!({}))
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

/// One entry of `REQUIRED_TOPICS`: a name glob and an optional message type.
struct Required {
    name: String,
    msg_type: Option<String>,
}

fn parse_required(value: &Value) -> Vec<Required> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| match item {
            Value::String(name) => Some(Required {
                name: name.clone(),
                msg_type: None,
            }),
            Value::Object(map) => map.get("name")?.as_str().map(|name| Required {
                name: name.to_string(),
                msg_type: map
                    .get("type")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
                    .map(str::to_string),
            }),
            _ => None,
        })
        .collect()
}

/// One `[...]` class: `Some((matches, index after the class))`, `None` when the
/// class is unterminated (fnmatch then treats the `[` as a literal).
fn class_match(pattern: &[char], start: usize, ch: char) -> Option<(bool, usize)> {
    let mut i = start + 1;
    let negated = i < pattern.len() && pattern[i] == '!';
    if negated {
        i += 1;
    }
    let body_start = i;
    // A `]` in first position is a member, not the terminator (fnmatch rule).
    if i < pattern.len() && pattern[i] == ']' {
        i += 1;
    }
    while i < pattern.len() && pattern[i] != ']' {
        i += 1;
    }
    if i >= pattern.len() {
        return None;
    }
    let body = &pattern[body_start..i];
    let mut hit = false;
    let mut k = 0;
    while k < body.len() {
        if k + 2 < body.len() && body[k + 1] == '-' {
            if body[k] <= ch && ch <= body[k + 2] {
                hit = true;
            }
            k += 3;
        } else {
            if body[k] == ch {
                hit = true;
            }
            k += 1;
        }
    }
    Some((hit != negated, i + 1))
}

/// Python `fnmatch.fnmatchcase` semantics — the matcher kairos' in-process
/// validator used, so a template written against it keeps its meaning here.
/// `*` spans `/` (a topic path is not a file path).
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        let matched = if pi < p.len() {
            match p[pi] {
                '*' => {
                    star = Some((pi, ti));
                    pi += 1;
                    continue;
                }
                '?' => {
                    pi += 1;
                    ti += 1;
                    continue;
                }
                '[' => match class_match(&p, pi, t[ti]) {
                    Some((hit, next)) => {
                        if hit {
                            pi = next;
                            ti += 1;
                            continue;
                        }
                        false
                    }
                    None => p[pi] == t[ti],
                },
                c => c == t[ti],
            }
        } else {
            false
        };
        if matched {
            pi += 1;
            ti += 1;
            continue;
        }
        // Backtrack: let the last `*` swallow one more character.
        match star {
            Some((sp, st)) => {
                pi = sp + 1;
                ti = st + 1;
                star = Some((sp, st + 1));
            }
            None => return false,
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// The verdict, split out of `main` so it can be tested without a dora node.
fn check(
    required: &[Required],
    counts: &BTreeMap<String, u64>,
    types: &BTreeMap<String, String>,
    min_messages: u64,
) -> Value {
    let mut missing: Vec<Value> = Vec::new();
    let mut matched_names: BTreeSet<String> = BTreeSet::new();

    for req in required {
        let by_name: Vec<&String> = counts
            .keys()
            .filter(|topic| glob_match(&req.name, topic))
            .collect();
        let candidates: Vec<&String> = match &req.msg_type {
            Some(want) => by_name
                .iter()
                .copied()
                .filter(|topic| types.get(*topic).map(String::as_str) == Some(want.as_str()))
                .collect(),
            None => by_name.clone(),
        };
        if candidates.is_empty() {
            let reason = if by_name.is_empty() {
                "topic not in bag"
            } else {
                // The name is there but carries a different message type — the
                // most confusing failure to debug, so it gets its own reason.
                "message type mismatch"
            };
            missing.push(json!({
                "name": req.name,
                "type": req.msg_type,
                "reason": reason,
                "found_types": by_name
                    .iter()
                    .filter_map(|t| types.get(*t))
                    .collect::<BTreeSet<_>>(),
            }));
            continue;
        }
        // A required topic that recorded too little is missing in substance.
        let recorded: Vec<&String> = candidates
            .iter()
            .copied()
            .filter(|topic| counts.get(*topic).copied().unwrap_or(0) >= min_messages)
            .collect();
        if recorded.is_empty() {
            missing.push(json!({
                "name": req.name,
                "type": req.msg_type,
                "reason": format!("fewer than {min_messages} messages recorded"),
                "messages": candidates
                    .iter()
                    .map(|t| counts.get(*t).copied().unwrap_or(0))
                    .max()
                    .unwrap_or(0),
            }));
            continue;
        }
        matched_names.extend(recorded.into_iter().cloned());
    }

    let extra: Vec<Value> = counts
        .iter()
        .filter(|(topic, _)| !matched_names.contains(*topic))
        .map(|(topic, count)| json!({"name": topic, "type": types.get(topic), "messages": count}))
        .collect();

    let mut record = json!({
        "check": "topic_presence",
        "required": required.len(),
        "matched": matched_names.len(),
        "topics_in_bag": counts.len(),
        "min_messages": min_messages,
        "bag_metadata": !counts.is_empty(),
        "missing": missing,
        "extra": extra,
        "ok": missing.is_empty() && !counts.is_empty(),
    });
    if counts.is_empty() {
        record["reason"] = json!(
            "no bag metadata.yaml — the topic inventory needed for this check is unavailable"
        );
    }
    record
}

fn main() -> Result<()> {
    let required = parse_required(&env_json("REQUIRED_TOPICS"));
    let min_messages = env_u64("MIN_MESSAGES", 0);
    let counts: BTreeMap<String, u64> =
        serde_json::from_value(env_json("BAGFLOW_EXPECTED")).unwrap_or_default();
    let types: BTreeMap<String, String> =
        serde_json::from_value(env_json("BAGFLOW_TOPIC_TYPES")).unwrap_or_default();

    // No data inputs: the helper returns immediately and we just report.
    let mut node = BagflowNode::init()?;
    while node.next_message()?.is_some() {}

    node.report(check(&required, &counts, &types, min_messages))?;
    node.close()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(pairs: &[(&str, u64)]) -> BTreeMap<String, u64> {
        pairs.iter().map(|(t, c)| (t.to_string(), *c)).collect()
    }

    fn types(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(t, ty)| (t.to_string(), ty.to_string()))
            .collect()
    }

    fn required(names: &[&str]) -> Vec<Required> {
        names
            .iter()
            .map(|n| Required {
                name: n.to_string(),
                msg_type: None,
            })
            .collect()
    }

    #[test]
    fn glob_literals_and_wildcards() {
        assert!(glob_match("/joint_states", "/joint_states"));
        assert!(!glob_match("/joint_states", "/joint_state"));
        assert!(glob_match("/hsrb/*", "/hsrb/joint_states"));
        // `*` spans `/`, like fnmatch (unlike shell globbing)
        assert!(glob_match("/cam/*/compressed", "/cam/a/b/compressed"));
        assert!(glob_match("*", "/anything"));
        assert!(glob_match("/a?c", "/abc"));
        assert!(!glob_match("/a?c", "/ac"));
        // trailing `*`s may match nothing
        assert!(glob_match("/abc**", "/abc"));
    }

    #[test]
    fn glob_character_classes() {
        assert!(glob_match("/cam[0-9]", "/cam3"));
        assert!(!glob_match("/cam[0-9]", "/camx"));
        assert!(glob_match("/cam[!0-9]", "/camx"));
        assert!(!glob_match("/cam[!0-9]", "/cam3"));
        // an unterminated class is a literal `[`
        assert!(glob_match("/cam[0", "/cam[0"));
    }

    #[test]
    fn passes_when_every_required_topic_is_present() {
        let out = check(
            &required(&["/joint_states"]),
            &counts(&[("/joint_states", 100), ("/tf", 5)]),
            &types(&[("/joint_states", "sensor_msgs/msg/JointState")]),
            0,
        );
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["missing"].as_array().unwrap().len(), 0);
        // Topics the template does not name surface as `extra`.
        assert_eq!(out["extra"][0]["name"], json!("/tf"));
    }

    #[test]
    fn empty_topics_are_present_not_missing() {
        // A "record everything" bag carries service-result topics with 0
        // messages; they must not fail a presence check.
        let out = check(
            &required(&["/joint_states"]),
            &counts(&[("/joint_states", 0)]),
            &types(&[]),
            0,
        );
        assert_eq!(out["ok"], json!(true));
    }

    #[test]
    fn min_messages_gates_a_present_but_empty_topic() {
        let out = check(
            &required(&["/joint_states"]),
            &counts(&[("/joint_states", 0)]),
            &types(&[]),
            1,
        );
        assert_eq!(out["ok"], json!(false));
        assert_eq!(out["missing"][0]["messages"], json!(0));
    }

    #[test]
    fn reports_a_missing_topic() {
        let out = check(
            &required(&["/joint_states"]),
            &counts(&[("/tf", 5)]),
            &types(&[]),
            0,
        );
        assert_eq!(out["ok"], json!(false));
        assert_eq!(out["missing"][0]["reason"], json!("topic not in bag"));
    }

    #[test]
    fn type_mismatch_is_named_as_such() {
        let spec = vec![Required {
            name: "/image".to_string(),
            msg_type: Some("sensor_msgs/msg/Image".to_string()),
        }];
        let out = check(
            &spec,
            &counts(&[("/image", 10)]),
            &types(&[("/image", "sensor_msgs/msg/CompressedImage")]),
            0,
        );
        assert_eq!(out["missing"][0]["reason"], json!("message type mismatch"));
        assert_eq!(
            out["missing"][0]["found_types"][0],
            json!("sensor_msgs/msg/CompressedImage")
        );
    }

    #[test]
    fn a_glob_matches_several_topics_at_once() {
        let out = check(
            &required(&["/cam/*/compressed"]),
            &counts(&[
                ("/cam/head/compressed", 10),
                ("/cam/hand/compressed", 10),
                ("/tf", 3),
            ]),
            &types(&[]),
            0,
        );
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["matched"], json!(2));
        assert_eq!(out["extra"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn no_metadata_is_reported_as_such_not_as_missing_topics() {
        let out = check(&required(&["/joint_states"]), &counts(&[]), &types(&[]), 0);
        assert_eq!(out["ok"], json!(false));
        assert_eq!(out["bag_metadata"], json!(false));
        assert!(out["reason"].is_string());
    }
}
