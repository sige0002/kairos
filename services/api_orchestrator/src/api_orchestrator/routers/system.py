# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Host system info (``GET /api/v1/system``): CPU + GPU + utilization + disk.

Read-only, non-intrusive operator context for the UI header and the Monitor /
Collect system cards. Static facts (CPU model + logical core count from
``/proc/cpuinfo``, the GPU name from ``nvidia-smi``) are joined with cheap,
briefly-cached utilization samples (CPU busy %, runtime data-dir disk
free/total, GPU utilization %).

The probes themselves — and the caching that keeps them cheap — live in
:mod:`api_orchestrator.system_probe`. This endpoint never raises: any probe
failure (no ``/proc``, no ``nvidia-smi``, timeout, parse error, a missing data
dir) degrades the relevant field to ``null`` so the UI can honestly show "—" for
what it cannot measure.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from api_orchestrator import system_probe
from api_orchestrator.system_probe import SystemInfo

router = APIRouter(prefix="/api/v1/system", tags=["system"])


@router.get("")
async def system_info(request: Request) -> SystemInfo:
    """Return host CPU/GPU names + live utilization/disk. Always 200 (nulls on
    failure)."""
    state = request.app.state
    settings = getattr(state, "settings", None)
    data_dir = getattr(settings, "data_dir", None)
    gpu = await system_probe._cached_gpu_name(state)
    cpu_percent, disk, gpu_percent = await system_probe._cached_utilization(
        state, data_dir, gpu is not None
    )
    return SystemInfo(
        cpu=system_probe._read_cpu_info(),
        gpu=gpu,
        cpu_percent=cpu_percent,
        disk=disk,
        gpu_percent=gpu_percent,
    )
