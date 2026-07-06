"""``video_check`` pipeline: on-demand mp4 preview of a camera topic.

Event-driven (button -> job), post-hoc, and read-only with respect to the
canonical recording: it only READS the finished MCAP under
``recorded/<run_id>`` — or, with the optional ``dataset_dir`` param, under an
exported ``<operator>/<task>/<NNN>`` dataset directory — to decode a single
image topic's frames into an mp4, so it can never disturb an in-flight
recording (it only ever runs on finished runs).
It NEVER auto-converts — a user picks a camera topic and presses the button.

The encode dependencies (``av`` = PyAV, which bundles ffmpeg, and ``Pillow``
for JPEG decode) are **lazy-imported inside** :func:`run_video_check` (mirroring
the ROS nodes' lazy rclpy import) so this module — and the dora service — still
import and boot when those packages are absent. The happy path is a
``sensor_msgs/CompressedImage`` JPEG topic; a raw ``sensor_msgs/Image`` topic is
skipped with a clear note rather than crashing.

The mp4 is written under ``data/report/video_check/<run_id>/<topic>.mp4`` and the
summary carries the path **relative to data_dir** (``file``) so the frontend can
build the guarded ``/api/v1/files/<file>`` URL to play it.

Results are CACHED per (run_id, topic): the summary is persisted as a
``<topic>.summary.json`` sidecar beside the mp4, and a later job for the same
pair returns it instantly (``cached: true``) instead of re-decoding and
re-encoding — a finished run's MCAP is immutable, so the artifact stays valid.
Freshness is still guarded by mtime (a re-recorded run id or a deleted mp4
regenerates) and by the pipeline version; ``params.force`` bypasses the cache.
"""

from __future__ import annotations

import io
import json
import re
from pathlib import Path
from typing import Any

from kairos_common import utc_now_iso8601

from dora_runner.mcap_utils import (
    find_mcap,
    iter_decoded_ros2_messages,
    iter_topic_log_times,
    resolve_source_dir,
    topic_message_count,
    validate_run_id,
)

# Pipeline identity stamped into the summary (reproducibility contract, shared
# with the other bundled pipelines and the hello_dora plugin example).
PIPELINE_ID = "video_check"
PIPELINE_VERSION = "1.0.0"

# Bound encode time/size: at ~15 fps this is ~60 s of preview, plenty to eyeball.
MAX_FRAMES = 900
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


def estimate_fps(log_times_ns: list[int]) -> int:
    """Estimate playback fps from frame log_times (count / duration).

    Clamped to ``[_FPS_MIN, _FPS_MAX]``; falls back to ``_DEFAULT_FPS`` when the
    cadence is indeterminate (fewer than two frames or a zero-length span).
    """
    n = len(log_times_ns)
    if n < 2:
        return _DEFAULT_FPS
    ordered = sorted(log_times_ns)
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
    sidecar: Path, out_path: Path, mcap_path: Path, *, run_id: str, topic: str
) -> dict[str, Any] | None:
    """Return the persisted summary for (run_id, topic) if it is still valid.

    Valid means: the sidecar parses, was produced by this pipeline version for
    this exact (run_id, topic), is newer than the MCAP (a re-recorded run id
    invalidates), and — when it references an mp4 — that file still exists and
    is also newer than the MCAP. Anything else regenerates.
    """
    try:
        summary = json.loads(sidecar.read_text(encoding="utf-8"))
        mcap_mtime = mcap_path.stat().st_mtime
        if not (
            isinstance(summary, dict)
            and summary.get("pipeline") == PIPELINE_ID
            and summary.get("version") == PIPELINE_VERSION
            and summary.get("run_id") == run_id
            and summary.get("topic") == topic
            and sidecar.stat().st_mtime >= mcap_mtime
        ):
            return None
        if summary.get("file") is not None and not (
            out_path.is_file() and out_path.stat().st_mtime >= mcap_mtime
        ):
            return None
        return summary
    except (OSError, ValueError):
        return None


def run_video_check(
    *,
    run_id: str,
    data_dir: Path,
    topic: str,
    force: bool = False,
    dataset_dir: str | None = None,
) -> dict[str, Any]:
    """Encode a camera *topic*'s frames from the run's MCAP into mp4.

    The MCAP comes from ``recorded/<run_id>`` by default, or — when
    *dataset_dir* (``<operator>/<task>/<NNN>``) is given — from the exported
    dataset directory, so a preview stays available after ``dataset_export``
    MOVED the recording out of ``recorded/``. The output/cache stays keyed by
    (run_id, topic) either way, so a preview generated before export is reused
    after it (the move preserves mtimes).

    Returns the ``{summary, artifacts}`` JobResult shape. Raises
    ``FileNotFoundError`` if the source dir or its MCAP is missing and
    ``ValueError`` for an unsafe run_id / dataset_dir (both mapped to a failed
    job by the worker). The encode deps (``av`` + ``Pillow``) are lazy-imported
    here; their absence raises a clear ``RuntimeError`` (-> failed job) rather
    than breaking module import.

    A previously generated result for this (run_id, topic) is returned from the
    sidecar cache (marked ``cached: true``) without touching the encode deps;
    *force* skips the cache and re-encodes.

    The MCAP is only read, so the canonical recording is never touched.
    """
    validate_run_id(run_id)
    if not topic or not topic.strip():
        raise ValueError("topic is required for video_check")
    source_dir = resolve_source_dir(data_dir, run_id, dataset_dir)
    mcap_path = find_mcap(source_dir)

    out_dir = data_dir / "report" / "video_check" / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    sanitized = sanitize_topic(topic)
    out_path = out_dir / f"{sanitized}.mp4"
    rel_path = out_path.relative_to(data_dir).as_posix()

    # Cache: a finished run's MCAP is immutable, so an earlier encode of this
    # exact (run_id, topic) is still the right answer — return it instantly
    # instead of re-decoding/re-encoding (seconds per click in the Runs tab).
    # Checked BEFORE the encode deps below: a cache hit needs none of them.
    sidecar = out_dir / f"{sanitized}.summary.json"
    if not force:
        cached = _load_cached_summary(
            sidecar, out_path, mcap_path, run_id=run_id, topic=topic
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
    # from the MCAP statistics (O(1)); the fps cadence comes from a bounded scan
    # of at most MAX_FRAMES message log_times (no JPEG/CDR decode). This is what
    # lets the decode pass below stop at the cap instead of draining the whole
    # topic just to count it (DORA-L1).
    total_from_stats = topic_message_count(mcap_path, topic)
    cadence: list[int] = []
    scanned = 0
    for log_time in iter_topic_log_times(mcap_path, topic):
        scanned += 1
        if len(cadence) < MAX_FRAMES:
            cadence.append(log_time)
        elif total_from_stats is not None:
            # Enough cadence samples and the total is already known — stop early.
            break
    total_messages = total_from_stats if total_from_stats is not None else scanned

    truncated = False
    unsupported = False
    frames_encoded = 0
    width = height = 0
    fps = 0
    container: Any = None
    stream: Any = None

    try:
        for decoded in iter_decoded_ros2_messages(mcap_path, topics=[topic]):
            msg = decoded.ros_msg
            # Happy path: sensor_msgs/CompressedImage (JPEG) -> Pillow decode.
            if not hasattr(msg, "data") or not hasattr(msg, "format"):
                unsupported = True
                continue
            if frames_encoded >= MAX_FRAMES:
                # Cap reached: total_messages is already known, so stop decoding
                # instead of draining the rest of the topic (DORA-L1).
                truncated = True
                break
            try:
                image = Image.open(io.BytesIO(bytes(msg.data))).convert("RGB")
            except Exception:  # noqa: BLE001 - skip an undecodable frame, don't crash
                continue
            arr = np.asarray(image)
            if container is None:
                # First decodable frame: fix output dimensions and open the
                # stream, then encode-and-discard each frame so at most one frame
                # is resident (DORA-H1 — previously all MAX_FRAMES frames were
                # accumulated in RAM before a single batch encode, ~GBs at 1080p).
                height, width = arr.shape[0], arr.shape[1]
                width, height = _even(width), _even(height)
                fps = estimate_fps(cadence)
                container = av.open(str(out_path), mode="w")
                stream = container.add_stream("h264", rate=fps)
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

    summary: dict[str, Any] = {
        "pipeline": PIPELINE_ID,
        "version": PIPELINE_VERSION,
        "run_id": run_id,
        "topic": topic,
        "frames": frames_encoded,
        "total_messages": total_messages,
        "truncated": truncated,
        "checked_at": utc_now_iso8601(),
    }

    if frames_encoded == 0:
        summary["fps"] = None
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
        summary["width"] = width
        summary["height"] = height
        summary["duration_s"] = frames_encoded / fps if fps else None
        summary["file"] = rel_path
        summary["mp4"] = rel_path

    # Persist the summary beside the mp4 so the next job for this (run_id,
    # topic) is a cache hit. Written for the no-frames case too — that verdict
    # is just as deterministic for an immutable bag, and re-scanning the whole
    # topic to re-learn "no frames" costs the same seconds as an encode.
    try:
        sidecar.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    except OSError:
        pass  # caching is best-effort; the result itself is still returned
    return _result(summary, out_path)
