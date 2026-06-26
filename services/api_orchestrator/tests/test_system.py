"""Tests for ``GET /api/v1/system`` (host CPU/GPU info).

The CPU probe reads ``/proc/cpuinfo`` and the GPU probe shells out to
``nvidia-smi``; both are mocked here so the tests are deterministic and run on
any host (CI without a GPU included). The endpoint must always return 200 with
nulls on failure — never raise.
"""

from __future__ import annotations

import subprocess

import pytest
from api_orchestrator.routers import system as system_router
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

    monkeypatch.setattr(system_router, "Path", FakePath)


def test_system_reports_cpu_and_gpu(
    client: TestClient, patch_cpuinfo, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CPU is parsed from /proc/cpuinfo; GPU comes from a successful nvidia-smi."""
    monkeypatch.setattr(
        system_router.subprocess,
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

    monkeypatch.setattr(system_router.subprocess, "run", _raise)

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
        system_router.subprocess,
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

    monkeypatch.setattr(system_router.subprocess, "run", _timeout)

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

    monkeypatch.setattr(system_router, "Path", FailingPath)
    monkeypatch.setattr(
        system_router.subprocess, "run", lambda *a, **k: _completed("", returncode=9)
    )

    resp = client.get("/api/v1/system")
    assert resp.status_code == 200
    body = resp.json()
    assert body["cpu"] == {"model": None, "cores": None}
    assert body["gpu"] is None
