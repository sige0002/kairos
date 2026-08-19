//! Shared image helpers for the Rust check nodes.
//!
//! These reproduce the OpenCV operations the Python reference nodes use
//! (`cvtColor(BGR2GRAY)`, `resize(INTER_AREA)`, `Laplacian(CV_16S)`) so that a
//! flow can swap `nodes/blur_check.py` for `bagflow-blur` without retuning
//! thresholds. Where OpenCV uses fixed-point internally we use the same
//! integer coefficients; the area resize is computed in f32 and matches
//! INTER_AREA to within rounding.

use anyhow::{Context, Result};
use arrow::array::{Array, UInt8Array};
use bagflow_node::{Msg, Param, Params};
use std::borrow::Cow;

/// Frame geometry carried in the message metadata by every decode node.
pub struct Frame<'a> {
    pub pixels: &'a [u8],
    pub width: usize,
    pub height: usize,
    pub channels: usize,
}

fn int_param(params: &Params, key: &str) -> Result<usize> {
    match params.get(key) {
        Some(Param::Integer(v)) => Ok(*v as usize),
        _ => anyhow::bail!("frame metadata is missing integer `{key}`"),
    }
}

/// Borrow a decoded frame out of a message (zero-copy view of shared memory).
pub fn frame_of(msg: &Msg) -> Result<Frame<'_>> {
    let arr = msg
        .data
        .as_any()
        .downcast_ref::<UInt8Array>()
        .context("expected a decoded frame (UInt8 array)")?;
    let width = int_param(&msg.params, "width")?;
    let height = int_param(&msg.params, "height")?;
    let channels = int_param(&msg.params, "channels")?;
    let need = width * height * channels;
    let pixels = arr.values();
    anyhow::ensure!(
        pixels.len() >= need,
        "frame is {} bytes but metadata says {width}x{height}x{channels}",
        pixels.len()
    );
    Ok(Frame {
        pixels: &pixels[..need],
        width,
        height,
        channels,
    })
}

/// BGR -> gray using OpenCV's fixed-point coefficients. A single-channel
/// frame (what `PIXEL_FORMAT=gray` decoding produces) is borrowed as-is.
pub fn to_gray<'a>(f: &Frame<'a>) -> Cow<'a, [u8]> {
    if f.channels == 1 {
        return Cow::Borrowed(f.pixels);
    }
    const B2Y: u32 = 1868;
    const G2Y: u32 = 9617;
    const R2Y: u32 = 4899;
    let c = f.channels;
    let mut out = Vec::with_capacity(f.width * f.height);
    out.extend(f.pixels.chunks_exact(c).map(|px| {
        let (b, g, r) = (px[0] as u32, px[1] as u32, px[2] as u32);
        ((b * B2Y + g * G2Y + r * R2Y + (1 << 13)) >> 14) as u8
    }));
    Cow::Owned(out)
}

/// Per-axis area-average weights: for every output index, the source range it
/// covers plus normalized weights. The geometry only depends on the two sizes,
/// so this is built once and reused for every frame.
struct AxisWeights {
    /// (offset into `w`, first source index, tap count) per output index
    spans: Vec<(usize, usize, usize)>,
    w: Vec<f32>,
}

impl AxisWeights {
    fn new(src: usize, dst: usize) -> Self {
        let scale = src as f32 / dst as f32;
        let mut spans = Vec::with_capacity(dst);
        let mut w = Vec::with_capacity(dst * (scale.ceil() as usize + 1));
        for d in 0..dst {
            let a = d as f32 * scale;
            let b = (a + scale).min(src as f32);
            let (i0, i1) = (a.floor() as usize, (b.ceil() as usize).min(src));
            let off = w.len();
            let mut total = 0.0;
            for s in i0..i1 {
                let ov = (b.min(s as f32 + 1.0) - a.max(s as f32)).max(0.0);
                w.push(ov);
                total += ov;
            }
            if total > 0.0 {
                w[off..].iter_mut().for_each(|v| *v /= total);
            }
            spans.push((off, i0, i1 - i0));
        }
        AxisWeights { spans, w }
    }
}

/// Area-average downscale with the semantics of `cv2.resize(..., INTER_AREA)`,
/// computed as two separable passes over precomputed weights. Interleaved
/// channels are handled together, matching the Python nodes which resize the
/// frame before reducing it.
pub struct AreaResize {
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
    channels: usize,
    x: AxisWeights,
    y: AxisWeights,
    /// horizontal-pass result: dw * sh * channels
    tmp: Vec<f32>,
    /// vertical-pass accumulator for one output row: dw * channels
    accum: Vec<f32>,
}

impl AreaResize {
    pub fn new(sw: usize, sh: usize, dw: usize, dh: usize, channels: usize) -> Self {
        AreaResize {
            sw,
            sh,
            dw,
            dh,
            channels,
            x: AxisWeights::new(sw, dw),
            y: AxisWeights::new(sh, dh),
            tmp: vec![0.0; dw * sh * channels],
            accum: vec![0.0; dw * channels],
        }
    }

    pub fn matches(&self, sw: usize, sh: usize, channels: usize) -> bool {
        (self.sw, self.sh, self.channels) == (sw, sh, channels)
    }

    pub fn output_len(&self) -> usize {
        self.dw * self.dh * self.channels
    }

    /// Resize `src` into `dst` (sized `output_len()`).
    pub fn apply(&mut self, src: &[u8], dst: &mut [u8]) {
        let c = self.channels;
        if (self.sw, self.sh) == (self.dw, self.dh) {
            dst.copy_from_slice(&src[..self.output_len()]);
            return;
        }
        let dwc = self.dw * c;
        // horizontal pass: sw x sh -> dw x sh, one source row at a time.
        // Single-channel frames (PIXEL_FORMAT=gray) get their own loop: the
        // taps then sit contiguously in the source row, which drops the
        // per-pixel stride multiply and lets the accumulation vectorize.
        for sy in 0..self.sh {
            let srow = &src[sy * self.sw * c..(sy + 1) * self.sw * c];
            let trow = &mut self.tmp[sy * dwc..(sy + 1) * dwc];
            if c == 1 {
                for (dx, &(off, i0, n)) in self.x.spans.iter().enumerate() {
                    let w = &self.x.w[off..off + n];
                    let s = &srow[i0..i0 + n];
                    let mut acc = 0.0;
                    for (&wk, &px) in w.iter().zip(s) {
                        acc += wk * px as f32;
                    }
                    trow[dx] = acc;
                }
            } else {
                for (dx, &(off, i0, n)) in self.x.spans.iter().enumerate() {
                    let w = &self.x.w[off..off + n];
                    for ch in 0..c {
                        let mut acc = 0.0;
                        for (k, &wk) in w.iter().enumerate() {
                            acc += wk * srow[(i0 + k) * c + ch] as f32;
                        }
                        trow[dx * c + ch] = acc;
                    }
                }
            }
        }
        // vertical pass: accumulate whole rows so the reads stay sequential
        // and the inner loop vectorizes
        for (dy, &(off, i0, n)) in self.y.spans.iter().enumerate() {
            self.accum.iter_mut().for_each(|v| *v = 0.0);
            for (k, &wk) in self.y.w[off..off + n].iter().enumerate() {
                let trow = &self.tmp[(i0 + k) * dwc..(i0 + k + 1) * dwc];
                for (a, &t) in self.accum.iter_mut().zip(trow) {
                    *a += wk * t;
                }
            }
            let out = &mut dst[dy * dwc..(dy + 1) * dwc];
            for (o, &a) in out.iter_mut().zip(self.accum.iter()) {
                *o = (a + 0.5).clamp(0.0, 255.0) as u8;
            }
        }
    }
}

/// One-shot convenience wrapper; prefer reusing an [`AreaResize`] per node.
pub fn resize_area(
    src: &[u8],
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
    channels: usize,
) -> Vec<u8> {
    let mut r = AreaResize::new(sw, sh, dw, dh, channels);
    let mut out = vec![0u8; r.output_len()];
    r.apply(src, &mut out);
    out
}

/// Variance of the 3x3 Laplacian, matching `cv2.Laplacian(gray, CV_16S)`
/// followed by `meanStdDev` — including OpenCV's BORDER_REFLECT_101 edges,
/// so the variance (and therefore any tuned BLUR_MIN) carries over exactly.
pub fn laplacian_var(gray: &[u8], w: usize, h: usize) -> f64 {
    if w < 2 || h < 2 {
        return 0.0;
    }
    // gfedcb|abcdefgh|gfedcba : index -1 reflects to 1, index n reflects to n-2
    let refl = |i: isize, n: usize| -> usize {
        if i < 0 {
            (-i) as usize
        } else if i as usize >= n {
            2 * n - 2 - i as usize
        } else {
            i as usize
        }
    };
    let mut sum: i64 = 0;
    let mut sum_sq: i64 = 0;

    // Interior pixels need no reflection at all, which is all but one row and
    // one column of the frame — keeping them in a branch-free loop over three
    // borrowed rows is what makes this cheap enough to keep up with the decoder.
    for y in 1..h - 1 {
        let up = &gray[(y - 1) * w..(y - 1) * w + w];
        let cur = &gray[y * w..y * w + w];
        let down = &gray[(y + 1) * w..(y + 1) * w + w];
        for x in 1..w - 1 {
            let lap = up[x] as i32 + down[x] as i32 + cur[x - 1] as i32 + cur[x + 1] as i32
                - 4 * cur[x] as i32;
            let lap = lap as i64;
            sum += lap;
            sum_sq += lap * lap;
        }
    }

    // the one-pixel frame around it, where BORDER_REFLECT_101 applies
    let mut edge = |y: usize, x: usize| {
        let up = refl(y as isize - 1, h) * w;
        let down = refl(y as isize + 1, h) * w;
        let cur = y * w;
        let left = refl(x as isize - 1, w);
        let right = refl(x as isize + 1, w);
        let lap = gray[up + x] as i32
            + gray[down + x] as i32
            + gray[cur + left] as i32
            + gray[cur + right] as i32
            - 4 * gray[cur + x] as i32;
        let lap = lap as i64;
        sum += lap;
        sum_sq += lap * lap;
    };
    for x in 0..w {
        edge(0, x);
        edge(h - 1, x);
    }
    for y in 1..h - 1 {
        edge(y, 0);
        edge(y, w - 1);
    }

    let n = (w * h) as f64;
    let mean = sum as f64 / n;
    (sum_sq as f64 / n) - mean * mean
}

/// `WxH` env spec shared by the decode and check nodes.
pub fn parse_resize(spec: &str) -> Result<Option<(usize, usize)>> {
    if spec.is_empty() {
        return Ok(None);
    }
    let (w, h) = spec
        .to_lowercase()
        .split_once('x')
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .context("resize spec must look like 224x224")?;
    Ok(Some((w.parse()?, h.parse()?)))
}

pub fn env_f64(key: &str, default: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

pub fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

pub fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

pub fn round4(v: f64) -> f64 {
    (v * 10000.0).round() / 10000.0
}
