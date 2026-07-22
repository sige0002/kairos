# Practice: a custom dora node that grayscales dora_live camera frames

> Verified working (2026-07-22, against the stack replaying the HSR sample bag).
> The minimal template for "I want to add my own processing to dora_live".

## What this example teaches

- **dora_live itself is never modified.** The consumer only attaches to the
  live-frames **pull contract** (`GET :8005/live/frames` index +
  `GET :8005/live/frame?topic=` payload, ETag/304) — the official extension
  seam (`docs/specs/en/dora_live.md`). The robot never learns this consumer
  exists; stopping it costs the robot nothing.
- **Your own dataflow under your own `dora run`,** using the dora CLI bundled
  in the dora_live image — fully outside the dataflow the kairos supervisor
  manages.
- The two real-world pitfalls (below) are part of the lesson.

## Files

| File | Role |
|---|---|
| `dataflow.yml` | one-node dataflow (driven by a 500 ms tick) |
| `grayscale_node.py` | the dora node: pull frames → cv2 grayscale → `/out/latest_gray.jpg` |
| `run_node.sh` | wrapper exec'ing the venv python (mandatory — see below) |

## Run it

Prerequisite: the kairos stack is up with LIVE=1 and a camera topic flowing
(`curl -s localhost:8005/live/frames` shows an index; use `make rosbag-loop`
for the sample bag).

```bash
mkdir -p /tmp/gray_out
docker run --rm --network host \
  -v $PWD/docs/examples/grayscale:/example:ro \
  -v /tmp/gray_out:/out \
  --entrypoint bash kairos-dora-live:jazzy -lc \
  "mkdir -p /tmp/ex && cp /example/dataflow.yml /tmp/ex/ && cd /tmp/ex && \
   /opt/venv/bin/dora run dataflow.yml"
```

Expected log (the topic is auto-picked; pin it via the `FRAME_TOPIC` env):

```
[grayscale] auto-selected topic: /hsrb/hand_camera/image_raw/compressed
[grayscale] #1 /hsrb/hand_camera/image_raw/compressed 640x480 mean=99.5
```

`/tmp/gray_out/latest_gray.jpg` keeps updating as a single-channel
(grayscale) image. Ctrl-C to stop.

## Pitfalls (the same ones production hits — avoidance included)

1. **dora executes `.py` nodes with the SYSTEM python and ignores the venv**
   (a venv python in `path:` is ignored too — bench-proven). The
   `run_node.sh` wrapper exec'ing the venv python is the supported bypass;
   kairos's own nodes launch the same way.
2. **`dora run` writes next to the dataflow file**, so pointing it at a yml on
   a read-only mount dies with `Read-only file system`. Copy the yml to a
   writable place first, as above.

## Extension hints

- Publish verdicts as live events: push to
  `POST :8005/internal/analysis/events` and read them via `GET /live/events`
  (the event-intake seam).
- ffmpeg (H.264) topic payloads are keyframe AUs that cv2 cannot decode
  (detect via the `X-Frame-Codec` header); see
  `services/dora_live/src/dora_live/video_decode.py` for PyAV decoding.
- The pull rate is capped by the robot-side `live/default.yaml`
  `frames.sample_hz` (default 2.0).
