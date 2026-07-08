"""video_check pipeline tests.

The pure helpers (topic -> filename sanitization, fps estimate, frame cap) are
fully unit-testable without the encode deps (``av`` / ``Pillow``); the missing
run_id / missing topic / traversal guards are checked directly. The full encode
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
from pathlib import Path

import pytest
from dora_runner.main import create_dora_app
from dora_runner.video_check import (
    MAX_FRAMES,
    PIPELINE_VERSION,
    estimate_fps,
    run_video_check,
    sanitize_topic,
)
from fastapi.testclient import TestClient
from kairos_common import Settings

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


def test_frame_cap_constant_is_bounded() -> None:
    # The cap exists to bound encode time/size; just assert it's a sane bound.
    assert 0 < MAX_FRAMES <= 5000


# ---- Job-level guards (no encode deps needed) -----------------------------


def test_video_check_rejects_traversal_run_id(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    (data_dir / "recorded").mkdir(parents=True)
    with pytest.raises(ValueError, match="invalid run_id"):
        run_video_check(run_id="../../etc", data_dir=data_dir, topic="/cam")


def test_video_check_rejects_empty_topic(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    (data_dir / "recorded").mkdir(parents=True)
    with pytest.raises(ValueError, match="topic is required"):
        run_video_check(run_id="run_ok", data_dir=data_dir, topic="")


def test_video_check_missing_run_dir_raises(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    (data_dir / "recorded").mkdir(parents=True)
    with pytest.raises(FileNotFoundError):
        run_video_check(run_id="run_absent", data_dir=data_dir, topic="/cam")


def test_create_job_rejects_missing_topic() -> None:
    """A video_check job with no topic param fails fast with topic_required."""
    app = create_dora_app(Settings(data_dir="/nonexistent-data"))
    with TestClient(app) as client:
        created = client.post(
            "/jobs",
            json={"run_id": "run_x", "pipeline": "video_check", "params": {}},
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


# ---- Post-export source (dataset_dir) --------------------------------------


def test_video_check_rejects_unsafe_dataset_dir(tmp_path: Path) -> None:
    """dataset_dir must be exactly <operator>/<task>/<index>, non-reserved."""
    for bad in ("../x/y", "a/b", "a/b/c/d", "a//b", "recorded/a/b", "report/a/b"):
        with pytest.raises(ValueError, match="invalid dataset_dir"):
            run_video_check(
                run_id="run_x", data_dir=tmp_path, topic="/cam", dataset_dir=bad
            )


def test_video_check_missing_dataset_dir_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="No dataset directory"):
        run_video_check(
            run_id="run_x", data_dir=tmp_path, topic="/cam", dataset_dir="a/b/001"
        )


def test_video_check_dataset_dir_serves_cache_without_recorded_run(
    tmp_path: Path,
) -> None:
    """Post-export: recorded/<run_id> is gone (the export MOVED it into the
    dataset tree), yet the pre-export (run_id, topic) cache is still served
    when the job points at the dataset dir."""
    topic = "/cam/image/compressed"
    seeded = _seed_cached_result(tmp_path, "run_d", topic)
    # Simulate the export MOVE: relocate the run dir into the dataset tree.
    dataset = tmp_path / "yuki" / "pick" / "001"
    dataset.parent.mkdir(parents=True)
    (tmp_path / "recorded" / "run_d").rename(dataset)
    result = run_video_check(
        run_id="run_d", data_dir=tmp_path, topic=topic, dataset_dir="yuki/pick/001"
    )
    assert result["summary"]["cached"] is True
    assert result["summary"]["file"] == seeded["file"]


# ---- Cache: (run_id, topic) results are reused without re-encoding ---------
# A cache hit is decided before the lazy av/Pillow import, so these run without
# the encode deps and without a real MCAP (the bag is never parsed on a hit).


def _seed_cached_result(
    data_dir: Path,
    run_id: str,
    topic: str,
    *,
    with_mp4: bool = True,
    frames: int = 42,
    truncated: bool = False,
    max_frames: int = MAX_FRAMES,
) -> dict:
    """Create recorded/<run_id>/x.mcap + a valid sidecar (and mp4) for *topic*."""
    (data_dir / "recorded" / run_id).mkdir(parents=True)
    (data_dir / "recorded" / run_id / "x.mcap").write_bytes(b"not-a-real-mcap")
    out_dir = data_dir / "report" / "video_check" / run_id
    out_dir.mkdir(parents=True)
    slug = sanitize_topic(topic)
    rel = f"report/video_check/{run_id}/{slug}.mp4"
    summary = {
        "pipeline": "video_check",
        "version": PIPELINE_VERSION,
        "run_id": run_id,
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
    """A second job for the same (run_id, topic) returns the cached summary
    instantly — the fake MCAP would crash any real decode, proving the bag is
    never re-parsed on a hit."""
    seeded = _seed_cached_result(tmp_path, "run_c", "/cam/image/compressed")
    result = run_video_check(
        run_id="run_c", data_dir=tmp_path, topic="/cam/image/compressed"
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
    _seed_cached_result(tmp_path, "run_m", "/cam/image/compressed", with_mp4=False)
    with pytest.raises(Exception):  # noqa: B017 - any decode-path error proves the miss
        run_video_check(
            run_id="run_m", data_dir=tmp_path, topic="/cam/image/compressed"
        )
    # Version mismatch.
    _seed_cached_result(tmp_path, "run_v", "/cam/image/compressed")
    sidecar = tmp_path / "report" / "video_check" / "run_v" / f"{slug}.summary.json"
    stale = json.loads(sidecar.read_text())
    stale["version"] = "0.0.1"
    sidecar.write_text(json.dumps(stale))
    with pytest.raises(Exception):  # noqa: B017
        run_video_check(
            run_id="run_v", data_dir=tmp_path, topic="/cam/image/compressed"
        )


def test_video_check_force_bypasses_cache(tmp_path: Path) -> None:
    """``force=True`` must skip a perfectly valid cache and re-encode (which
    fails here on the fake MCAP — proving the cache was bypassed)."""
    _seed_cached_result(tmp_path, "run_f", "/cam/image/compressed")
    with pytest.raises(Exception):  # noqa: B017
        run_video_check(
            run_id="run_f", data_dir=tmp_path, topic="/cam/image/compressed", force=True
        )


def test_video_check_truncated_cache_misses_on_a_different_cap(
    tmp_path: Path,
) -> None:
    """A head-only (truncated) cache must NOT satisfy a full-episode request —
    that is the whole point of the "re-encode full" path. The miss proceeds to
    the decode path, which fails on the fake MCAP, proving the rejection."""
    _seed_cached_result(
        tmp_path,
        "run_h",
        "/cam/image/compressed",
        frames=MAX_FRAMES,
        truncated=True,
        max_frames=MAX_FRAMES,
    )
    with pytest.raises(Exception):  # noqa: B017
        run_video_check(
            run_id="run_h",
            data_dir=tmp_path,
            topic="/cam/image/compressed",
            max_frames=0,
        )


def test_video_check_complete_cache_satisfies_a_larger_cap(tmp_path: Path) -> None:
    """An UNTRUNCATED cache that fits the requested cap is byte-identical to a
    fresh capped encode, so it is served regardless of the cap it was made
    with (here: a full-episode encode answering the default capped request)."""
    seeded = _seed_cached_result(
        tmp_path, "run_full", "/cam/image/compressed", frames=42, max_frames=0
    )
    result = run_video_check(
        run_id="run_full", data_dir=tmp_path, topic="/cam/image/compressed"
    )
    assert result["summary"]["cached"] is True
    assert result["summary"]["file"] == seeded["file"]


def test_video_check_complete_cache_misses_when_over_the_cap(tmp_path: Path) -> None:
    """An untruncated cache LONGER than the requested cap is not the capped
    artifact — it must regenerate (decode fails on the fake MCAP = miss)."""
    _seed_cached_result(
        tmp_path, "run_big", "/cam/image/compressed", frames=42, max_frames=0
    )
    with pytest.raises(Exception):  # noqa: B017
        run_video_check(
            run_id="run_big",
            data_dir=tmp_path,
            topic="/cam/image/compressed",
            max_frames=10,
        )


def test_video_check_rejects_negative_max_frames(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        run_video_check(
            run_id="run_x",
            data_dir=tmp_path,
            topic="/cam/image/compressed",
            max_frames=-1,
        )


# ---- Integration (real sample bag + encode deps, skipped when absent) ------

DATA_DIR = Path(__file__).resolve().parents[3] / "data"
RUN_ID = "run_20260623_232808"
# A camera topic in the HSR sample bag (CompressedImage / JPEG).
CAMERA_TOPIC = "/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed"


@pytest.mark.skipif(
    not _HAS_ENCODE_DEPS,
    reason="needs the 'av' and 'Pillow' packages installed",
)
@pytest.mark.skipif(
    not (DATA_DIR / "recorded" / RUN_ID).is_dir(),
    reason=f"needs a local sample recording at data/recorded/{RUN_ID}",
)
def test_video_check_job_encodes_mp4() -> None:
    app = create_dora_app(Settings(data_dir=str(DATA_DIR)))
    with TestClient(app) as client:
        created = client.post(
            "/jobs",
            json={
                "run_id": RUN_ID,
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


@pytest.mark.skipif(
    not _HAS_ENCODE_DEPS,
    reason="needs the 'av' and 'Pillow' packages installed",
)
@pytest.mark.skipif(
    not (DATA_DIR / "recorded" / RUN_ID).is_dir(),
    reason=f"needs a local sample recording at data/recorded/{RUN_ID}",
)
def test_video_check_max_frames_caps_the_encode() -> None:
    """A tiny explicit cap stops the encode early and marks the truncation."""
    result = run_video_check(
        run_id=RUN_ID,
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
