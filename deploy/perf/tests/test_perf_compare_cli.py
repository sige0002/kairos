"""Exit-status and output contracts for the benchmark comparison CLI."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import perf_compare
import pytest
from perf_harness import build_manifest


def _result(*, camera_count: int = 0, git_sha: str = "abc") -> dict[str, Any]:
    manifest = build_manifest(
        scenario_name="monitor-control",
        duration_s=3.0,
        warmup_s=0.0,
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
    )
    manifest["environment"].update(
        {"git_dirty": False, "workspace_fingerprint": "0" * 64}
    )
    return {
        "schema_version": "kairos.perf.result/v2",
        "manifest": manifest,
        "raw_samples": [
            {"elapsed_s": 1.0},
            {"elapsed_s": 2.0},
            {"elapsed_s": 3.0},
        ],
        "warmup_samples": 0,
        "measurement_sample_count": 3,
        "cadence": {
            "status": "valid",
            "expected_sample_count": 3,
            "actual_sample_count": 3,
            "interval_s": 1.0,
            "tolerance_s": 0.25,
            "expected_deadlines_s": [1.0, 2.0, 3.0],
            "deadline_errors_s": [0.0, 0.0, 0.0],
            "intervals_s": [1.0, 1.0],
            "max_gap_s": 1.0,
            "max_overrun_s": 0.0,
            "elapsed_s": 3.0,
        },
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


def test_invalid_cadence_artifact_is_rejected(tmp_path: Path, capsys: Any) -> None:
    baseline = tmp_path / "baseline.json"
    candidate = tmp_path / "candidate.json"
    invalid = _result()
    invalid["cadence"]["actual_sample_count"] = 2
    _write(baseline, invalid)
    _write(candidate, _result())

    code = perf_compare.main([str(baseline), str(candidate)])

    captured = capsys.readouterr()
    assert code == 2
    assert "invalid cadence evidence" in captured.err


def test_legacy_v1_artifact_is_explicitly_rejected(tmp_path: Path, capsys: Any) -> None:
    baseline = tmp_path / "baseline.json"
    candidate = tmp_path / "candidate.json"
    legacy = _result()
    legacy["schema_version"] = "kairos.perf.result/v1"
    _write(baseline, legacy)
    _write(candidate, _result())

    code = perf_compare.main([str(baseline), str(candidate)])

    captured = capsys.readouterr()
    assert code == 2
    assert "unsupported result schema" in captured.err


@pytest.mark.parametrize("timing", [float("nan"), float("inf"), -1.0, 0.0])
def test_nonfinite_or_nonpositive_timing_artifact_is_rejected(
    timing: float, tmp_path: Path, capsys: Any
) -> None:
    baseline = tmp_path / "baseline.json"
    candidate = tmp_path / "candidate.json"
    invalid = _result()
    invalid["manifest"]["scenario"]["duration_s"] = timing
    _write(baseline, invalid)
    _write(candidate, _result())

    code = perf_compare.main([str(baseline), str(candidate)])

    captured = capsys.readouterr()
    assert code == 2
    assert "invalid cadence evidence" in captured.err
    assert "Traceback" not in captured.err


@pytest.mark.parametrize("warmup_s", [float("nan"), float("inf"), -1.0, 3.0])
def test_invalid_warmup_timing_artifact_is_rejected(
    warmup_s: float, tmp_path: Path, capsys: Any
) -> None:
    baseline = tmp_path / "baseline.json"
    candidate = tmp_path / "candidate.json"
    invalid = _result()
    invalid["manifest"]["scenario"]["warmup_s"] = warmup_s
    _write(baseline, invalid)
    _write(candidate, _result())

    code = perf_compare.main([str(baseline), str(candidate)])

    captured = capsys.readouterr()
    assert code == 2
    assert "invalid cadence evidence" in captured.err
    assert "Traceback" not in captured.err


@pytest.mark.parametrize(
    ("warmup_samples", "measurement_sample_count"), [(3, 0), (4, -1)]
)
def test_invalid_warmup_accounting_artifact_is_rejected(
    warmup_samples: int,
    measurement_sample_count: int,
    tmp_path: Path,
    capsys: Any,
) -> None:
    baseline = tmp_path / "baseline.json"
    candidate = tmp_path / "candidate.json"
    invalid = _result()
    invalid["warmup_samples"] = warmup_samples
    invalid["measurement_sample_count"] = measurement_sample_count
    _write(baseline, invalid)
    _write(candidate, _result())

    code = perf_compare.main([str(baseline), str(candidate)])

    captured = capsys.readouterr()
    assert code == 2
    assert "invalid cadence evidence" in captured.err


def test_warmup_must_match_scenario_timing(tmp_path: Path, capsys: Any) -> None:
    baseline = tmp_path / "baseline.json"
    candidate = tmp_path / "candidate.json"
    invalid = _result()
    invalid["manifest"]["scenario"]["warmup_s"] = 0.1
    _write(baseline, invalid)
    _write(candidate, _result())

    code = perf_compare.main([str(baseline), str(candidate)])

    captured = capsys.readouterr()
    assert code == 2
    assert "invalid cadence evidence" in captured.err


def test_dirty_or_different_workspace_artifacts_are_invalid(
    tmp_path: Path, capsys: Any
) -> None:
    baseline = tmp_path / "baseline.json"
    candidate = tmp_path / "candidate.json"
    dirty = _result()
    dirty["manifest"]["environment"]["git_dirty"] = True
    _write(baseline, dirty)
    _write(candidate, _result())

    code = perf_compare.main([str(baseline), str(candidate)])

    assert code == 2
    assert "baseline.environment.git_dirty" in capsys.readouterr().out

    different = _result()
    different["manifest"]["environment"]["workspace_fingerprint"] = "1" * 64
    _write(baseline, _result())
    _write(candidate, different)

    code = perf_compare.main([str(baseline), str(candidate)])

    assert code == 2
    assert "environment.workspace_fingerprint" in capsys.readouterr().out
