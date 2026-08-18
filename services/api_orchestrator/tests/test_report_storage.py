# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Generated-report storage analysis and cleanup."""

from __future__ import annotations

import os
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from api_orchestrator.layout import DataLayout
from api_orchestrator.report_storage import (
    CaptureScope,
    ReportCategory,
    ReportCleanupCriteria,
    ReportStorageService,
)
from fastapi.testclient import TestClient
from pydantic import ValidationError


class FakeStore:
    def __init__(
        self,
        captures: dict[str, str] | None = None,
        leased: set[str] | None = None,
        writer_blocked: set[str] | None = None,
    ) -> None:
        self.captures = captures or {}
        self.leased = leased or set()
        self.writer_blocked = writer_blocked or set()

    def get_capture(self, capture_id: str):  # noqa: ANN201 - structural fake
        state = self.captures.get(capture_id)
        return SimpleNamespace(state=state) if state is not None else None

    def has_live_lease(self, capture_id: str) -> bool:
        return capture_id in self.leased

    def acquire_writer_lease(
        self, capture_id: str, owner: str, *, ttl_s: float
    ) -> bool:
        del ttl_s
        if capture_id in self.leased or capture_id in self.writer_blocked:
            return False
        self.leased.add(capture_id)
        return True

    def release_lease(self, capture_id: str, owner: str) -> bool:
        del owner
        if capture_id not in self.leased:
            return False
        self.leased.remove(capture_id)
        return True


def _report(
    root: Path,
    pipeline: str,
    capture_id: str,
    *,
    size: int,
    age_days: int,
) -> Path:
    report_dir = root / "report" / pipeline / capture_id
    report_dir.mkdir(parents=True)
    artifact = report_dir / "artifact.bin"
    artifact.write_bytes(b"x" * size)
    stamp = time.time() - age_days * 86_400
    os.utime(artifact, (stamp, stamp))
    os.utime(report_dir, (stamp, stamp))
    return report_dir


def _source(root: Path, capture_id: str) -> None:
    (root / "objects" / capture_id).mkdir(parents=True)


class TestReportStoragePreview:
    def test_filters_by_category_age_pipeline_and_source_scope(self, tmp_path: Path):
        _source(tmp_path, "capture-a")
        _source(tmp_path, "capture-b")
        _report(tmp_path, "video_check", "capture-a", size=100, age_days=40)
        _report(tmp_path, "signal_report", "capture-a", size=200, age_days=5)
        _report(tmp_path, "fast_validation", "capture-b", size=50, age_days=40)
        store = FakeStore({"capture-a": "completed", "capture-b": "completed"})
        service = ReportStorageService(DataLayout(tmp_path), store)

        preview = service.preview(
            ReportCleanupCriteria(
                categories=[ReportCategory.preview, ReportCategory.analysis],
                older_than_days=30,
                pipeline="video_check",
                capture_scope=CaptureScope.source_available,
            )
        )

        assert preview.report_total_bytes == 350
        assert preview.selected_bytes == 100
        assert preview.selected_files == 1
        assert preview.selected_units == 1
        assert preview.selected_captures == 1
        assert preview.validation_resets == 0
        assert preview.available_pipelines == [
            "fast_validation",
            "signal_report",
            "video_check",
        ]

    def test_reports_validation_impact_orphans_and_unavailable_sources(
        self, tmp_path: Path
    ):
        _source(tmp_path, "capture-local")
        _report(tmp_path, "fast_validation", "capture-local", size=10, age_days=40)
        _report(tmp_path, "video_check", "capture-gone", size=20, age_days=40)
        _report(tmp_path, "video_check", "capture-archived", size=30, age_days=40)
        store = FakeStore(
            {"capture-local": "completed", "capture-archived": "completed"}
        )
        service = ReportStorageService(DataLayout(tmp_path), store)

        preview = service.preview(
            ReportCleanupCriteria(
                categories=list(ReportCategory),
                older_than_days=0,
                capture_scope=CaptureScope.all,
            )
        )

        assert preview.selected_bytes == 60
        assert preview.validation_resets == 1
        assert preview.orphaned_units == 1
        assert preview.source_unavailable_units == 1

    def test_active_capture_is_protected(self, tmp_path: Path):
        _source(tmp_path, "capture-active")
        _report(tmp_path, "video_check", "capture-active", size=100, age_days=40)
        service = ReportStorageService(
            DataLayout(tmp_path),
            FakeStore({"capture-active": "completed"}, {"capture-active"}),
        )

        preview = service.preview(
            ReportCleanupCriteria(
                categories=[ReportCategory.preview], older_than_days=0
            )
        )

        assert preview.selected_units == 0
        assert preview.selected_bytes == 0
        assert preview.protected_active_units == 1

    def test_rejects_pipeline_paths(self):
        with pytest.raises(ValidationError):
            ReportCleanupCriteria(
                categories=[ReportCategory.preview], pipeline="../../objects"
            )

    def test_excludes_a_partially_measured_unit(self, tmp_path: Path, monkeypatch):
        _source(tmp_path, "capture-unreadable")
        report = _report(
            tmp_path, "video_check", "capture-unreadable", size=100, age_days=40
        )
        service = ReportStorageService(
            DataLayout(tmp_path), FakeStore({"capture-unreadable": "completed"})
        )
        monkeypatch.setattr(service, "_measure", lambda _path: (0, 0, 0.0, 1))

        preview = service.preview(
            ReportCleanupCriteria(
                categories=[ReportCategory.preview], older_than_days=0
            )
        )

        assert preview.selected_units == 0
        assert preview.scan_errors == 1
        assert report.exists()


class TestReportStorageCleanup:
    def test_deletes_only_selected_units_and_keeps_active_work(self, tmp_path: Path):
        for capture_id in ("capture-a", "capture-active"):
            _source(tmp_path, capture_id)
        video = _report(tmp_path, "video_check", "capture-a", size=100, age_days=40)
        validation = _report(
            tmp_path, "fast_validation", "capture-a", size=20, age_days=40
        )
        active = _report(
            tmp_path, "video_check", "capture-active", size=30, age_days=40
        )
        service = ReportStorageService(
            DataLayout(tmp_path),
            FakeStore(
                {"capture-a": "completed", "capture-active": "completed"},
                {"capture-active"},
            ),
        )

        result = service.cleanup(
            ReportCleanupCriteria(
                categories=[ReportCategory.preview], older_than_days=30
            )
        )

        assert result.deleted_units == 1
        assert result.deleted_bytes == 100
        assert result.failed_units == []
        assert result.protected_active_units == 1
        assert not video.exists()
        assert validation.exists()
        assert active.exists()

    def test_skips_a_unit_when_a_job_wins_after_the_preview_scan(
        self, tmp_path: Path
    ) -> None:
        _source(tmp_path, "capture-racing")
        report = _report(
            tmp_path, "video_check", "capture-racing", size=100, age_days=40
        )
        service = ReportStorageService(
            DataLayout(tmp_path),
            FakeStore(
                {"capture-racing": "completed"}, writer_blocked={"capture-racing"}
            ),
        )

        result = service.cleanup(
            ReportCleanupCriteria(
                categories=[ReportCategory.preview], older_than_days=30
            )
        )

        assert result.deleted_units == 0
        assert result.protected_active_units == 1
        assert report.exists()


class TestReportStorageApi:
    def test_preview_and_cleanup_accept_only_semantic_criteria(
        self, client: TestClient, data_dir: Path
    ) -> None:
        report = _report(data_dir, "video_check", "orphan-report", size=64, age_days=40)
        request = {
            "categories": ["preview"],
            "older_than_days": 30,
            "capture_scope": "orphaned",
        }

        preview = client.post("/api/v1/report-storage/preview", json=request)
        assert preview.status_code == 200
        assert preview.json()["selected_bytes"] == 64
        assert "path" not in preview.json()

        cleanup = client.post("/api/v1/report-storage/cleanup", json=request)
        assert cleanup.status_code == 200
        assert cleanup.json()["deleted_units"] == 1
        assert not report.exists()
