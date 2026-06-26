"""``video_check`` pipeline: on-demand mp4 preview of a camera topic.

Event-driven (button -> job), post-hoc, and read-only with respect to the
canonical recording: it only READS the finished MCAP under
``recorded/<run_id>`` to decode a single image topic's frames into an mp4, so it
can never disturb an in-flight recording (it only ever runs on finished runs).
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
"""

from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Any

from kairos_common import utc_now_iso8601

from dora_runner.mcap_utils import (
    find_mcap,
    iter_decoded_ros2_messages,
    validate_run_id,
)

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


def run_video_check(*, run_id: str, data_dir: Path, topic: str) -> dict[str, Any]:
    """Encode a camera *topic*'s frames from ``recorded/<run_id>`` into mp4.

    Returns the ``{summary, artifacts}`` JobResult shape. Raises
    ``FileNotFoundError`` if the run dir or its MCAP is missing and ``ValueError``
    for an unsafe run_id (both mapped to a failed job by the worker). The encode
    deps (``av`` + ``Pillow``) are lazy-imported here; their absence raises a
    clear ``RuntimeError`` (-> failed job) rather than breaking module import.

    The MCAP is only read, so the canonical recording is never touched.
    """
    validate_run_id(run_id)
    if not topic or not topic.strip():
        raise ValueError("topic is required for video_check")
    run_dir = data_dir / "recorded" / run_id
    if not run_dir.is_dir():
        raise FileNotFoundError(f"No recorded run found: {run_dir}")
    mcap_path = find_mcap(run_dir)

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

    out_dir = data_dir / "report" / "video_check" / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    sanitized = sanitize_topic(topic)
    out_path = out_dir / f"{sanitized}.mp4"
    rel_path = out_path.relative_to(data_dir).as_posix()

    log_times: list[int] = []
    frames: list[Any] = []
    total_messages = 0
    truncated = False
    unsupported = False
    width = height = 0

    for decoded in iter_decoded_ros2_messages(mcap_path, topics=[topic]):
        total_messages += 1
        msg = decoded.ros_msg
        # Happy path: sensor_msgs/CompressedImage (JPEG) -> Pillow decode.
        if not hasattr(msg, "data") or not hasattr(msg, "format"):
            unsupported = True
            continue
        if len(frames) >= MAX_FRAMES:
            truncated = True
            continue
        try:
            image = Image.open(io.BytesIO(bytes(msg.data))).convert("RGB")
        except Exception:  # noqa: BLE001 - skip an undecodable frame, don't crash
            continue
        frames.append(np.asarray(image))
        log_times.append(decoded.log_time_ns)

    summary: dict[str, Any] = {
        "run_id": run_id,
        "topic": topic,
        "frames": len(frames),
        "total_messages": total_messages,
        "truncated": truncated,
        "checked_at": utc_now_iso8601(),
    }

    if not frames:
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
        return {"summary": summary, "artifacts": []}

    fps = estimate_fps(log_times)
    height, width = frames[0].shape[0], frames[0].shape[1]
    width, height = _even(width), _even(height)

    container = av.open(str(out_path), mode="w")
    try:
        stream = container.add_stream("h264", rate=fps)
        stream.width = width
        stream.height = height
        stream.pix_fmt = "yuv420p"
        for arr in frames:
            # Crop to the even dimensions h264/yuv420p requires.
            cropped = arr[:height, :width]
            video_frame = av.VideoFrame.from_ndarray(cropped, format="rgb24")
            for packet in stream.encode(video_frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    finally:
        container.close()

    summary["fps"] = fps
    summary["width"] = width
    summary["height"] = height
    summary["duration_s"] = len(frames) / fps if fps else None
    summary["file"] = rel_path
    summary["mp4"] = rel_path
    return {"summary": summary, "artifacts": [rel_path, str(out_path)]}
