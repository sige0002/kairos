# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Request/response models for the exporter API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

ExportState = Literal["queued", "running", "complete", "failed", "canceled"]

TERMINAL_STATES: frozenset[str] = frozenset({"complete", "failed", "canceled"})


class ExportEpisode(BaseModel):
    """One episode of an export: a capture and the directory it stages into.

    ``dir`` is the display index the orchestrator resolved (``"001"``, ...); it
    becomes the bag directory name the converter sees, so episode order in the
    output follows the dataset's own numbering. ``task`` is the effective label
    resolved at submit time — ``None`` when the capture has none, in which case
    the export's ``task_fallback`` (or the profile's) answers.
    """

    capture_id: str
    dir: str
    task: str | None = None


class ExportRequest(BaseModel):
    """``POST /exports`` body. The orchestrator has already resolved everything."""

    export_id: str
    output_name: str
    profile_path: str
    task_fallback: str | None = None
    episodes: list[ExportEpisode]


class ExportStatus(BaseModel):
    """``GET /exports/{id}``: the whole volatile truth about one export.

    Nothing here is persisted. A restart forgets in-flight exports (their
    subprocess died with the process), which is why the status is 404 afterwards
    rather than a reconstructed guess.
    """

    export_id: str
    state: ExportState
    # Position in the FIFO queue, 1 = next to run. Only meaningful while queued.
    queue_position: int | None = None
    done: int = 0
    failed: int = 0
    total: int = 0
    # Progress WITHIN the episode currently being converted, 0-100.
    current_episode_pct: float | None = None
    # The converter's heartbeat has not advanced for KAIROS_LEROBOT_STALL_S.
    # Reported, never acted on: the export keeps running.
    stalled: bool = False
    message: str | None = None
    # Data-root relative (``exports/<name>``); set once the output exists.
    output_path: str | None = None


class ProfileInfo(BaseModel):
    """One robot profile from the active robot's LeRobot profile library."""

    name: str
    path: str
    source: Literal["committed", "local"]
    # None when the converter (and with it the config validator) is not
    # installed here — "unknown", never an optimistic true.
    valid: bool | None = None
    errors: list[str] = Field(default_factory=list)
    # observations[].topic + actions[].topic — the orchestrator's preflight
    # material for "does this capture carry what the profile asks for".
    topics: list[str] = Field(default_factory=list)
    fps: int | None = None


class ProfileListResponse(BaseModel):
    """``GET /profiles``. ``validator_unavailable`` is a service-level fact."""

    profiles: list[ProfileInfo]
    validator_unavailable: bool = False
