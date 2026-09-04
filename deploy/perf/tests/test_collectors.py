"""Deterministic clock and HTTP boundaries used by the live harness."""

from __future__ import annotations

import json
from typing import Any

from perf_harness import collect_fixed_window, fetch_json, unavailable


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
        {"sequence": 1, "elapsed_s": 0.0},
        {"sequence": 2, "elapsed_s": 1.0},
        {"sequence": 3, "elapsed_s": 2.0},
    ]
    assert clock.sleeps == [1.0, 1.0, 1.0]


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
