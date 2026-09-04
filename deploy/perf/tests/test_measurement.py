"""Pure parsing and aggregation contracts for repeatable load measurements."""

from __future__ import annotations

import pytest
from perf_harness import (
    aggregate_samples,
    cpu_delta,
    network_delta,
    normalize_container_cpu,
    parse_net_dev,
    parse_proc_stat,
)


def _sample(cpu: float, rx: int, *, unavailable_metric: object = None) -> dict:
    return {
        "host": {"cpu_busy_pct_machine": cpu},
        "network": {"eth0": {"rx_bytes": rx}},
        "optional": unavailable_metric,
    }


class TestCpuMeasurement:
    def test_parse_and_delta_use_machine_and_core_denominators(self) -> None:
        before = parse_proc_stat("cpu  100 20 30 850 10 5 5 0 0 0\n")
        after = parse_proc_stat("cpu  140 30 40 910 20 10 10 0 0 0\n")

        result = cpu_delta(before, after, cpu_count=8)

        # Busy delta = 70, total delta = 140. Host busy is a whole-machine
        # percentage and core equivalents make its denominator unmistakable.
        assert result == {
            "busy_ticks": 70,
            "total_ticks": 140,
            "busy_pct_machine": 50.0,
            "busy_core_equivalents": 4.0,
            "cpu_count": 8,
        }

    def test_container_cpu_keeps_docker_per_core_and_machine_values(self) -> None:
        assert normalize_container_cpu(240.0, cpu_count=16) == {
            "pct_per_core": 240.0,
            "pct_machine": 15.0,
            "cores_used": 2.4,
            "cpu_count": 16,
        }

    @pytest.mark.parametrize("cpu_count", [0, -1])
    def test_cpu_count_must_be_positive(self, cpu_count: int) -> None:
        with pytest.raises(ValueError, match="cpu_count"):
            normalize_container_cpu(10.0, cpu_count=cpu_count)


class TestNetworkMeasurement:
    def test_physical_and_loopback_deltas_are_both_retained(self) -> None:
        before = parse_net_dev(
            """
  eth0: 1000 10 0 0 0 0 0 2 2000 20 0 0 0 0 0 0
    lo: 5000 50 0 0 0 0 0 0 6000 60 0 0 0 0 0 0
"""
        )
        after = parse_net_dev(
            """
  eth0: 1300 13 0 0 0 0 0 4 2600 26 0 0 0 0 0 0
    lo: 5900 59 0 0 0 0 0 0 7200 72 0 0 0 0 0 0
"""
        )

        assert network_delta(before, after, physical_interfaces={"eth0"}) == {
            "eth0": {
                "kind": "physical",
                "rx_bytes": 300,
                "tx_bytes": 600,
                "rx_packets": 3,
                "tx_packets": 6,
                "rx_multicast_packets": 2,
            },
            "lo": {
                "kind": "loopback",
                "rx_bytes": 900,
                "tx_bytes": 1200,
                "rx_packets": 9,
                "tx_packets": 12,
                "rx_multicast_packets": 0,
            },
        }


class TestAggregation:
    def test_warmup_is_excluded_from_summary_but_all_raw_samples_remain(self) -> None:
        samples = [_sample(90.0, 100), _sample(20.0, 200), _sample(40.0, 500)]

        result = aggregate_samples(samples, warmup_samples=1)

        assert result["raw_samples"] == samples
        assert result["warmup_samples"] == 1
        assert result["measurement_sample_count"] == 2
        assert result["summary"]["host.cpu_busy_pct_machine"] == {
            "count": 2,
            "min": 20.0,
            "mean": 30.0,
            "max": 40.0,
        }
        assert result["summary"]["network.eth0.rx_bytes"]["mean"] == 350.0

    def test_unavailable_values_are_counted_not_treated_as_zero(self) -> None:
        missing = {"status": "unavailable", "reason": "endpoint unreachable"}
        samples = [_sample(10.0, 1, unavailable_metric=missing) for _ in range(2)]

        result = aggregate_samples(samples, warmup_samples=0)

        assert result["summary"]["optional"] == {
            "status": "unavailable",
            "reason": "endpoint unreachable",
            "count": 2,
        }

    def test_rejects_warmup_that_leaves_no_measurement_samples(self) -> None:
        with pytest.raises(ValueError, match="warmup"):
            aggregate_samples([_sample(1.0, 1)], warmup_samples=1)
