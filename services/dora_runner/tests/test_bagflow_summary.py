"""report.json -> summary.json: where the overall pass/fail verdict is decided."""

from __future__ import annotations

from typing import Any

from dora_runner.bagflow_summary import summarize


def _report(**overrides: Any) -> dict[str, Any]:
    report: dict[str, Any] = {
        "bag": {
            "path": "/data/recorded/run_1",
            "duration_s": 101.0,
            "message_count": 9000,
            "topics": {"/joint_states": {"count": 4000, "hz": 39.6}},
        },
        "results": {
            "bagflow_source": [{"check": "source_read", "ok": True}],
            "blur": [{"check": "blur", "ok": True, "laplacian_var_min": 42.0}],
            "topic_rate": [{"check": "topic_rate", "ok": True, "failures": []}],
        },
        "coverage": {
            "blur.frames": {"from": "decode/frames", "ratio_vs_upstream": 1.0},
            "decode.images": {"topic": "/cam", "ratio_vs_bag": 1.0},
        },
        "incomplete": [],
        "wall_s": 0.41,
    }
    report.update(overrides)
    return report


def test_all_checks_ok_is_a_pass() -> None:
    summary = summarize(_report(), flow="default", run_id="run_1", wall_s=0.56)

    assert summary["result"] == "pass"
    assert summary["pipeline"] == "full_validation"
    assert summary["flow"] == "default"
    assert summary["metrics"]["checks_total"] == 3
    assert summary["metrics"]["checks_failed"] == 0
    assert summary["metrics"]["coverage"] == 100.0
    assert summary["metrics"]["wall_s"] == 0.56
    assert "3/3 checks passed" in summary["message"]
    # The per-topic map stays in report.json; the summary keeps the rest of `bag`.
    assert "topics" not in summary["bag"]
    assert summary["bag"]["duration_s"] == 101.0


def test_a_failed_check_fails_the_run_and_is_named() -> None:
    report = _report()
    report["results"]["blur"] = [{"check": "blur", "ok": False, "blurry_ratio": 0.4}]

    summary = summarize(report, flow="default", run_id="run_1")

    assert summary["result"] == "fail"
    assert summary["metrics"]["checks_failed"] == 1
    assert "blur.blur" in summary["message"]


def test_source_read_failure_fails_the_run() -> None:
    """A truncated recording surfaces as the source node's own check."""
    report = _report()
    report["results"]["bagflow_source"] = [
        {"check": "source_read", "ok": False, "read_error": "Chunk ended mid-record"}
    ]

    assert summarize(report, flow="default", run_id="run_1")["result"] == "fail"


def test_incomplete_node_fails_even_with_no_failed_check() -> None:
    """A node that died ran none of its checks — 'no failures' would be a lie."""
    summary = summarize(
        _report(incomplete=["result_freeze"]), flow="default", run_id="run_1"
    )

    assert summary["result"] == "fail"
    assert summary["incomplete"] == ["freeze"]
    assert "freeze" in summary["message"]


def test_no_results_at_all_fails() -> None:
    summary = summarize(_report(results={}), flow="default", run_id="run_1")

    assert summary["result"] == "fail"
    assert "no check produced a result" in summary["message"]


def test_coverage_is_reported_but_only_gates_when_asked() -> None:
    report = _report(
        coverage={"freeze.frames": {"from": "decode/frames", "ratio_vs_upstream": 0.62}}
    )

    ungated = summarize(report, flow="default", run_id="run_1")
    assert ungated["result"] == "pass"
    assert ungated["metrics"]["coverage"] == 62.0
    assert ungated["metrics"]["min_coverage_required"] is None

    gated = summarize(report, flow="default", run_id="run_1", min_coverage=0.9)
    assert gated["result"] == "fail"
    assert gated["metrics"]["min_coverage_required"] == 90.0


def test_missing_coverage_ratios_are_null_not_zero() -> None:
    """A bag without metadata.yaml gives bagflow nothing to compare against;
    reporting 0% would read as 'we saw nothing' instead of 'unknown'."""
    summary = summarize(
        _report(coverage={"decode.images": {"topic": "/cam", "ratio_vs_bag": None}}),
        flow="default",
        run_id="run_1",
        min_coverage=0.9,
    )

    assert summary["metrics"]["coverage"] is None
    assert summary["result"] == "pass"
