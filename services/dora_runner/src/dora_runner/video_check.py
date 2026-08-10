"""``video_check`` pipeline: on-demand mp4 preview of a camera topic.

Event-driven (button -> job), post-hoc, and read-only with respect to the
canonical recording: it only READS the finished MCAP under
``objects/<capture_id>`` to decode a single image topic's frames into an mp4,
so it can never disturb an in-flight recording (it only ever runs on finished
captures).
It NEVER auto-converts — a user picks a camera topic and presses the button.

The encode dependencies (``av`` = PyAV, which bundles ffmpeg, and ``Pillow``
for JPEG decode) are **lazy-imported inside** :func:`run_video_check` (mirroring
the ROS nodes' lazy rclpy import) so this module — and the dora service — still
import and boot when those packages are absent. The happy path is a
``sensor_msgs/CompressedImage`` JPEG topic; a raw ``sensor_msgs/Image`` topic is
skipped with a clear note rather than crashing.

The mp4 is written under ``data/report/video_check/<capture_id>/<topic>.mp4`` and the
summary carries the path **relative to data_dir** (``file``) so the frontend can
build the guarded ``/api/v1/files/<file>`` URL to play it.

Results are CACHED per (capture_id, topic): the summary is persisted as a
``<topic>.summary.json`` sidecar beside the mp4, and a later job for the same
pair returns it instantly (``cached: true``) instead of re-decoding and
re-encoding — a finished run's MCAP is immutable, so the artifact stays valid.
Freshness is still guarded by mtime (a re-recorded run id or a deleted mp4
regenerates) and by the pipeline version; ``params.force`` bypasses the cache.
"""

from __future__ import annotations

import io
import json
import os
import re
import threading
from pathlib import Path
from typing import Any

from kairos_common import utc_now_iso8601
from kairos_common.atomic_io import atomic_write_text

from dora_runner.mcap_utils import (
    find_mcap,
    iter_decoded_ros2_messages,
    iter_topic_times,
    resolve_source_dir,
    source_times,
    topic_message_count,
)
from dora_runner.models import JobCanceled

# Pipeline identity stamped into the summary (reproducibility contract, shared
# with the other bundled pipelines and the hello_dora plugin example).
# 1.2.0: fps estimated from publish_time when the bag recorded it (log_time
# fallback); summary gained ``fps_time_source``.
# 1.2.1: the clock choice is now decided over the whole topic (was the capped
# cadence prefix), so it never disagrees with loss_report; tightened trust rule.
# 1.3.0: encoder knobs (VIDEO_ENCODE_THREADS/PRESET/CRF). Defaults keep x264's
# own quality settings (preset medium, crf 23) and add thread_count=4, so
# output quality is unchanged while wall clock drops; the bump regenerates
# caches because the bitstream is no longer byte-comparable across versions.
PIPELINE_ID = "video_check"
PIPELINE_VERSION = "1.3.0"


def _encode_cap_from_env(raw: str | None) -> int:
    """Parse ``VIDEO_MAX_FRAMES`` (``0`` = the full episode; the default).

    Anything unparseable or negative falls back to 0 — a review preview that
    silently stops short is worse than a slow one, so the safe reading of a
    broken knob is "encode everything".
    """
    if raw is None:
        return 0
    try:
        value = int(raw)
    except ValueError:
        return 0
    return value if value >= 0 else 0


# DEFAULT encode cap (params.max_frames overrides): ``VIDEO_MAX_FRAMES`` in the
# environment, 0 (= encode the full episode) when unset. Reviewers watch the
# whole take (user decision 2026-08-07); set a cap only on machines where
# encode time/disk for long episodes actually hurts.
MAX_FRAMES = _encode_cap_from_env(os.environ.get("VIDEO_MAX_FRAMES"))


def _encode_threads_from_env(raw: str | None) -> int:
    """Parse ``VIDEO_ENCODE_THREADS`` (0 = x264 auto). Default 4.

    Capped by default rather than auto: one preview must not saturate the box —
    on a single-host deployment the recorder shares these cores, and the job
    executor may already be running two encodes.
    """
    if raw is None:
        return 4
    try:
        value = int(raw)
    except ValueError:
        return 4
    return value if value >= 0 else 4


_X264_PRESETS = frozenset(
    {
        "ultrafast",
        "superfast",
        "veryfast",
        "faster",
        "fast",
        "medium",
        "slow",
        "slower",
        "veryslow",
    }
)


def _encode_preset_from_env(raw: str | None) -> str:
    """Parse ``VIDEO_ENCODE_PRESET``. Default ``medium`` (x264's own default).

    The default deliberately trades no quality: the Review video is also what
    an operator judges camera health from, and codec mush is indistinguishable
    from a degraded camera. Set ``veryfast`` where encode speed matters more.
    """
    if raw is None:
        return "medium"
    value = raw.strip().lower()
    return value if value in _X264_PRESETS else "medium"


def _encode_crf_from_env(raw: str | None) -> int:
    """Parse ``VIDEO_ENCODE_CRF`` (0-51, lower = better). Default 23."""
    if raw is None:
        return 23
    try:
        value = int(raw)
    except ValueError:
        return 23
    return value if 0 <= value <= 51 else 23


# Encoder settings (all env-tunable; the defaults change wall clock only —
# threads — never quality).
ENCODE_THREADS = _encode_threads_from_env(os.environ.get("VIDEO_ENCODE_THREADS"))
ENCODE_PRESET = _encode_preset_from_env(os.environ.get("VIDEO_ENCODE_PRESET"))
ENCODE_CRF = _encode_crf_from_env(os.environ.get("VIDEO_ENCODE_CRF"))

# The fps-estimate cadence sample stays bounded regardless of the encode cap:
# a few hundred inter-frame gaps pin the rate, and an uncapped encode must not
# turn the estimate into an O(episode) scan.
FPS_SAMPLE_FRAMES = 900
# fps is estimated from frame timestamps then clamped to a sane playback range.
_FPS_MIN = 1
_FPS_MAX = 60
_DEFAULT_FPS = 15


def sanitize_topic(topic: str) -> str:
    """Turn a ROS topic name into a safe single-file basename (no extension).

    The topic becomes the mp4 filename, so it must not contain separators or
    traversal: the leading ``/`` is stripped, remaining ``/`` become ``_``, and
    any other non-``[A-Za-z0-9._-]`` run collapses to ``_``. An empty result
    falls back to ``topic`` so we never produce a hidden/dotfile name.
    """
    stripped = topic.strip().lstrip("/")
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", stripped.replace("/", "_")).strip("._")
    return slug or "topic"


def estimate_fps(times_ns: list[int]) -> int:
    """Estimate playback fps from frame times (count / duration).

    *times_ns* is whichever clock the caller picked (``mcap_utils.
    source_times``: publish_time when the bag recorded it, else log_time).
    Clamped to ``[_FPS_MIN, _FPS_MAX]``; falls back to ``_DEFAULT_FPS`` when the
    cadence is indeterminate (fewer than two frames or a zero-length span).
    """
    n = len(times_ns)
    if n < 2:
        return _DEFAULT_FPS
    ordered = sorted(times_ns)
    duration_s = (ordered[-1] - ordered[0]) / 1e9
    if duration_s <= 0:
        return _DEFAULT_FPS
    # N frames span N-1 intervals over the duration.
    fps = round((n - 1) / duration_s)
    return max(_FPS_MIN, min(_FPS_MAX, fps))


def _even(value: int) -> int:
    """Round a dimension down to the nearest even number (h264 yuv420p needs it)."""
    return value - (value % 2)


def _result(summary: dict[str, Any], out_path: Path) -> dict[str, Any]:
    """Wrap a summary in the ``{summary, artifacts}`` JobResult shape."""
    artifacts = [summary["file"], str(out_path)] if summary.get("file") else []
    return {"summary": summary, "artifacts": artifacts}


def _load_cached_summary(
    sidecar: Path,
    out_path: Path,
    mcap_path: Path,
    *,
    capture_id: str,
    topic: str,
    max_frames: int,
) -> dict[str, Any] | None:
    """Return the persisted summary for (capture_id, topic) if it is still valid.

    Valid means: the sidecar parses, was produced by this pipeline version for
    this exact (capture_id, topic), is newer than the MCAP (a capture whose
    bytes were re-fetched invalidates), and — when it references an mp4 — that
    file still exists and is also newer than the MCAP. A different *max_frames*
    is a miss UNLESS the
    cached encode is complete (untruncated) and fits within the requested cap —
    then it is exactly what a fresh capped encode would produce. Anything else
    regenerates.
    """
    try:
        summary = json.loads(sidecar.read_text(encoding="utf-8"))
        mcap_mtime = mcap_path.stat().st_mtime
        if not (
            isinstance(summary, dict)
            and summary.get("pipeline") == PIPELINE_ID
            and summary.get("version") == PIPELINE_VERSION
            and summary.get("capture_id") == capture_id
            and summary.get("topic") == topic
            and sidecar.stat().st_mtime >= mcap_mtime
        ):
            return None
        if summary.get("file") is not None and not (
            out_path.is_file() and out_path.stat().st_mtime >= mcap_mtime
        ):
            return None
        if summary.get("max_frames") != max_frames:
            frames = summary.get("frames") or 0
            complete = not summary.get("truncated")
            if not (complete and (max_frames == 0 or frames <= max_frames)):
                return None
        return summary
    except (OSError, ValueError):
        return None


def run_video_check(
    *,
    capture_id: str,
    data_dir: Path,
    topic: str,
    force: bool = False,
    max_frames: int = MAX_FRAMES,
    cancel: threading.Event | None = None,
) -> dict[str, Any]:
    """Encode a camera *topic*'s frames from the capture's MCAP into mp4.

    The MCAP comes from ``objects/<capture_id>`` and the mp4 is written under
    ``report/video_check/<capture_id>/``.

    Returns the ``{summary, artifacts}`` JobResult shape. Raises
    ``FileNotFoundError`` if the capture dir or its MCAP is missing and
    ``ValueError`` for a capture_id that is not a UUIDv7 (both mapped to a
    failed job by the worker). The encode deps (``av`` + ``Pillow``) are
    lazy-imported here; their absence raises a clear ``RuntimeError`` (-> failed
    job) rather than breaking module import.

    A previously generated result for this (capture_id, topic) is returned from
    the sidecar cache (marked ``cached: true``) without touching the encode
    deps; *force* skips the cache and re-encodes.

    *max_frames* caps the encode (default keeps previews short); ``0`` means
    the FULL episode — that is the "regenerate the whole video" path the UI
    offers on a truncated preview. The new mp4 is written to a temp file and
    atomically renamed over the old one, so a failed re-encode never corrupts
    a preview that was already being served.

    The MCAP is only read, so the canonical recording is never touched.
    """
    if not topic or not topic.strip():
        raise ValueError("topic is required for video_check")
    if max_frames < 0:
        raise ValueError("max_frames must be >= 0 (0 = the full episode)")
    source_dir = resolve_source_dir(data_dir, capture_id)
    mcap_path = find_mcap(source_dir)

    out_dir = data_dir / "report" / "video_check" / capture_id
    out_dir.mkdir(parents=True, exist_ok=True)
    sanitized = sanitize_topic(topic)
    out_path = out_dir / f"{sanitized}.mp4"
    rel_path = out_path.relative_to(data_dir).as_posix()

    # Cache: a finished run's MCAP is immutable, so an earlier encode of this
    # exact (capture_id, topic) is still the right answer — return it instantly
    # instead of re-decoding/re-encoding (seconds per click in the Runs tab).
    # Checked BEFORE the encode deps below: a cache hit needs none of them.
    sidecar = out_dir / f"{sanitized}.summary.json"
    if not force:
        cached = _load_cached_summary(
            sidecar,
            out_path,
            mcap_path,
            capture_id=capture_id,
            topic=topic,
            max_frames=max_frames,
        )
        if cached is not None:
            cached["cached"] = True
            return _result(cached, out_path)

    # Lazy-import the encode deps so this module imports without them (the dora
    # service still boots; a missing dep becomes a clear failed job).
    try:
        import av
        import numpy as np
        from PIL import Image
    except ImportError as exc:  # pragma: no cover - exercised only without deps
        raise RuntimeError(
            "video encoding requires the 'av', 'numpy' and 'Pillow' packages"
        ) from exc

    # Metadata first, without decoding any image: the authoritative total comes
    # from the MCAP statistics (O(1)); the fps cadence comes from the message
    # time fields (no JPEG/CDR decode — the expensive image decode below still
    # stops at the cap, which is what DORA-L1 protects). The clock choice
    # (publish_time vs log_time) is made over the WHOLE topic — the same input
    # loss_report decides on — so the two pipelines can never disagree on a
    # topic's time_source (a late unknown/zero publish_time must flip both, not
    # just loss_report); the fps itself then comes from the chosen clock's first
    # FPS_SAMPLE_FRAMES samples (bounded even when the encode cap is 0 = full).
    total_from_stats = topic_message_count(mcap_path, topic)
    pairs = list(iter_topic_times(mcap_path, topic))
    total_messages = total_from_stats if total_from_stats is not None else len(pairs)
    chosen, fps_time_source = source_times(pairs)
    cadence = chosen[:FPS_SAMPLE_FRAMES]

    truncated = False
    unsupported = False
    frames_encoded = 0
    width = height = 0
    fps = 0
    container: Any = None
    stream: Any = None
    # Encode into a temp file and publish with an atomic rename below, so a
    # force re-encode that dies midway never corrupts an mp4 already served.
    tmp_path = out_path.with_name(out_path.name + ".tmp")

    try:
        try:
            for decoded in iter_decoded_ros2_messages(mcap_path, topics=[topic]):
                # Cancellation checkpoint, per frame: a full-episode encode is
                # minutes of wall time, and this loop is where it is spent.
                if cancel is not None and cancel.is_set():
                    raise JobCanceled
                msg = decoded.ros_msg
                # Happy path: sensor_msgs/CompressedImage (JPEG) -> Pillow decode.
                if not hasattr(msg, "data") or not hasattr(msg, "format"):
                    unsupported = True
                    continue
                if max_frames and frames_encoded >= max_frames:
                    # Cap reached: total_messages is already known, so stop
                    # decoding instead of draining the rest of the topic (DORA-L1).
                    truncated = True
                    break
                try:
                    image = Image.open(io.BytesIO(bytes(msg.data))).convert("RGB")
                except Exception:  # noqa: BLE001 - skip an undecodable frame, don't crash
                    continue
                arr = np.asarray(image)
                if container is None:
                    # First decodable frame: fix output dimensions and open the
                    # stream, then encode-and-discard each frame so at most one
                    # frame is resident (DORA-H1 — previously all capped frames
                    # were accumulated in RAM before a single batch encode,
                    # ~GBs at 1080p).
                    height, width = arr.shape[0], arr.shape[1]
                    width, height = _even(width), _even(height)
                    fps = estimate_fps(cadence)
                    container = av.open(str(tmp_path), mode="w", format="mp4")
                    # preset/crf explicit (they WERE the x264 defaults, now
                    # they are a contract), threads capped — see the env knobs.
                    stream = container.add_stream(
                        "h264",
                        rate=fps,
                        options={"preset": ENCODE_PRESET, "crf": str(ENCODE_CRF)},
                    )
                    stream.codec_context.thread_count = ENCODE_THREADS
                    stream.width = width
                    stream.height = height
                    stream.pix_fmt = "yuv420p"
                # Crop to the even dimensions h264/yuv420p requires.
                cropped = arr[:height, :width]
                video_frame = av.VideoFrame.from_ndarray(cropped, format="rgb24")
                for packet in stream.encode(video_frame):
                    container.mux(packet)
                frames_encoded += 1
            if container is not None:
                for packet in stream.encode():
                    container.mux(packet)
        finally:
            if container is not None:
                container.close()
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise

    if frames_encoded > 0:
        os.replace(tmp_path, out_path)

    summary: dict[str, Any] = {
        "pipeline": PIPELINE_ID,
        "version": PIPELINE_VERSION,
        "capture_id": capture_id,
        # pass/fail in the same vocabulary fast_validation uses, because the
        # job STATE cannot carry this. A run that encodes nothing still ends
        # `succeeded` — correctly, since the job itself did not fail — so
        # without a verdict here the only machine-readable signal a consumer
        # has says the check passed. It did not: there is no video, and the
        # commonest cause is a topic that does not exist in this recording,
        # which is precisely what an operator needs told.
        "result": "pass" if frames_encoded > 0 else "fail",
        "topic": topic,
        "frames": frames_encoded,
        "total_messages": total_messages,
        "truncated": truncated,
        "max_frames": max_frames,
        "checked_at": utc_now_iso8601(),
    }

    if frames_encoded == 0:
        summary["fps"] = None
        summary["fps_time_source"] = None
        summary["width"] = None
        summary["height"] = None
        summary["duration_s"] = None
        summary["file"] = None
        summary["mp4"] = None
        summary["note"] = (
            "no decodable CompressedImage/JPEG frames on this topic"
            if unsupported
            else "no frames found on this topic"
        )
    else:
        summary["fps"] = fps
        # Which clock the fps came from (honesty rule): "publish_time" =
        # sender-side cadence; "log_time" = receive-side fallback (older bags).
        summary["fps_time_source"] = fps_time_source
        summary["width"] = width
        summary["height"] = height
        summary["duration_s"] = frames_encoded / fps if fps else None
        summary["file"] = rel_path
        summary["mp4"] = rel_path

    # Persist the summary beside the mp4 so the next job for this (capture_id,
    # topic) is a cache hit. Written for the no-frames case too — that verdict
    # is just as deterministic for an immutable bag, and re-scanning the whole
    # topic to re-learn "no frames" costs the same seconds as an encode.
    try:
        atomic_write_text(sidecar, json.dumps(summary, indent=2))
    except OSError:
        pass  # caching is best-effort; the result itself is still returned
    return _result(summary, out_path)
