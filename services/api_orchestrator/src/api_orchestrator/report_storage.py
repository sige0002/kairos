# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Safe, criteria-based cleanup of generated pipeline reports.

The public criteria deliberately contain no filesystem path.  A caller chooses
semantic categories, age, pipeline and source availability; this module resolves
the concrete ``report/<pipeline>/<capture>/`` units beneath the configured data
directory and never follows symlinks.
"""

from __future__ import annotations

import logging
import os
import shutil
import time
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Protocol

from pydantic import BaseModel, Field, field_validator

from api_orchestrator.layout import DataLayout
from api_orchestrator.store import TOMBSTONE_STATES
from api_orchestrator.verdict import GATING_PIPELINES

logger = logging.getLogger(__name__)

SECONDS_PER_DAY = 86_400
_WRITER_LEASE_TTL_S = 24 * 60 * 60
_VALIDATION_PIPELINES = frozenset({"fast_validation", "full_validation"})
_PREVIEW_PIPELINES = frozenset({"video_check"})


class ReportCategory(StrEnum):
    """Operator-facing classes of generated files."""

    preview = "preview"
    analysis = "analysis"
    validation = "validation"


class CaptureScope(StrEnum):
    """Which relationship to canonical capture bytes may be selected."""

    source_available = "source_available"
    orphaned = "orphaned"
    all = "all"


class ReportCleanupCriteria(BaseModel):
    """Path-free selection accepted by preview and cleanup endpoints."""

    categories: list[ReportCategory] = Field(
        default_factory=lambda: [ReportCategory.preview, ReportCategory.analysis],
        min_length=1,
    )
    # Zero has an explicit UI meaning: include every generation date.
    older_than_days: int = Field(default=30, ge=0, le=36_500)
    pipeline: str | None = None
    capture_scope: CaptureScope = CaptureScope.source_available

    @field_validator("categories")
    @classmethod
    def unique_categories(cls, value: list[ReportCategory]) -> list[ReportCategory]:
        """Keep request order while making repeated checkboxes harmless."""
        return list(dict.fromkeys(value))

    @field_validator("pipeline")
    @classmethod
    def safe_pipeline_filter(cls, value: str | None) -> str | None:
        """Reject anything path-like; the value is only an exact scan filter."""
        if value is None:
            return None
        value = value.strip()
        if (
            not value
            or value.startswith(".")
            or "/" in value
            or "\\" in value
            or any(not (char.isalnum() or char in "_.-") for char in value)
        ):
            raise ValueError("pipeline must be a pipeline id, not a path")
        return value


class PipelineReportUsage(BaseModel):
    """Selected usage for one pipeline."""

    pipeline: str
    category: ReportCategory
    bytes: int
    files: int
    units: int


class ReportStoragePreview(BaseModel):
    """Exact preview of the units currently eligible for removal."""

    report_total_bytes: int
    report_total_files: int
    selected_bytes: int
    selected_files: int
    selected_units: int
    selected_captures: int
    validation_resets: int
    orphaned_units: int
    source_unavailable_units: int
    protected_active_units: int
    scan_errors: int
    available_pipelines: list[str]
    by_pipeline: list[PipelineReportUsage]


class CleanupFailure(BaseModel):
    """One report unit which could not be removed."""

    pipeline: str
    capture_id: str
    message: str


class ReportCleanupResult(BaseModel):
    """Observed cleanup outcome; byte counts are from successfully removed units."""

    deleted_bytes: int
    deleted_files: int
    deleted_units: int
    protected_active_units: int
    failed_units: list[CleanupFailure]
    remaining_report_bytes: int


class _CaptureStore(Protocol):
    def get_capture(self, capture_id: str):  # noqa: ANN201 - structural protocol
        """Return a capture-like object carrying ``state``, or ``None``."""

    def has_live_lease(self, capture_id: str) -> bool:
        """Whether a job may still read the source or write this report."""

    def acquire_writer_lease(
        self, capture_id: str, owner: str, *, ttl_s: float
    ) -> bool:
        """Exclude new report writers while one report unit is removed."""

    def release_lease(self, capture_id: str, owner: str) -> bool:
        """Release the cleanup writer lease."""


class _SourceState(StrEnum):
    available = "available"
    orphaned = "orphaned"
    unavailable = "unavailable"


@dataclass(frozen=True)
class _ReportUnit:
    path: Path
    pipeline: str
    capture_id: str
    category: ReportCategory
    source_state: _SourceState
    bytes: int
    files: int
    newest_mtime: float


@dataclass(frozen=True)
class _Selection:
    all_units: list[_ReportUnit]
    selected: list[_ReportUnit]
    protected_active_units: int
    scan_errors: int


def _category_of(pipeline: str) -> ReportCategory:
    if pipeline in _VALIDATION_PIPELINES:
        return ReportCategory.validation
    if pipeline in _PREVIEW_PIPELINES:
        return ReportCategory.preview
    return ReportCategory.analysis


def _state_value(capture: object) -> str:
    state = getattr(capture, "state", "")
    return str(getattr(state, "value", state))


class ReportStorageService:
    """Analyze and remove report units rooted beneath one :class:`DataLayout`."""

    def __init__(self, layout: DataLayout, store: _CaptureStore) -> None:
        self._layout = layout
        self._store = store

    def preview(self, criteria: ReportCleanupCriteria) -> ReportStoragePreview:
        """Return current usage and deletion impact without mutating storage."""
        selection = self._select(criteria)
        selected = selection.selected
        grouped: dict[str, list[_ReportUnit]] = {}
        for unit in selected:
            grouped.setdefault(unit.pipeline, []).append(unit)
        by_pipeline = [
            PipelineReportUsage(
                pipeline=pipeline,
                category=units[0].category,
                bytes=sum(unit.bytes for unit in units),
                files=sum(unit.files for unit in units),
                units=len(units),
            )
            for pipeline, units in sorted(grouped.items())
        ]
        return ReportStoragePreview(
            report_total_bytes=sum(unit.bytes for unit in selection.all_units),
            report_total_files=sum(unit.files for unit in selection.all_units),
            selected_bytes=sum(unit.bytes for unit in selected),
            selected_files=sum(unit.files for unit in selected),
            selected_units=len(selected),
            selected_captures=len({unit.capture_id for unit in selected}),
            validation_resets=len(
                {
                    unit.capture_id
                    for unit in selected
                    if unit.pipeline in GATING_PIPELINES
                }
            ),
            orphaned_units=sum(
                unit.source_state is _SourceState.orphaned for unit in selected
            ),
            source_unavailable_units=sum(
                unit.source_state is _SourceState.unavailable for unit in selected
            ),
            protected_active_units=selection.protected_active_units,
            scan_errors=selection.scan_errors,
            available_pipelines=sorted({unit.pipeline for unit in selection.all_units}),
            by_pipeline=by_pipeline,
        )

    def cleanup(self, criteria: ReportCleanupCriteria) -> ReportCleanupResult:
        """Re-scan and remove eligible units, reporting every failure honestly."""
        selection = self._select(criteria)
        deleted_bytes = 0
        deleted_files = 0
        deleted_units = 0
        protected = selection.protected_active_units
        failed: list[CleanupFailure] = []
        touched_pipelines: set[Path] = set()
        for unit in selection.selected:
            owner = f"writer:report-cleanup:{unit.pipeline}:{unit.capture_id}"
            if not self._store.acquire_writer_lease(
                unit.capture_id, owner, ttl_s=_WRITER_LEASE_TTL_S
            ):
                protected += 1
                continue
            try:
                try:
                    shutil.rmtree(unit.path)
                    if unit.path.exists():
                        raise OSError("report directory still exists after removal")
                except OSError as exc:
                    logger.warning(
                        "could not remove generated report %s: %s", unit.path, exc
                    )
                    failed.append(
                        CleanupFailure(
                            pipeline=unit.pipeline,
                            capture_id=unit.capture_id,
                            message=str(exc),
                        )
                    )
                    continue
            finally:
                self._store.release_lease(unit.capture_id, owner)
            deleted_bytes += unit.bytes
            deleted_files += unit.files
            deleted_units += 1
            touched_pipelines.add(unit.path.parent)

        # Empty pipeline directories have no meaning.  ``rmdir`` is deliberately
        # non-recursive and best-effort: a new job may have populated one since
        # the scan, in which case it must remain.
        for pipeline_dir in touched_pipelines:
            try:
                pipeline_dir.rmdir()
            except OSError:
                pass

        remaining = self._scan()[0]
        return ReportCleanupResult(
            deleted_bytes=deleted_bytes,
            deleted_files=deleted_files,
            deleted_units=deleted_units,
            protected_active_units=protected,
            failed_units=failed,
            remaining_report_bytes=sum(unit.bytes for unit in remaining),
        )

    def _select(self, criteria: ReportCleanupCriteria) -> _Selection:
        units, scan_errors = self._scan()
        categories = set(criteria.categories)
        cutoff = (
            None
            if criteria.older_than_days == 0
            else time.time() - criteria.older_than_days * SECONDS_PER_DAY
        )
        selected: list[_ReportUnit] = []
        protected = 0
        for unit in units:
            if unit.category not in categories:
                continue
            if criteria.pipeline is not None and unit.pipeline != criteria.pipeline:
                continue
            if cutoff is not None and unit.newest_mtime > cutoff:
                continue
            if not self._scope_matches(criteria.capture_scope, unit.source_state):
                continue
            if self._store.has_live_lease(unit.capture_id):
                protected += 1
                continue
            selected.append(unit)
        return _Selection(units, selected, protected, scan_errors)

    @staticmethod
    def _scope_matches(scope: CaptureScope, state: _SourceState) -> bool:
        if scope is CaptureScope.all:
            return True
        if scope is CaptureScope.orphaned:
            return state is _SourceState.orphaned
        return state is _SourceState.available

    def _scan(self) -> tuple[list[_ReportUnit], int]:
        units: list[_ReportUnit] = []
        errors = 0
        try:
            pipelines = sorted(self._layout.report.iterdir())
        except FileNotFoundError:
            return [], 0
        except OSError:
            return [], 1
        for pipeline_dir in pipelines:
            try:
                if (
                    pipeline_dir.name.startswith(".")
                    or pipeline_dir.is_symlink()
                    or not pipeline_dir.is_dir()
                ):
                    continue
                capture_dirs = sorted(pipeline_dir.iterdir())
            except OSError:
                errors += 1
                continue
            for report_dir in capture_dirs:
                try:
                    if report_dir.is_symlink() or not report_dir.is_dir():
                        continue
                    size, files, newest, unit_errors = self._measure(report_dir)
                    errors += unit_errors
                    # A partial measurement cannot support an honest preview
                    # or deletion receipt. Leave the whole unit untouched and
                    # expose the scan error so the operator can investigate.
                    if unit_errors:
                        continue
                    source_state = self._source_state(report_dir.name)
                    units.append(
                        _ReportUnit(
                            path=report_dir,
                            pipeline=pipeline_dir.name,
                            capture_id=report_dir.name,
                            category=_category_of(pipeline_dir.name),
                            source_state=source_state,
                            bytes=size,
                            files=files,
                            newest_mtime=newest,
                        )
                    )
                except OSError:
                    errors += 1
        return units, errors

    def _source_state(self, capture_id: str) -> _SourceState:
        capture = self._store.get_capture(capture_id)
        if capture is None or _state_value(capture) in TOMBSTONE_STATES:
            return _SourceState.orphaned
        source = self._layout.objects / capture_id
        try:
            if source.is_dir() and not source.is_symlink():
                return _SourceState.available
        except OSError:
            pass
        return _SourceState.unavailable

    @staticmethod
    def _measure(path: Path) -> tuple[int, int, float, int]:
        total = 0
        files = 0
        errors = 0
        try:
            newest = path.stat().st_mtime
        except OSError:
            newest = time.time()
            errors += 1
        for root, dirnames, filenames in os.walk(path, followlinks=False):
            root_path = Path(root)
            safe_dirs: list[str] = []
            for dirname in dirnames:
                candidate = root_path / dirname
                try:
                    if not candidate.is_symlink():
                        safe_dirs.append(dirname)
                except OSError:
                    errors += 1
            dirnames[:] = safe_dirs
            for filename in filenames:
                candidate = root_path / filename
                try:
                    if candidate.is_symlink() or not candidate.is_file():
                        continue
                    stat = candidate.stat()
                except OSError:
                    errors += 1
                    continue
                total += stat.st_size
                files += 1
                newest = max(newest, stat.st_mtime)
        return total, files, newest, errors
