//! Blur check (Rust): variance of the Laplacian per decoded frame. Drop-in
//! replacement for `nodes/blur_check.py` — same env, same report fields.
//!
//! env:
//!   BLUR_MIN   minimum acceptable Laplacian variance (default 60)
//!   MAX_RATIO  max acceptable ratio of blurry frames (default 0.05)
//!   RESIZE     evaluate at this resolution, e.g. "224x224" (default: native).
//!              A frame that already arrives at this size is used as-is.
//!   STRIDE     analyze every Nth frame (default 1 = all)
//!
//! WORKERS is accepted for flow compatibility but ignored: the analysis costs
//! roughly 20us per frame here, so it keeps up with the decoder inline and the
//! report always states the single worker actually used.

use anyhow::Result;
use bagflow_checks::*;
use bagflow_node::BagflowNode;

fn main() -> Result<()> {
    let blur_min = env_f64("BLUR_MIN", 60.0);
    let max_ratio = env_f64("MAX_RATIO", 0.05);
    let resize = parse_resize(&std::env::var("RESIZE").unwrap_or_default())?;
    let stride = env_usize("STRIDE", 1).max(1);

    let mut node = BagflowNode::init()?;
    let (mut frames, mut blurry, mut seen) = (0u64, 0u64, 0u64);
    let mut v_min: Option<f64> = None;
    let mut v_sum = 0.0f64;
    // reused whenever the frame does not already arrive at the eval resolution
    let mut resizer: Option<AreaResize> = None;
    let mut scaled = Vec::new();

    while let Some(msg) = node.next_message()? {
        seen += 1;
        if (seen - 1) % stride as u64 != 0 {
            continue;
        }
        let f = frame_of(&msg)?;
        let gray = to_gray(&f);
        let (gray, w, h) = match resize {
            Some((rw, rh)) if (f.width, f.height) != (rw, rh) => {
                if !resizer.as_ref().is_some_and(|r| r.matches(f.width, f.height, 1)) {
                    let r = AreaResize::new(f.width, f.height, rw, rh, 1);
                    scaled = vec![0u8; r.output_len()];
                    resizer = Some(r);
                }
                resizer
                    .as_mut()
                    .expect("resizer initialized above")
                    .apply(&gray, &mut scaled);
                (std::borrow::Cow::Borrowed(scaled.as_slice()), rw, rh)
            }
            _ => (gray, f.width, f.height),
        };
        let v = laplacian_var(&gray, w, h);
        frames += 1;
        v_sum += v;
        v_min = Some(v_min.map_or(v, |m: f64| m.min(v)));
        if v < blur_min {
            blurry += 1;
        }
    }

    let ratio = if frames > 0 {
        blurry as f64 / frames as f64
    } else {
        0.0
    };
    node.report(serde_json::json!({
        "check": "blur",
        "frames": frames,
        "blurry_frames": blurry,
        "blurry_ratio": round4(ratio),
        "laplacian_var_min": v_min.map(round2),
        "laplacian_var_mean": (frames > 0).then(|| round2(v_sum / frames as f64)),
        "threshold": blur_min,
        "eval_resolution": resize.map(|(w, h)| format!("{w}x{h}")).unwrap_or("native".into()),
        "workers": 1,
        "stride": stride,
        "frames_seen": seen,
        "ok": frames > 0 && ratio <= max_ratio,
    }))?;
    node.close()
}
