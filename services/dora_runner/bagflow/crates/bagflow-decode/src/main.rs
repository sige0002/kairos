//! CPU decode node: JPEG (CompressedImage topic batches) -> raw frames,
//! one message per frame. Same contract as nodes/decode_image.py.
//!
//! env:
//!   RESIZE        output resolution "WxH" (default: native). libjpeg's
//!                 DCT-domain scaling decodes at the nearest n/8 size above
//!                 the target, then an exact SIMD resize produces WxH —
//!                 changing resolution is a flow.yml edit, not a code change.
//!   PIXEL_FORMAT  bgr (default) | gray. `gray` decodes the luma plane only:
//!                 libjpeg skips chroma upsampling and color conversion, and
//!                 the frame that goes over shared memory is 3x smaller.
//!                 Every consumer that only needs intensity (blur, exposure,
//!                 freeze) gets cheaper too — see `channels` in the metadata.
//!   WORKERS       decode threads (default: min(8, cpus))

use anyhow::{Context, Result};
use arrow::array::{Array, LargeBinaryArray, StructArray, TimestampNanosecondArray, UInt8Array};
use bagflow_node::{BagflowNode, Param, Params};
use fast_image_resize::images::{Image as FirImage, ImageRef};
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use rayon::prelude::*;
use std::cell::RefCell;
use std::time::Instant;
use turbojpeg::{Decompressor, Image, PixelFormat, ScalingFactor};

thread_local! {
    static DECOMP: RefCell<Option<Decompressor>> = const { RefCell::new(None) };
    /// reused across frames: decompress target before the exact resize, so a
    /// per-frame allocate-and-zero of the intermediate image disappears
    static SCRATCH: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    /// Resizer allocates internal state and probes CPU features on construction
    static RESIZER: RefCell<Resizer> = RefCell::new(Resizer::new());
}

/// decoded pixels plus the width and height they came out at
type Decoded = (Vec<u8>, usize, usize);

#[derive(Clone, Copy, PartialEq)]
enum OutFmt {
    Bgr,
    Gray,
}

impl OutFmt {
    fn parse(spec: &str) -> Result<Self> {
        match spec.to_lowercase().as_str() {
            "" | "bgr" => Ok(OutFmt::Bgr),
            "gray" | "grey" => Ok(OutFmt::Gray),
            other => anyhow::bail!("PIXEL_FORMAT must be `bgr` or `gray`, got `{other}`"),
        }
    }
    fn channels(self) -> usize {
        match self {
            OutFmt::Bgr => 3,
            OutFmt::Gray => 1,
        }
    }
    fn tj(self) -> PixelFormat {
        match self {
            OutFmt::Bgr => PixelFormat::BGR,
            OutFmt::Gray => PixelFormat::GRAY,
        }
    }
    fn fir(self) -> PixelType {
        match self {
            OutFmt::Bgr => PixelType::U8x3,
            OutFmt::Gray => PixelType::U8,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            OutFmt::Bgr => "bgr",
            OutFmt::Gray => "gray",
        }
    }
}

fn parse_resize(spec: &str) -> Result<Option<(usize, usize)>> {
    if spec.is_empty() {
        return Ok(None);
    }
    let (w, h) = spec
        .to_lowercase()
        .split_once('x')
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .context("RESIZE must look like 224x224")?;
    Ok(Some((w.parse()?, h.parse()?)))
}

/// smallest n/8 DCT scaling whose output still covers the target size
fn pick_factor(w: usize, h: usize, tw: usize, th: usize) -> ScalingFactor {
    for num in 1..=8 {
        let f = ScalingFactor::new(num, 8);
        if f.scale(w) >= tw && f.scale(h) >= th {
            return f;
        }
    }
    ScalingFactor::ONE
}

fn resize_exact(
    src_pixels: &[u8],
    w: usize,
    h: usize,
    tw: usize,
    th: usize,
    fmt: OutFmt,
) -> Result<Vec<u8>> {
    // borrowed view over the scratch buffer — no copy of the source frame
    let src = ImageRef::new(w as u32, h as u32, src_pixels, fmt.fir())?;
    let mut dst = FirImage::new(tw as u32, th as u32, fmt.fir());
    RESIZER.with(|r| {
        r.borrow_mut().resize(
            &src,
            &mut dst,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Box)),
        )
    })?;
    Ok(dst.into_vec())
}

fn decode_one(jpg: &[u8], target: Option<(usize, usize)>, fmt: OutFmt) -> Option<Decoded> {
    DECOMP.with(|cell| {
        let mut slot = cell.borrow_mut();
        let d = match slot.as_mut() {
            Some(d) => d,
            None => {
                *slot = Some(Decompressor::new().ok()?);
                slot.as_mut().unwrap()
            }
        };
        let header = d.read_header(jpg).ok()?;
        let (w, h) = (header.width, header.height);
        let factor = match target {
            Some((tw, th)) => pick_factor(w, h, tw, th),
            None => ScalingFactor::ONE,
        };
        d.set_scaling_factor(factor).ok()?;
        let (sw, sh) = (factor.scale(w), factor.scale(h));
        let ch = fmt.channels();
        let need = sw * sh * ch;

        // when an exact resize follows, decompress into the reusable scratch
        // buffer; the resize writes the frame we actually hand downstream
        match target {
            Some((tw, th)) if (sw, sh) != (tw, th) => SCRATCH.with(|sc| {
                let mut buf = sc.borrow_mut();
                if buf.len() < need {
                    buf.resize(need, 0);
                }
                let image = Image {
                    pixels: &mut buf[..need],
                    width: sw,
                    pitch: sw * ch,
                    height: sh,
                    format: fmt.tj(),
                };
                d.decompress(jpg, image).ok()?;
                let out = resize_exact(&buf[..need], sw, sh, tw, th, fmt).ok()?;
                Some((out, tw, th))
            }),
            _ => {
                let mut pixels = vec![0u8; need];
                let image = Image {
                    pixels: &mut pixels[..],
                    width: sw,
                    pitch: sw * ch,
                    height: sh,
                    format: fmt.tj(),
                };
                d.decompress(jpg, image).ok()?;
                Some((pixels, sw, sh))
            }
        }
    })
}

fn frame_params(w: usize, h: usize, ch: usize, stamp_ns: i64) -> Params {
    Params::from([
        ("rows".to_string(), Param::Integer(1)),
        ("width".to_string(), Param::Integer(w as i64)),
        ("height".to_string(), Param::Integer(h as i64)),
        ("channels".to_string(), Param::Integer(ch as i64)),
        ("stamp_ns".to_string(), Param::Integer(stamp_ns)),
    ])
}

fn main() -> Result<()> {
    let target = parse_resize(&std::env::var("RESIZE").unwrap_or_default())?;
    let fmt = OutFmt::parse(&std::env::var("PIXEL_FORMAT").unwrap_or_default())?;
    let workers = std::env::var("WORKERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| std::cmp::min(8, num_cpus()));
    rayon::ThreadPoolBuilder::new()
        .num_threads(workers)
        .build_global()?;

    let mut node = BagflowNode::init()?;
    let t0 = Instant::now();
    let mut frames = 0u64;
    let mut failed = 0u64;

    while let Some(msg) = node.next_message()? {
        let batch = msg
            .data
            .as_any()
            .downcast_ref::<StructArray>()
            .context("expected a topic batch (StructArray)")?;
        let data = batch
            .column_by_name("data")
            .context("no data column")?
            .as_any()
            .downcast_ref::<LargeBinaryArray>()
            .context("data is not LargeBinary")?;
        let stamps = batch
            .column_by_name("log_time")
            .context("no log_time column")?
            .as_any()
            .downcast_ref::<TimestampNanosecondArray>()
            .context("log_time is not a timestamp")?;

        let inputs: Vec<(&[u8], i64)> = (0..data.len())
            .map(|i| (data.value(i), stamps.value(i)))
            .collect();
        let decoded: Vec<(Option<Decoded>, i64)> = inputs
            .par_iter()
            .map(|(jpg, ts)| (decode_one(jpg, target, fmt), *ts))
            .collect();
        for (result, ts) in decoded {
            match result {
                Some((pixels, w, h)) => {
                    node.send(
                        "frames",
                        UInt8Array::from(pixels),
                        frame_params(w, h, fmt.channels(), ts),
                    )?;
                    frames += 1;
                }
                None => failed += 1,
            }
        }
    }

    node.report(serde_json::json!({
        "check": "decode",
        "backend": "cpu-turbojpeg",
        "frames_decoded": frames,
        "decode_failures": failed,
        "output_resolution": target.map(|(w, h)| format!("{w}x{h}")).unwrap_or("native".into()),
        "pixel_format": fmt.as_str(),
        "wall_s": (t0.elapsed().as_secs_f64() * 1000.0).round() / 1000.0,
        // a topic wired to the wrong input (a compressedDepth stream, say)
        // decodes nothing at all; say so instead of leaving the consumer to
        // infer it from a frame count of zero
        "ok": frames > 0 && failed == 0,
    }))?;
    node.close()
}

fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}
