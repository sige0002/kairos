"""Deterministic clock and HTTP boundaries used by the live harness."""

from __future__ import annotations

import json
from typing import Any

import pytest
from perf_harness import (
    collect_fixed_window,
    fetch_json,
    fixed_window_evidence,
    unavailable,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def test_fixed_window_uses_injected_clock_and_keeps_sample_times() -> None:
    clock = FakeClock()
    calls = 0

    def collect() -> dict[str, int]:
        nonlocal calls
        calls += 1
        return {"sequence": calls}

    samples = collect_fixed_window(
        duration_s=3.0,
        interval_s=1.0,
        collect=collect,
        monotonic=clock.monotonic,
        sleep=clock.sleep,
    )

    assert samples == [
        {"sequence": 1, "elapsed_s": 1.0},
        {"sequence": 2, "elapsed_s": 2.0},
        {"sequence": 3, "elapsed_s": 3.0},
    ]
    assert clock.sleeps == [1.0, 1.0, 1.0]


def test_fixed_window_uses_ceil_count_for_a_partial_final_interval() -> None:
    clock = FakeClock()

    samples = collect_fixed_window(
        duration_s=2.5,
        interval_s=1.0,
        collect=lambda: {},
        monotonic=clock.monotonic,
        sleep=clock.sleep,
    )

    assert [sample["elapsed_s"] for sample in samples] == [1.0, 2.0, 2.5]
    assert clock.sleeps == [1.0, 1.0, 0.5]


def test_fixed_window_collects_once_at_duration_when_duration_is_shorter() -> None:
    clock = FakeClock()

    samples = collect_fixed_window(
        duration_s=0.5,
        interval_s=1.0,
        collect=lambda: {},
        monotonic=clock.monotonic,
        sleep=clock.sleep,
    )

    assert samples == [{"elapsed_s": 0.5}]
    assert clock.sleeps == [0.5]


def test_fixed_window_evidence_records_exact_cadence() -> None:
    evidence = fixed_window_evidence(
        [
            {"elapsed_s": 1.02},
            {"elapsed_s": 2.01},
            {"elapsed_s": 3.03},
        ],
        duration_s=3.0,
        interval_s=1.0,
    )

    assert evidence == {
        "status": "valid",
        "expected_sample_count": 3,
        "actual_sample_count": 3,
        "interval_s": 1.0,
        "tolerance_s": 0.25,
        "expected_deadlines_s": [1.0, 2.0, 3.0],
        "deadline_errors_s": pytest.approx([0.02, 0.01, 0.03]),
        "elapsed_s": 3.03,
        "intervals_s": pytest.approx([0.99, 1.02]),
        "max_gap_s": pytest.approx(1.02),
        "max_overrun_s": pytest.approx(0.03),
    }


def test_fixed_window_evidence_rejects_under_run() -> None:
    with pytest.raises(ValueError, match="sample count"):
        fixed_window_evidence(
            [{"elapsed_s": 1.0}, {"elapsed_s": 2.0}],
            duration_s=3.0,
            interval_s=1.0,
        )


def test_fixed_window_evidence_rejects_overrun_gap() -> None:
    with pytest.raises(ValueError, match="deadline"):
        fixed_window_evidence(
            [
                {"elapsed_s": 1.0},
                {"elapsed_s": 2.3},
                {"elapsed_s": 3.3},
            ],
            duration_s=3.0,
            interval_s=1.0,
        )


def test_fixed_window_evidence_rejects_zero_sleep_burst() -> None:
    with pytest.raises(ValueError, match="deadline"):
        fixed_window_evidence(
            [
                {"elapsed_s": 1.0},
                {"elapsed_s": 2.0},
                {"elapsed_s": 1.001},
            ],
            duration_s=3.0,
            interval_s=1.0,
        )


def test_fixed_window_evidence_allows_partial_final_interval() -> None:
    evidence = fixed_window_evidence(
        [
            {"elapsed_s": 1.01},
            {"elapsed_s": 2.02},
            {"elapsed_s": 2.52},
        ],
        duration_s=2.5,
        interval_s=1.0,
    )

    assert evidence["expected_deadlines_s"] == [1.0, 2.0, 2.5]
    assert evidence["intervals_s"] == pytest.approx([1.01, 0.5])


class FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._body = json.dumps(payload).encode()

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *args: object) -> None:
        return None


def test_http_json_uses_bounded_timeout_and_injected_opener() -> None:
    calls: list[tuple[str, float]] = []

    def opener(url: str, *, timeout: float) -> FakeResponse:
        calls.append((url, timeout))
        return FakeResponse({"state": "created"})

    assert fetch_json("http://127.0.0.1:8003/record/status", opener=opener) == {
        "state": "created"
    }
    assert calls == [("http://127.0.0.1:8003/record/status", 2.0)]


def test_http_failure_is_explicitly_unavailable() -> None:
    def opener(url: str, *, timeout: float) -> FakeResponse:
        raise TimeoutError(url)

    assert fetch_json("http://127.0.0.1:8001/metrics", opener=opener) == unavailable(
        "endpoint unreachable"
    )
