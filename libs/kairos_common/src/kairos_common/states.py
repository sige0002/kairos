"""Shared enum vocabularies from ``docs/specs/ja/config.md``."""

from __future__ import annotations

from enum import StrEnum


class JobState(StrEnum):
    """Asynchronous pipeline job state shared by orchestrator and dora_runner."""

    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    canceled = "canceled"
