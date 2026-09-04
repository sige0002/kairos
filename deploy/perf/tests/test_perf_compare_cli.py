"""Exit-status and output contracts for the benchmark comparison CLI."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import perf_compare
from perf_harness import build_manifest


def _result(*, camera_count: int = 0, git_sha: str = "abc") -> dict[str, Any]:
    return {
        "manifest": build_manifest(
            scenario_name="monitor-control",
            duration_s=30.0,
            warmup_s=5.0,
            sample_interval_s=1.0,
            camera_count=camera_count,
            selected_topics=["/example/control"],
            preview_layout="none",
            preview_caps={"max_fps": None},
            recorder_state="created",
            probe_state="idle",
            robot_motion="stationary",
            rmw="rmw_cyclonedds_cpp",
            transport_evidence={"cyclonedds_safe_profile": True},
            config_hashes={"recording": "abc"},
            git_sha=git_sha,
        ),
        "summary": {"host.cpu_busy_pct_machine": {"mean": 10.0}},
    }


def _write(path: Path, value: object) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


def test_valid_comparison_prints_and_writes_report(tmp_path: Path, capsys: Any) -> None:
    baseline = tmp_path / "baseline.json"
    candidate = tmp_path / "candidate.json"
    report = tmp_path / "report.md"
    _write(baseline, _result(git_sha="before"))
    _write(candidate, _result(git_sha="after"))

    code = perf_compare.main([str(baseline), str(candidate), "--output", str(report)])

    assert code == 0
    assert "Benchmark comparison: monitor-control" in capsys.readouterr().out
    assert report.read_text(encoding="utf-8").startswith("# Benchmark comparison")


def test_incompatible_workload_prints_report_and_returns_two(
    tmp_path: Path, capsys: Any
) -> None:
    baseline = tmp_path / "baseline.json"
    candidate = tmp_path / "candidate.json"
    _write(baseline, _result(camera_count=0))
    _write(candidate, _result(camera_count=4))

    code = perf_compare.main([str(baseline), str(candidate)])

    captured = capsys.readouterr()
    assert code == 2
    assert "INVALID COMPARISON" in captured.out
    assert "workload.camera_count" in captured.out
    assert captured.err == ""


def test_malformed_result_returns_two_without_traceback(
    tmp_path: Path, capsys: Any
) -> None:
    baseline = tmp_path / "baseline.json"
    candidate = tmp_path / "candidate.json"
    baseline.write_text("not-json", encoding="utf-8")
    _write(candidate, _result())

    code = perf_compare.main([str(baseline), str(candidate)])

    captured = capsys.readouterr()
    assert code == 2
    assert "perf-compare: invalid JSON" in captured.err
    assert "Traceback" not in captured.err
    assert captured.out == ""
