//! A topic whose payload stops decoding partway is the failure mode that a
//! validation pipeline must never be told about only implicitly. These tests
//! build a small MCAP in memory — one healthy topic, one whose third message
//! is truncated — and pin down both reader policies:
//!
//!  * default (lossy): the healthy topic is still read to the end, and the
//!    broken one is named in `Stats::failed_topics`
//!  * `strict`: the read stops with an error naming the topic
//!
//! Without the first guarantee a corrupt topic would silently shorten a bag;
//! without the second a caller that cannot tolerate partial data has no way
//! to say so.

use mcap2dora::{McapArrowReader, Mode, ReaderOptions};
use std::collections::BTreeMap;
use std::io::Cursor;

const SCHEMA: &str = "int32 a\nfloat64 b\n";

/// CDR encapsulation header + `a: i32` + 4 bytes padding + `b: f64`
fn good_payload(a: i32, b: f64) -> Vec<u8> {
    let mut v = vec![0x00, 0x01, 0x00, 0x00];
    v.extend_from_slice(&a.to_le_bytes());
    v.extend_from_slice(&[0u8; 4]); // CDR aligns the f64 to 8 bytes
    v.extend_from_slice(&b.to_le_bytes());
    v
}

/// same message with the trailing f64 cut short
fn truncated_payload(a: i32) -> Vec<u8> {
    let mut v = vec![0x00, 0x01, 0x00, 0x00];
    v.extend_from_slice(&a.to_le_bytes());
    v.extend_from_slice(&[0u8; 2]);
    v
}

fn build_bag() -> Vec<u8> {
    let mut w = mcap::Writer::new(Cursor::new(Vec::new())).expect("writer");
    let schema_id = w
        .add_schema("pkg/Pair", "ros2msg", SCHEMA.as_bytes())
        .expect("schema");
    let meta = BTreeMap::new();
    let healthy = w
        .add_channel(schema_id, "/healthy", "cdr", &meta)
        .expect("channel");
    let broken = w
        .add_channel(schema_id, "/broken", "cdr", &meta)
        .expect("channel");

    let mut seq = 0u32;
    let mut put = |w: &mut mcap::Writer<Cursor<Vec<u8>>>, ch: u16, t: u64, data: &[u8]| {
        seq += 1;
        w.write_to_known_channel(
            &mcap::records::MessageHeader {
                channel_id: ch,
                sequence: seq,
                log_time: t,
                publish_time: t,
            },
            data,
        )
        .expect("write");
    };

    for i in 0..5u64 {
        put(&mut w, healthy, i * 10, &good_payload(i as i32, i as f64));
        let payload = if i == 2 {
            truncated_payload(i as i32)
        } else {
            good_payload(i as i32, i as f64)
        };
        put(&mut w, broken, i * 10 + 1, &payload);
    }
    w.finish().expect("finish");
    w.into_inner().into_inner()
}

fn opts(strict: bool) -> ReaderOptions {
    ReaderOptions {
        mode: Mode::Decoded,
        max_batch_rows: 2, // flush early so a batch is emitted before the break
        strict,
        ..Default::default()
    }
}

#[test]
fn lossy_read_keeps_the_healthy_topic_and_names_the_broken_one() {
    let bag = build_bag();
    let mut reader = McapArrowReader::new(&bag, opts(false)).expect("reader");
    let mut rows: BTreeMap<String, usize> = BTreeMap::new();
    while let Some(tb) = reader.next_batch().expect("no error in lossy mode") {
        *rows.entry(tb.topic).or_default() += tb.batch.num_rows();
    }

    assert_eq!(
        rows.get("/healthy").copied(),
        Some(5),
        "a corrupt neighbour must not cost the healthy topic any rows"
    );
    let stats = reader.stats();
    assert_eq!(
        stats.failed_topics.len(),
        1,
        "the loss has to be reported, not merely implied by a short topic"
    );
    assert_eq!(stats.failed_topics[0].0, "/broken");
    assert!(rows.get("/broken").copied().unwrap_or(0) < 5);
}

#[test]
fn strict_read_stops_at_the_corrupt_message() {
    let bag = build_bag();
    let mut reader = McapArrowReader::new(&bag, opts(true)).expect("reader");
    let mut err = None;
    loop {
        match reader.next_batch() {
            Ok(Some(_)) => continue,
            Ok(None) => break,
            Err(e) => {
                err = Some(format!("{e:#}"));
                break;
            }
        }
    }
    let err = err.expect("strict mode must surface the decode failure");
    assert!(
        err.contains("/broken"),
        "error should name the topic: {err}"
    );
}

#[test]
fn topic_allowlist_skips_the_broken_topic_entirely() {
    let bag = build_bag();
    let mut o = opts(true);
    o.topics = Some(["/healthy".to_string()].into_iter().collect());
    let mut reader = McapArrowReader::new(&bag, o).expect("reader");
    let mut rows = 0;
    while let Some(tb) = reader.next_batch().expect("filtered read must not fail") {
        assert_eq!(tb.topic, "/healthy");
        rows += tb.batch.num_rows();
    }
    assert_eq!(rows, 5);
    assert!(
        reader.stats().filtered > 0,
        "the other topic must be counted as filtered"
    );
}
