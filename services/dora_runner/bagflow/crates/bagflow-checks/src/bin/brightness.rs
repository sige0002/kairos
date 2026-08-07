//! Exposure check (Rust): flags too-dark / blown-out frames. Drop-in
//! replacement for `nodes/brightness_check.py` — same env, same report fields.
//!
//! The reported `mean` is the mean over the pixel bytes as they arrive, which
//! is what the Python node does too. Note this makes the value depend on the
//! decode node's `PIXEL_FORMAT`: a BGR frame gives the plain channel average,
//! a gray frame gives the luma average. Keep DARK_MEAN / BRIGHT_MEAN and the
//! pixel format consistent within a flow.
//!
//! env:
//!   DARK_MEAN    frame is "too dark" below this mean intensity (default 30)
//!   BRIGHT_MEAN  frame is "too bright" above this mean intensity (default 225)
//!   MAX_RATIO    max acceptable ratio of bad frames (default 0.05)

use anyhow::Result;
use bagflow_checks::*;
use bagflow_node::BagflowNode;

fn main() -> Result<()> {
    let dark = env_f64("DARK_MEAN", 30.0);
    let bright = env_f64("BRIGHT_MEAN", 225.0);
    let max_ratio = env_f64("MAX_RATIO", 0.05);

    let mut node = BagflowNode::init()?;
    let (mut frames, mut too_dark, mut too_bright) = (0u64, 0u64, 0u64);
    let (mut m_min, mut m_max): (Option<f64>, Option<f64>) = (None, None);
    let mut m_sum = 0.0f64;

    while let Some(msg) = node.next_message()? {
        let f = frame_of(&msg)?;
        let sum: u64 = f.pixels.iter().map(|&p| p as u64).sum();
        let m = sum as f64 / f.pixels.len() as f64;
        frames += 1;
        m_sum += m;
        m_min = Some(m_min.map_or(m, |v: f64| v.min(m)));
        m_max = Some(m_max.map_or(m, |v: f64| v.max(m)));
        if m < dark {
            too_dark += 1;
        } else if m > bright {
            too_bright += 1;
        }
    }

    let bad = too_dark + too_bright;
    let ratio = if frames > 0 {
        bad as f64 / frames as f64
    } else {
        0.0
    };
    node.report(serde_json::json!({
        "check": "brightness",
        "frames": frames,
        "too_dark_frames": too_dark,
        "too_bright_frames": too_bright,
        "bad_ratio": round4(ratio),
        "mean": (frames > 0).then(|| round2(m_sum / frames as f64)),
        "min": m_min.map(round2),
        "max": m_max.map(round2),
        "ok": frames > 0 && ratio <= max_ratio,
    }))?;
    node.close()
}
