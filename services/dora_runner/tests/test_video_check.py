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
import time
from pathlib import Path

import pytest
from dora_runner.main import create_dora_app
from dora_runner.video_check import (
    MAX_FRAMES,
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
