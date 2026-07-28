//! Frozen-camera check (Rust): detects runs of (nearly) identical consecutive
//! frames. Drop-in replacement for `nodes/freeze_check.py` — same env, same
//! report fields, same 160x120 comparison resolution.
//!
//! env:
//!   FREEZE_EPS  mean absolute pixel difference below which two consecutive
//!               frames count as identical (default 0.3)
//!   MAX_RUN     longest acceptable run of identical frames (default 5)

use anyhow::Result;
use bagflow_checks::*;
use bagflow_node::BagflowNode;

const CMP_W: usize = 160;
const CMP_H: usize = 120;

fn main() -> Result<()> {
    let eps = env_f64("FREEZE_EPS", 0.3);
    let max_run = env_usize("MAX_RUN", 5);

    let mut node = BagflowNode::init()?;
    let (mut frames, mut frozen_pairs) = (0u64, 0u64);
    let (mut run, mut longest_run) = (0usize, 0usize);
    // the resize geometry is fixed for a camera, so the weight tables and both
    // comparison buffers are allocated once and swapped frame to frame
    let mut resizer: Option<AreaResize> = None;
    let (mut prev, mut cur) = (Vec::new(), Vec::new());
    let mut have_prev = false;

    while let Some(msg) = node.next_message()? {
        let f = frame_of(&msg)?;
        if !resizer
            .as_ref()
            .is_some_and(|r| r.matches(f.width, f.height, f.channels))
        {
            let r = AreaResize::new(f.width, f.height, CMP_W, CMP_H, f.channels);
            prev = vec![0u8; r.output_len()];
            cur = vec![0u8; r.output_len()];
            have_prev = false;
            resizer = Some(r);
        }
        let r = resizer.as_mut().expect("resizer initialized above");
        r.apply(f.pixels, &mut cur);
        frames += 1;
        if have_prev {
            let sum: u64 = prev
                .iter()
                .zip(cur.iter())
                .map(|(&a, &b)| a.abs_diff(b) as u64)
                .sum();
            let diff = sum as f64 / cur.len() as f64;
            if diff < eps {
                frozen_pairs += 1;
                run += 1;
                longest_run = longest_run.max(run);
            } else {
                run = 0;
            }
        }
        std::mem::swap(&mut prev, &mut cur);
        have_prev = true;
    }

    node.report(serde_json::json!({
        "check": "freeze",
        "frames": frames,
        "frozen_pairs": frozen_pairs,
        "longest_freeze_run": longest_run,
        "ok": frames > 0 && longest_run < max_run,
    }))?;
    node.close()
}
