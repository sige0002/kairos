"""Host system info (``GET /api/v1/system``): CPU + best-effort GPU.

Read-only, non-intrusive operator context for the UI header. The CPU model and
logical core count come from ``/proc/cpuinfo`` (pure stdlib). The GPU name is a
best-effort ``nvidia-smi`` probe with a short timeout.

This endpoint never raises: any probe failure (no ``/proc/cpuinfo``, no
``nvidia-smi``, timeout, parse error) degrades to ``null`` fields so the header
can simply omit what it cannot determine. It is purely informational and does
not touch the ROS 2 graph, so it can never disturb a recording.
"""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger("kairos")

router = APIRouter(prefix="/api/v1/system", tags=["system"])

# Short cap so a hung/slow nvidia-smi never blocks the request.
_NVIDIA_SMI_TIMEOUT_S = 1.5


class CpuInfo(BaseModel):
    """Host CPU summary parsed from ``/proc/cpuinfo`` (best-effort)."""

    model: str | None = None
    cores: int | None = None


class SystemInfo(BaseModel):
    """Host system summary for the UI header (CPU + best-effort GPU)."""

    cpu: CpuInfo
    gpu: str | None = None


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


@router.get("")
async def system_info() -> SystemInfo:
    """Return host CPU/GPU info for the UI header. Always 200 (nulls on failure)."""
    return SystemInfo(cpu=_read_cpu_info(), gpu=_read_gpu_name())
