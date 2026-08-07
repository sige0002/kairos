"""video_check pipeline tests.

The pure helpers (topic -> filename sanitization, fps estimate, frame cap) are
fully unit-testable without the encode deps (``av`` / ``Pillow``); the missing
capture_id / missing topic guards are checked directly. The full encode
path is gated on a real local sample recording with a camera topic (skipped
otherwise, like test_fast_validation), and additionally on ``av`` + ``Pillow``
being importable.

Critically, importing :mod:`dora_runner.video_check` (and ``create_dora_app``)
must succeed even when ``av`` / ``Pillow`` are absent — they are lazy-imported
inside ``run_video_check`` — so these module-level imports are themselves a
regression test for that.
"""

from __future__ import annotations

import importlib.util
import json
import time
from collections.abc import Callable
from pathlib import Path

import pytest
from dora_runner.main import create_dora_app
from dora_runner.mcap_utils import enumerate_topics, find_mcap
from dora_runner.video_check import (
    MAX_FRAMES,
    PIPELINE_VERSION,
    _encode_cap_from_env,
    _encode_crf_from_env,
    _encode_preset_from_env,
    _encode_threads_from_env,
    estimate_fps,
    run_video_check,
    sanitize_topic,
)
from fastapi.testclient import TestClient
from kairos_common import Settings
from kairos_common.ids import new_capture_id

_MS = 1_000_000  # nanoseconds per millisecond

_HAS_ENCODE_DEPS = (
    importlib.util.find_spec("av") is not None
    and importlib.util.find_spec("PIL") is not None
)


# ---- Pure helpers (no encode deps needed) ---------------------------------


def test_sanitize_topic_strips_and_replaces_slashes() -> None:
    assert sanitize_topic("/hsrb/head_rgbd/image_raw/compressed") == (
        "hsrb_head_rgbd_image_raw_compressed"
    )
    # Disallowed characters collapse to a single underscore.
    assert sanitize_topic("/cam a/b!c") == "cam_a_b_c"


def test_sanitize_topic_never_yields_empty_or_dotfile() -> None:
    assert sanitize_topic("/") == "topic"
    assert sanitize_topic("///") == "topic"
    assert sanitize_topic("") == "topic"


def test_estimate_fps_from_timestamps() -> None:
    # 30 frames at a clean 10 Hz (100 ms spacing) -> ~10 fps.
    times = [i * 100 * _MS for i in range(30)]
    assert estimate_fps(times) == 10


def test_estimate_fps_clamps_and_defaults() -> None:
    # Indeterminate cadence -> the default.
    assert estimate_fps([]) == 15
    assert estimate_fps([42]) == 15
    # Zero-length span (all identical) -> the default, not a divide-by-zero.
    assert estimate_fps([7, 7, 7]) == 15
    # Very fast cadence clamps to the 60 fps ceiling.
    fast = [i * _MS for i in range(100)]  # 1 ms spacing = 1000 Hz
    assert estimate_fps(fast) == 60


def test_encoder_knobs_default_to_quality_and_are_env_overridable() -> None:
    # threads: capped at 4 by default (one preview must not saturate the box);
    # 0 = x264 auto; garbage falls back to the cap.
    assert _encode_threads_from_env(None) == 4
    assert _encode_threads_from_env("0") == 0
    assert _encode_threads_from_env("8") == 8
    assert _encode_threads_from_env("nope") == 4
    # preset/crf: the defaults ARE x264's own (medium / 23) — the knobs exist
    # to trade quality for speed explicitly, never silently.
    assert _encode_preset_from_env(None) == "medium"
    assert _encode_preset_from_env("VeryFast") == "veryfast"
    assert _encode_preset_from_env("mush") == "medium"
    assert _encode_crf_from_env(None) == 23
    assert _encode_crf_from_env("28") == 28
    assert _encode_crf_from_env("99") == 23


def test_default_encode_cap_is_full_episode_and_env_overridable() -> None:
    # The default is 0 = encode the full episode (user decision 2026-08-07);
    # VIDEO_MAX_FRAMES caps it, and a broken value falls back to "everything"
    # — a preview that silently stops short is worse than a slow one.
    assert _encode_cap_from_env(None) == 0
    assert _encode_cap_from_env("900") == 900
    assert _encode_cap_from_env("abc") == 0
    assert _encode_cap_from_env("-5") == 0


# ---- Job-level guards (no encode deps needed) -----------------------------


@pytest.mark.parametrize("bad", ["../../etc", "run_20260623_232808", "", "nope"])
def test_video_check_rejects_non_uuid7_capture_id(tmp_path: Path, bad: str) -> None:
    data_dir = tmp_path / "data"
    (data_dir / "objects").mkdir(parents=True)
    with pytest.raises(ValueError, match="capture_id must be a UUIDv7"):
        run_video_check(capture_id=bad, data_dir=data_dir, topic="/cam")


def test_video_check_rejects_empty_topic(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    (data_dir / "objects").mkdir(parents=True)
    with pytest.raises(ValueError, match="topic is required"):
        run_video_check(capture_id=new_capture_id(), data_dir=data_dir, topic="")


def test_video_check_missing_capture_dir_raises(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    (data_dir / "objects").mkdir(parents=True)
    with pytest.raises(FileNotFoundError, match="No capture found"):
        run_video_check(capture_id=new_capture_id(), data_dir=data_dir, topic="/cam")


def test_create_job_rejects_missing_topic(tmp_path: Path) -> None:
    """A video_check job with no topic param fails fast with topic_required."""
    # A writable data dir (the app now opens a SQLite store beneath it); the
    # capture dir stays absent, but the worker rejects on the missing topic
    # before any read.
    app = create_dora_app(Settings(data_dir=str(tmp_path)))
    with TestClient(app) as client:
        created = client.post(
            "/jobs",
            json={
                "capture_id": new_capture_id(),
                "pipeline": "video_check",
                "params": {},
            },
        )
        # The job is accepted (201) but the worker fails it on the missing topic.
        assert created.status_code == 201
        job_id = created.json()["job_id"]
        status: dict = {}
        for _ in range(100):
            status = client.get(f"/jobs/{job_id}/status").json()
            if status["state"] in {"succeeded", "failed"}:
                break
            time.sleep(0.05)
        assert status["state"] == "failed"
        body = client.get(f"/jobs/{job_id}/result").json()
        # ApiError.to_model() nests under "error"; the worker stores that whole
        # model under summary["error"], so the code is one level deeper.
        assert body["summary"]["error"]["error"]["code"] == "topic_required"


# ---- Cache: (capture_id, topic) results are reused without re-encoding -----
# A cache hit is decided before the lazy av/Pillow import, so these run without
# the encode deps and without a real MCAP (the bag is never parsed on a hit).


def _seed_cached_result(
    data_dir: Path,
    capture_id: str,
    topic: str,
    *,
    with_mp4: bool = True,
    frames: int = 42,
    truncated: bool = False,
    max_frames: int = MAX_FRAMES,
) -> dict:
    """Create objects/<capture_id>/x.mcap + a valid sidecar (and mp4) for *topic*."""
    (data_dir / "objects" / capture_id).mkdir(parents=True)
    (data_dir / "objects" / capture_id / "x.mcap").write_bytes(b"not-a-real-mcap")
    out_dir = data_dir / "report" / "video_check" / capture_id
    out_dir.mkdir(parents=True)
    slug = sanitize_topic(topic)
    rel = f"report/video_check/{capture_id}/{slug}.mp4"
    summary = {
        "pipeline": "video_check",
        "version": PIPELINE_VERSION,
        "capture_id": capture_id,
        "topic": topic,
        "frames": frames,
        "total_messages": frames,
        "truncated": truncated,
        "max_frames": max_frames,
        "checked_at": "2026-07-06T00:00:00Z",
        "fps": 15,
        "width": 640,
        "height": 480,
        "duration_s": 2.8,
        "file": rel,
        "mp4": rel,
    }
    if with_mp4:
        (out_dir / f"{slug}.mp4").write_bytes(b"mp4")
    (out_dir / f"{slug}.summary.json").write_text(json.dumps(summary))
    return summary


def test_video_check_reuses_cached_result(tmp_path: Path) -> None:
    """A second job for the same (capture_id, topic) returns the cached summary
    instantly — the fake MCAP would crash any real decode, proving the bag is
    never re-parsed on a hit."""
    capture_id = new_capture_id()
    seeded = _seed_cached_result(tmp_path, capture_id, "/cam/image/compressed")
    result = run_video_check(
        capture_id=capture_id, data_dir=tmp_path, topic="/cam/image/compressed"
    )
    assert result["summary"]["cached"] is True
    assert result["summary"]["frames"] == seeded["frames"]
    assert result["summary"]["file"] == seeded["file"]
    assert seeded["file"] in result["artifacts"]


def test_video_check_cache_invalidated_by_missing_mp4_or_version(
    tmp_path: Path,
) -> None:
    """A deleted mp4 or a different pipeline version must NOT serve the cache.

    The miss then proceeds to the decode path, which fails on the fake MCAP —
    exactly the point: the stale cache was rejected and a real re-encode began.
    """
    slug = sanitize_topic("/cam/image/compressed")
    # Deleted mp4.
    missing_mp4 = new_capture_id()
    _seed_cached_result(tmp_path, missing_mp4, "/cam/image/compressed", with_mp4=False)
    with pytest.raises(Exception):  # noqa: B017 - any decode-path error proves the miss
        run_video_check(
            capture_id=missing_mp4, data_dir=tmp_path, topic="/cam/image/compressed"
        )
    # Version mismatch.
    stale_version = new_capture_id()
    _seed_cached_result(tmp_path, stale_version, "/cam/image/compressed")
    sidecar = (
        tmp_path / "report" / "video_check" / stale_version / f"{slug}.summary.json"
    )
    stale = json.loads(sidecar.read_text())
    stale["version"] = "0.0.1"
    sidecar.write_text(json.dumps(stale))
    with pytest.raises(Exception):  # noqa: B017
        run_video_check(
            capture_id=stale_version, data_dir=tmp_path, topic="/cam/image/compressed"
        )


def test_video_check_force_bypasses_cache(tmp_path: Path) -> None:
    """``force=True`` must skip a perfectly valid cache and re-encode (which
    fails here on the fake MCAP — proving the cache was bypassed)."""
    capture_id = new_capture_id()
    _seed_cached_result(tmp_path, capture_id, "/cam/image/compressed")
    with pytest.raises(Exception):  # noqa: B017
        run_video_check(
            capture_id=capture_id,
            data_dir=tmp_path,
            topic="/cam/image/compressed",
            force=True,
        )


def test_video_check_truncated_cache_misses_on_a_different_cap(
    tmp_path: Path,
) -> None:
    """A head-only (truncated) cache must NOT satisfy a full-episode request —
    that is the whole point of the "re-encode full" path. The miss proceeds to
    the decode path, which fails on the fake MCAP, proving the rejection."""
    capture_id = new_capture_id()
    _seed_cached_result(
        tmp_path,
        capture_id,
        "/cam/image/compressed",
        frames=900,
        truncated=True,
        max_frames=900,
    )
    with pytest.raises(Exception):  # noqa: B017
        run_video_check(
            capture_id=capture_id,
            data_dir=tmp_path,
            topic="/cam/image/compressed",
            max_frames=0,
        )


def test_video_check_complete_cache_satisfies_a_larger_cap(tmp_path: Path) -> None:
    """An UNTRUNCATED cache that fits the requested cap is byte-identical to a
    fresh capped encode, so it is served regardless of the cap it was made
    with (here: a full-episode encode answering the default capped request)."""
    capture_id = new_capture_id()
    seeded = _seed_cached_result(
        tmp_path, capture_id, "/cam/image/compressed", frames=42, max_frames=0
    )
    result = run_video_check(
        capture_id=capture_id, data_dir=tmp_path, topic="/cam/image/compressed"
    )
    assert result["summary"]["cached"] is True
    assert result["summary"]["file"] == seeded["file"]


def test_video_check_complete_cache_misses_when_over_the_cap(tmp_path: Path) -> None:
    """An untruncated cache LONGER than the requested cap is not the capped
    artifact — it must regenerate (decode fails on the fake MCAP = miss)."""
    capture_id = new_capture_id()
    _seed_cached_result(
        tmp_path, capture_id, "/cam/image/compressed", frames=42, max_frames=0
    )
    with pytest.raises(Exception):  # noqa: B017
        run_video_check(
            capture_id=capture_id,
            data_dir=tmp_path,
            topic="/cam/image/compressed",
            max_frames=10,
        )


def test_video_check_rejects_negative_max_frames(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    capture_id, _ = make_capture(tmp_path)
    with pytest.raises(ValueError):
        run_video_check(
            capture_id=capture_id,
            data_dir=tmp_path,
            topic="/cam/image/compressed",
            max_frames=-1,
        )


# ---- Integration (real sample bag + encode deps, skipped when absent) ------

DATA_DIR = Path(__file__).resolve().parents[3] / "data"
# A camera topic in the HSR sample bag (CompressedImage / JPEG).
CAMERA_TOPIC = "/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed"


def _sample_with_camera_topic(
    sample_capture: tuple[str, Path] | None,
) -> tuple[str, Path]:
    """The sample recording, or a skip that says why it cannot be used.

    ``CAMERA_TOPIC`` is a fixed HSR topic while the sample under
    ``data/objects/`` is whatever the developer last recorded — often another
    robot, whose camera topics are named differently. Encoding zero frames from
    a bag that never had that topic tests nothing, so it is skipped.

    The skip NAMES both sides. A bare "skipped" here would be indistinguishable
    from the deps being absent, and two permanently-red tests train everyone to
    read the tail of this suite as normal — which is how a real regression in
    it gets waved through.
    """
    if sample_capture is None:
        pytest.skip("needs a local sample recording under data/objects/")
    capture_id, directory = sample_capture
    present = {t["name"] for t in enumerate_topics(find_mcap(directory))}
    if CAMERA_TOPIC not in present:
        cameras = sorted(t for t in present if "image" in t or "camera" in t)
        pytest.skip(
            f"the sample recording {capture_id} has no {CAMERA_TOPIC}; "
            f"its camera topics are {cameras or 'none'}. This test is fixed to "
            "an HSR topic, so another robot's recording cannot exercise it."
        )
    return capture_id, directory


@pytest.mark.skipif(
    not _HAS_ENCODE_DEPS,
    reason="needs the 'av' and 'Pillow' packages installed",
)
def test_video_check_job_encodes_mp4(sample_capture: tuple[str, Path] | None) -> None:
    capture_id, _ = _sample_with_camera_topic(sample_capture)
    app = create_dora_app(Settings(data_dir=str(DATA_DIR)))
    with TestClient(app) as client:
        created = client.post(
            "/jobs",
            json={
                "capture_id": capture_id,
                "pipeline": "video_check",
                "params": {"topic": CAMERA_TOPIC},
            },
        )
        assert created.status_code == 201
        job_id = created.json()["job_id"]

        status: dict = {}
        for _ in range(600):
            status = client.get(f"/jobs/{job_id}/status").json()
            if status["state"] in {"succeeded", "failed"}:
                break
            time.sleep(0.1)
        assert status["state"] == "succeeded"

        summary = client.get(f"/jobs/{job_id}/result").json()["summary"]
        rel = summary["file"]
        assert rel and (DATA_DIR / rel).exists()
        assert summary["frames"] > 0
        # The fps clock is always declared (publish_time on a Jazzy-recorded
        # bag; log_time fallback on an older one).
        assert summary["fps_time_source"] in ("publish_time", "log_time")


@pytest.mark.skipif(
    not _HAS_ENCODE_DEPS,
    reason="needs the 'av' and 'Pillow' packages installed",
)
def test_video_check_max_frames_caps_the_encode(
    sample_capture: tuple[str, Path] | None,
) -> None:
    """A tiny explicit cap stops the encode early and marks the truncation."""
    capture_id, _ = _sample_with_camera_topic(sample_capture)
    result = run_video_check(
        capture_id=capture_id,
        data_dir=DATA_DIR,
        topic=CAMERA_TOPIC,
        force=True,
        max_frames=3,
    )
    summary = result["summary"]
    assert summary["frames"] == 3
    assert summary["truncated"] is True
    assert summary["max_frames"] == 3
    assert (DATA_DIR / summary["file"]).exists()


# ---- the encode cap on a synthetic bag ------------------------------------
# Hermetic (no sample recording): a tiny CompressedImage MCAP one frame past an
# explicit cap proves max_frames=0 encodes everything while a cap stops (and
# truncates) exactly at the cap.

_IMAGE_DEF = (
    "std_msgs/Header header\nstring format\nuint8[] data\n"
    "================================================================================\n"
    "MSG: std_msgs/Header\nbuiltin_interfaces/Time stamp\nstring frame_id\n"
    "================================================================================\n"
    "MSG: builtin_interfaces/Time\nint32 sec\nuint32 nanosec\n"
)


def _write_compressed_image_mcap(path: Path, count: int) -> None:
    """Write *count* tiny (16x16) JPEG CompressedImage frames at ~15 fps."""
    from io import BytesIO

    from mcap_ros2.writer import Writer
    from PIL import Image

    with path.open("wb") as fh:
        writer = Writer(fh)
        schema = writer.register_msgdef("sensor_msgs/msg/CompressedImage", _IMAGE_DEF)
        for i in range(count):
            buf = BytesIO()
            Image.new("RGB", (16, 16), (i % 256, 0, 0)).save(buf, format="JPEG")
            ts = i * 66 * _MS  # ~15 fps cadence
            writer.write_message(
                topic="/cam/image/compressed",
                schema=schema,
                message={
                    "header": {"stamp": {"sec": i, "nanosec": 0}, "frame_id": "c"},
                    "format": "jpeg",
                    "data": list(buf.getvalue()),
                },
                log_time=ts,
                publish_time=ts,
            )
        writer.finish()


@pytest.mark.skipif(
    not _HAS_ENCODE_DEPS,
    reason="needs the 'av' and 'Pillow' packages installed",
)
def test_video_check_zero_streams_everything_and_a_cap_truncates(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """max_frames=0 (the default) encodes the full bag; an explicit cap stops
    there and says ``truncated``. The cap mechanism is tested with a literal so
    the test does not depend on the deployment's VIDEO_MAX_FRAMES.
    """
    topic = "/cam/image/compressed"
    cap = 12
    capture_id, capture_dir = make_capture(tmp_path)
    _write_compressed_image_mcap(capture_dir / "run_full_0.mcap", cap + 1)

    full = run_video_check(
        capture_id=capture_id, data_dir=tmp_path, topic=topic, max_frames=0
    )
    assert full["summary"]["frames"] == cap + 1
    assert full["summary"]["truncated"] is False
    assert full["summary"]["max_frames"] == 0

    capped = run_video_check(
        capture_id=capture_id,
        data_dir=tmp_path,
        topic=topic,
        force=True,
        max_frames=cap,
    )
    assert capped["summary"]["frames"] == cap
    assert capped["summary"]["truncated"] is True


def test_a_check_that_encodes_nothing_does_not_report_pass(
    tmp_path: Path, make_capture: Callable[[Path], tuple[str, Path]]
) -> None:
    """A video_check with no frames must not read as a check that passed.

    The job state cannot carry this: the run itself did not fail, so it ends
    `succeeded` either way. Without a verdict in the summary the only
    machine-readable signal a consumer has is that state, and it says the
    opposite of the truth — there is no video, no artifact, and the usual cause
    is a topic that is not in this recording at all.
    """
    capture_id, capture_dir = make_capture(tmp_path)
    _write_compressed_image_mcap(capture_dir / "run_0.mcap", 3)

    result = run_video_check(
        capture_id=capture_id, data_dir=tmp_path, topic="/not/in/this/bag"
    )

    summary = result["summary"]
    assert summary["frames"] == 0
    assert summary["result"] == "fail"
    assert result["artifacts"] == []
    assert summary["note"]
