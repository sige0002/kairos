"""Host system info (``GET /api/v1/system``): CPU + GPU + utilization + disk.

Read-only, non-intrusive operator context for the UI header and the Monitor /
Collect system cards. Static facts (CPU model + logical core count from
``/proc/cpuinfo``, the GPU name from ``nvidia-smi``) are joined with cheap,
briefly-cached utilization samples (CPU busy %, runtime data-dir disk
free/total, GPU utilization %).

This endpoint never raises: any probe failure (no ``/proc``, no ``nvidia-smi``,
timeout, parse error, a missing data dir) degrades the relevant field to
``null`` so the UI can honestly show "—" for what it cannot measure. It is
purely informational and does not touch the ROS 2 graph, so it can never disturb
a recording.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

logger = logging.getLogger("kairos")

router = APIRouter(prefix="/api/v1/system", tags=["system"])

# Short cap so a hung/slow nvidia-smi never blocks the request.
_NVIDIA_SMI_TIMEOUT_S = 1.5

# Sentinel marking "GPU not probed yet" on app.state, so a probe that legitimately
# returns None (no GPU) is still cached and not re-run on every request.
_GPU_UNPROBED = object()

# Utilization (CPU%/disk/GPU%) changes over time — unlike the static CPU/GPU
# names — so it is sampled on demand and cached for this long. SSE-frequency
# polling (~5s from the UI) then costs at most one refresh every couple seconds.
_SAMPLE_TTL_S = 2.0


class CpuInfo(BaseModel):
    """Host CPU summary parsed from ``/proc/cpuinfo`` (best-effort)."""

    model: str | None = None
    cores: int | None = None


class DiskInfo(BaseModel):
    """Free/total bytes of the filesystem holding the runtime data dir."""

    path: str
    total_bytes: int
    free_bytes: int


class SystemInfo(BaseModel):
    """Host system summary for the UI (CPU/GPU names + utilization + disk).

    ``cpu`` and ``gpu`` are static facts; ``cpu_percent`` / ``disk`` /
    ``gpu_percent`` are live, best-effort samples that are ``null`` whenever they
    cannot be measured (older/degraded hosts, no GPU, missing data dir).
    """

    cpu: CpuInfo
    gpu: str | None = None
    # Whole-host CPU busy percentage in [0, 100]; null until a delta window
    # exists (the first sample) or /proc/stat is unreadable.
    cpu_percent: float | None = None
    # Runtime data-dir filesystem usage; null when no candidate path exists.
    disk: DiskInfo | None = None
    # GPU utilization percentage in [0, 100]; null when there is no GPU or
    # nvidia-smi cannot be queried.
    gpu_percent: float | None = None


def _read_cpu_info() -> CpuInfo:
    """Parse ``/proc/cpuinfo`` for the model name + logical core count.

    Returns nulls on any failure (missing file, permission error, unexpected
    format) — never raises.
    """
    try:
        text = Path("/proc/cpuinfo").read_text(encoding="utf-8")
    except OSError as exc:
        logger.debug("could not read /proc/cpuinfo", extra={"error": str(exc)})
        return CpuInfo()

    model: str | None = None
    cores = 0
    for line in text.splitlines():
        # One "processor" block per logical core; "model name" repeats per core.
        if line.startswith("processor"):
            cores += 1
        elif model is None and line.startswith("model name"):
            _, _, value = line.partition(":")
            value = value.strip()
            if value:
                model = value
    return CpuInfo(model=model, cores=cores or None)


# CPU utilization is derived from two /proc/stat snapshots (a true busy % in
# [0, 100]) rather than os.getloadavg()/cores. Load average is a run-queue
# length, not a percentage: it can exceed the core count and would read as a
# misleading ">100%" bar, which the honesty rule forbids. This stays pure stdlib
# and non-blocking (no 1s sample sleep) — the delta window is simply the gap
# between cached refreshes, so the very first sample reports null.
def _read_proc_stat() -> str | None:
    """Read ``/proc/stat`` via plain ``open`` (deliberately not the module-level
    ``Path``, which the CPU-model test mocks to return ``/proc/cpuinfo``). Returns
    None on any read error.
    """
    try:
        with open("/proc/stat", encoding="utf-8") as fh:
            return fh.read()
    except OSError as exc:
        logger.debug("could not read /proc/stat", extra={"error": str(exc)})
        return None


def _read_cpu_times() -> tuple[int, int] | None:
    """Return ``(busy_jiffies, total_jiffies)`` from the aggregate ``cpu`` line.

    ``/proc/stat``'s first ``cpu`` line sums every core:
    ``cpu user nice system idle iowait irq softirq steal ...``. Busy time is the
    total minus the two idle components (idle + iowait). Returns None when the
    line is missing or malformed.
    """
    text = _read_proc_stat()
    if text is None:
        return None
    for line in text.splitlines():
        if line.startswith("cpu "):
            fields = line.split()[1:]
            try:
                values = [int(f) for f in fields]
            except ValueError:
                return None
            if len(values) < 5:
                return None
            idle = values[3] + values[4]  # idle + iowait
            total = sum(values)
            return total - idle, total
    return None


def _cpu_percent(
    prev: tuple[int, int] | None, cur: tuple[int, int] | None
) -> float | None:
    """Busy percentage between two ``_read_cpu_times`` snapshots, in [0, 100].

    Returns None when either snapshot is missing (e.g. the first sample) or the
    total jiffies did not advance.
    """
    if prev is None or cur is None:
        return None
    busy_delta = cur[0] - prev[0]
    total_delta = cur[1] - prev[1]
    if total_delta <= 0:
        return None
    return max(0.0, min(100.0, round(100.0 * busy_delta / total_delta, 1)))


def _read_disk(data_dir: str | None) -> DiskInfo | None:
    """Free/total bytes of the filesystem holding the runtime data dir.

    Tries the app-known ``data_dir`` first, then ``/data`` (the container bind
    mount where recordings actually land — ``data_dir`` defaults to a relative
    ``./data`` that only resolves from the repo root). Returns None when neither
    candidate path exists.
    """
    seen: set[str] = set()
    for path in (data_dir, "/data"):
        if not path or path in seen:
            continue
        seen.add(path)
        try:
            usage = shutil.disk_usage(path)
        except OSError:
            continue
        return DiskInfo(path=path, total_bytes=usage.total, free_bytes=usage.free)
    return None


def _read_gpu_name() -> str | None:
    """Best-effort GPU name via ``nvidia-smi``; ``None`` if absent/errors.

    Returns the first GPU's name (multi-GPU hosts collapse to the first line).
    Any failure — binary missing, non-zero exit, timeout — yields ``None``.
    """
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=_NVIDIA_SMI_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("nvidia-smi unavailable", extra={"error": str(exc)})
        return None
    if result.returncode != 0:
        return None
    name = result.stdout.strip().splitlines()
    return name[0].strip() if name and name[0].strip() else None


def _read_gpu_percent() -> float | None:
    """Best-effort GPU utilization (%) via ``nvidia-smi``; None on any failure.

    Returns the first GPU's utilization, clamped to [0, 100]. Any failure —
    binary missing, non-zero exit, timeout, unparseable output — yields None.
    """
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=_NVIDIA_SMI_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("nvidia-smi utilization unavailable", extra={"error": str(exc)})
        return None
    if result.returncode != 0:
        return None
    lines = result.stdout.strip().splitlines()
    if not lines:
        return None
    try:
        return max(0.0, min(100.0, float(lines[0].strip())))
    except ValueError:
        return None


async def _cached_gpu_name(state: Any) -> str | None:
    """Return the GPU name, probing ``nvidia-smi`` at most once per app.

    The GPU name is immutable for the process lifetime, so the first result is
    cached on ``app.state`` and every later request returns it without touching a
    subprocess. The probe itself runs in a worker thread so a slow/hung
    ``nvidia-smi`` never blocks the event loop (the first request may wait up to
    the probe timeout; subsequent ones don't block at all).
    """
    cached = getattr(state, "gpu_name", _GPU_UNPROBED)
    if cached is not _GPU_UNPROBED:
        return cached  # type: ignore[no-any-return]
    name = await asyncio.to_thread(_read_gpu_name)
    state.gpu_name = name
    return name


async def _cached_utilization(
    state: Any, data_dir: str | None, gpu_present: bool
) -> tuple[float | None, DiskInfo | None, float | None]:
    """Return ``(cpu_percent, disk, gpu_percent)``, refreshed at most every
    ``_SAMPLE_TTL_S`` seconds.

    The cheap probes (CPU delta, disk stat) run inline; the nvidia-smi
    utilization probe (only when a GPU exists) runs in a worker thread so a
    slow/hung nvidia-smi never blocks the event loop. A lock serializes the
    refresh so a burst of concurrent requests spawns at most one probe.
    """
    cached = getattr(state, "util_sample", None)
    if cached is not None and time.monotonic() - cached[0] < _SAMPLE_TTL_S:
        return cached[1], cached[2], cached[3]

    lock = getattr(state, "util_lock", None)
    if lock is None:
        lock = asyncio.Lock()
        state.util_lock = lock
    async with lock:
        # A concurrent request may have refreshed while we waited on the lock.
        cached = getattr(state, "util_sample", None)
        if cached is not None and time.monotonic() - cached[0] < _SAMPLE_TTL_S:
            return cached[1], cached[2], cached[3]

        cur = _read_cpu_times()
        cpu_percent = _cpu_percent(getattr(state, "cpu_prev", None), cur)
        state.cpu_prev = cur

        disk = _read_disk(data_dir)

        gpu_percent = None
        if gpu_present:
            gpu_percent = await asyncio.to_thread(_read_gpu_percent)

        state.util_sample = (time.monotonic(), cpu_percent, disk, gpu_percent)
        return cpu_percent, disk, gpu_percent


@router.get("")
async def system_info(request: Request) -> SystemInfo:
    """Return host CPU/GPU names + live utilization/disk. Always 200 (nulls on
    failure)."""
    state = request.app.state
    settings = getattr(state, "settings", None)
    data_dir = getattr(settings, "data_dir", None)
    gpu = await _cached_gpu_name(state)
    cpu_percent, disk, gpu_percent = await _cached_utilization(
        state, data_dir, gpu is not None
    )
    return SystemInfo(
        cpu=_read_cpu_info(),
        gpu=gpu,
        cpu_percent=cpu_percent,
        disk=disk,
        gpu_percent=gpu_percent,
    )
