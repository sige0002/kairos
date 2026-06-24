"""In-memory job and validation template state for dora_runner."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from kairos_common import JobState

from dora_runner.models import JobResult, JobStatus, ValidationTemplate


@dataclass
class JobRecord:
    """Mutable internal job record."""

    job_id: str
    run_id: str
    pipeline: str
    params: dict[str, Any]
    state: JobState = JobState.queued
    progress: float = 0.0
    logs_tail: list[str] = field(default_factory=list)
    result: JobResult | None = None
    task: asyncio.Task[None] | None = None

    def status(self) -> JobStatus:
        """Return the public status view."""
        return JobStatus(
            job_id=self.job_id,
            run_id=self.run_id,
            pipeline=self.pipeline,
            state=self.state,
            progress=self.progress,
            logs_tail=self.logs_tail[-50:],
        )


class RunnerStore:
    """Process-local store for v1 dora_runner jobs/templates."""

    def __init__(self) -> None:
        self.jobs: dict[str, JobRecord] = {}
        self.templates: list[ValidationTemplate] = []
        self.lock = asyncio.Lock()

    async def add_template(self, template: ValidationTemplate) -> ValidationTemplate:
        """Create or replace a template by ``(name, version)``."""
        async with self.lock:
            self.templates = [
                item
                for item in self.templates
                if not (item.name == template.name and item.version == template.version)
            ]
            self.templates.append(template)
        return template

    async def list_templates(
        self, limit: int, cursor: int | None
    ) -> tuple[list[ValidationTemplate], int | None]:
        """Return newest-first template page."""
        async with self.lock:
            ordered = list(reversed(self.templates))
        start = cursor or 0
        page = ordered[start : start + limit]
        next_cursor = start + limit if len(ordered) > start + limit else None
        return page, next_cursor

    async def get_template(self, name: str) -> ValidationTemplate | None:
        """Return the newest template with *name*."""
        async with self.lock:
            for template in reversed(self.templates):
                if template.name == name:
                    return template
        return None
