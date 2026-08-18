# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Tests for ``GET /api/v1/system`` (host CPU/GPU info).

The CPU probe reads ``/proc/cpuinfo`` and the GPU probe shells out to
``nvidia-smi``; both are mocked here so the tests are deterministic and run on
any host (CI without a GPU included). The endpoint must always return 200 with
nulls on failure — never raise.
"""

from __future__ import annotations

import collections
import subprocess

import pytest
from api_orchestrator import system_probe
from fastapi.testclient import TestClient

# A realistic two-logical-core /proc/cpuinfo snippet (model name repeats per core).
FAKE_CPUINFO = """\
processor\t: 0
vendor_id\t: GenuineIntel
model name\t: Intel(R) Xeon(R) Gold 6248 CPU @ 2.50GHz
cpu cores\t: 1

processor\t: 1
vendor_id\t: GenuineIntel
model name\t: Intel(R) Xeon(R) Gold 6248 CPU @ 2.50GHz
cpu cores\t: 1
"""


def _completed(stdout: str, returncode: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=["nvidia-smi"], returncode=returncode, stdout=stdout, stderr=""
    )


@pytest.fixture
def patch_cpuinfo(monkeypatch: pytest.MonkeyPatch):
    """Patch the CPU probe to read a fixed /proc/cpuinfo snippet."""

    class FakePath:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def read_text(self, *_args, **_kwargs) -> str:
            return FAKE_CPUINFO

    monkeypatch.setattr(system_probe, "Path", FakePath)


def test_system_reports_cpu_and_gpu(
    client: TestClient, patch_cpuinfo, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CPU is parsed from /proc/cpuinfo; GPU comes from a successful nvidia-smi."""
    monkeypatch.setattr(
        system_probe.subprocess,
        "run",
        lambda *a, **k: _completed("NVIDIA GeForce RTX 4090\n"),
    )

    resp = client.get("/api/v1/system")
    assert resp.status_code == 200
    body = resp.json()
    assert body["cpu"]["model"] == "Intel(R) Xeon(R) Gold 6248 CPU @ 2.50GHz"
    assert body["cpu"]["cores"] == 2
    assert body["gpu"] == "NVIDIA GeForce RTX 4090"


def test_system_gpu_null_when_nvidia_smi_missing(
    client: TestClient, patch_cpuinfo, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A missing nvidia-smi binary degrades GPU to null but still returns CPU."""

    def _raise(*_a, **_k):
        raise FileNotFoundError("nvidia-smi")

    monkeypatch.setattr(system_probe.subprocess, "run", _raise)

    resp = client.get("/api/v1/system")
    assert resp.status_code == 200
    body = resp.json()
    assert body["cpu"]["cores"] == 2
    assert body["gpu"] is None


def test_system_gpu_null_on_nonzero_exit(
    client: TestClient, patch_cpuinfo, monkeypatch: pytest.MonkeyPatch
) -> None:
    """nvidia-smi returning non-zero (e.g. no driver) yields a null GPU."""
    monkeypatch.setattr(
        system_probe.subprocess,
        "run",
        lambda *a, **k: _completed("", returncode=9),
    )

    resp = client.get("/api/v1/system")
    assert resp.status_code == 200
    assert resp.json()["gpu"] is None


def test_system_gpu_null_on_timeout(
    client: TestClient, patch_cpuinfo, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A hung nvidia-smi (timeout) degrades to null rather than erroring."""

    def _timeout(*_a, **_k):
        raise subprocess.TimeoutExpired(cmd="nvidia-smi", timeout=1.5)

    monkeypatch.setattr(system_probe.subprocess, "run", _timeout)

    resp = client.get("/api/v1/system")
    assert resp.status_code == 200
    assert resp.json()["gpu"] is None


def test_system_cpu_null_when_proc_unreadable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unreadable /proc/cpuinfo yields null CPU fields, never a 500."""

    class FailingPath:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def read_text(self, *_args, **_kwargs) -> str:
            raise OSError("nope")

    monkeypatch.setattr(system_probe, "Path", FailingPath)
    monkeypatch.setattr(
        system_probe.subprocess, "run", lambda *a, **k: _completed("", returncode=9)
    )

    resp = client.get("/api/v1/system")
    assert resp.status_code == 200
    body = resp.json()
    assert body["cpu"] == {"model": None, "cores": None}
    assert body["gpu"] is None


# A realistic aggregate /proc/stat first line (user nice system idle iowait ...).
FAKE_PROC_STAT = "cpu  100 0 50 800 40 0 10 0 0 0\ncpu0 100 0 50 800 40 0 10 0 0 0\n"


# ---- disk ----------------------------------------------------------------


def test_read_disk_reports_usage(tmp_path) -> None:
    """A real directory yields DiskInfo with sane, ordered byte counts."""
    disk = system_probe._read_disk(str(tmp_path))
    assert disk is not None
    assert disk.path == str(tmp_path)
    assert disk.total_bytes > 0
    assert 0 <= disk.free_bytes <= disk.total_bytes


def test_read_disk_falls_back_to_data(monkeypatch: pytest.MonkeyPatch) -> None:
    """When the app-known data_dir is missing, /data is the fallback path."""
    Usage = collections.namedtuple("Usage", "total used free")

    def _usage(path: str):
        if path == "/data":
            return Usage(total=100, used=40, free=60)
        raise FileNotFoundError(path)

    monkeypatch.setattr(system_probe.shutil, "disk_usage", _usage)
    disk = system_probe._read_disk("/nonexistent/data")
    assert disk is not None
    assert disk.path == "/data"
    assert disk.total_bytes == 100
    assert disk.free_bytes == 60


def test_read_disk_none_when_no_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """No usable candidate path (all probes fail) degrades to null, not a raise."""

    def _raise(path: str):
        raise FileNotFoundError(path)

    monkeypatch.setattr(system_probe.shutil, "disk_usage", _raise)
    assert system_probe._read_disk("/nonexistent/data") is None


# ---- cpu utilization -----------------------------------------------------


def test_read_cpu_times_parses(monkeypatch: pytest.MonkeyPatch) -> None:
    """The aggregate 'cpu' line parses into (busy, total) jiffies."""
    monkeypatch.setattr(system_probe, "_read_proc_stat", lambda: FAKE_PROC_STAT)
    times = system_probe._read_cpu_times()
    # total = 100+0+50+800+40+0+10 = 1000; idle = 800+40 = 840; busy = 160.
    assert times == (160, 1000)


def test_read_cpu_times_none_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """Missing or malformed /proc/stat yields None (never raises)."""
    monkeypatch.setattr(system_probe, "_read_proc_stat", lambda: None)
    assert system_probe._read_cpu_times() is None
    monkeypatch.setattr(system_probe, "_read_proc_stat", lambda: "cpu bad data x\n")
    assert system_probe._read_cpu_times() is None


def test_cpu_percent_bounds() -> None:
    """Delta busy% is a known value, clamped to [0, 100], null on no baseline."""
    # busy_delta = 20, total_delta = 100 -> 20.0%.
    assert system_probe._cpu_percent((10, 100), (30, 200)) == 20.0
    # No baseline (first sample) -> null.
    assert system_probe._cpu_percent(None, (30, 200)) is None
    # No progress (total unchanged) -> null, not a divide-by-zero.
    assert system_probe._cpu_percent((10, 100), (10, 100)) is None
    # Pathological busy>total still clamps into range.
    assert system_probe._cpu_percent((0, 0), (200, 100)) == 100.0


# ---- endpoint payload shape ----------------------------------------------


def test_system_payload_has_utilization_shape(
    client: TestClient, patch_cpuinfo, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The extended payload always carries the new keys; the first CPU sample and
    a GPU-less host report null utilization rather than fabricating a number."""

    def _no_nvidia(*_a, **_k):
        raise FileNotFoundError("nvidia-smi")

    monkeypatch.setattr(system_probe.subprocess, "run", _no_nvidia)

    body = client.get("/api/v1/system").json()
    assert set(body) >= {"cpu", "gpu", "cpu_percent", "disk", "gpu_percent"}
    # First request has no prior /proc/stat snapshot -> honest null, not 0.
    assert body["cpu_percent"] is None
    # No nvidia-smi -> no GPU utilization.
    assert body["gpu_percent"] is None
    # disk is either null or a well-formed object (host-dependent).
    if body["disk"] is not None:
        assert set(body["disk"]) == {"path", "total_bytes", "free_bytes"}


def test_system_cpu_percent_within_bounds(
    client: TestClient, patch_cpuinfo, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A second sample (with a baseline) reports a real busy% in [0, 100]."""
    snaps = iter([(10, 100), (30, 200)])
    monkeypatch.setattr(system_probe, "_read_cpu_times", lambda: next(snaps))
    monkeypatch.setattr(
        system_probe.subprocess, "run", lambda *a, **k: _completed("", returncode=9)
    )

    # First request seeds the baseline (cpu_percent is null).
    assert client.get("/api/v1/system").json()["cpu_percent"] is None
    # Expire the ~2s cache so the next request recomputes against the baseline.
    client.app.state.util_sample = None  # type: ignore[attr-defined]

    body = client.get("/api/v1/system").json()
    # busy_delta = 20, total_delta = 100 -> 20.0%.
    assert body["cpu_percent"] == 20.0
    cores = body["cpu"]["cores"] or 1
    assert 0.0 <= body["cpu_percent"] <= 100.0 * cores


def test_system_reports_gpu_percent(
    client: TestClient, patch_cpuinfo, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When a GPU is present, its utilization is queried and reported."""

    def _run(cmd, *_a, **_k):
        if "utilization.gpu" in " ".join(cmd):
            return _completed("42\n")
        return _completed("NVIDIA GeForce RTX 4090\n")

    monkeypatch.setattr(system_probe.subprocess, "run", _run)

    body = client.get("/api/v1/system").json()
    assert body["gpu"] == "NVIDIA GeForce RTX 4090"
    assert body["gpu_percent"] == 42.0
