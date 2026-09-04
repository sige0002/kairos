"""Bounded optional probes and durable report-output contracts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from perf_harness import (
    capture_multicast_packets,
    render_comparison_markdown,
    write_json_result,
)


class FakeRunner:
    def __init__(self, *, stdout: str = "") -> None:
        self.stdout = stdout
        self.calls: list[tuple[list[str], float]] = []

    def __call__(self, argv: list[str], *, timeout: float) -> Any:
        self.calls.append((argv, timeout))
        return type("Completed", (), {"returncode": 0, "stdout": self.stdout})()


class TestMulticastCapture:
    def test_disabled_capture_does_not_start_tcpdump(self) -> None:
        runner = FakeRunner()

        result = capture_multicast_packets(enabled=False, duration_s=5.0, run=runner)

        assert result == {"status": "unavailable", "reason": "tcpdump disabled"}
        assert runner.calls == []

    def test_capture_is_bounded_and_uses_issue_69_user_data_filter(self) -> None:
        runner = FakeRunner(stdout="7 packets captured\n")

        result = capture_multicast_packets(
            enabled=True,
            duration_s=5.0,
            interface="eth0",
            multicast_host="239.255.0.1",
            port=7651,
            run=runner,
        )

        argv, timeout = runner.calls[0]
        assert argv[0] == "tcpdump"
        assert argv[argv.index("-i") + 1] == "eth0"
        assert "udp and dst host 239.255.0.1 and dst port 7651" in argv
        assert timeout <= 7.0
        assert result == {"status": "available", "packet_count": 7}

    def test_missing_tcpdump_is_explicitly_unavailable(self) -> None:
        def missing_runner(argv: list[str], *, timeout: float) -> Any:
            raise FileNotFoundError(argv[0])

        assert capture_multicast_packets(
            enabled=True,
            duration_s=1.0,
            interface="eth0",
            multicast_host="239.255.0.1",
            port=7651,
            run=missing_runner,
        ) == {"status": "unavailable", "reason": "tcpdump not installed"}


class TestOutput:
    def test_json_output_round_trips_raw_samples_and_manifest(
        self, tmp_path: Path
    ) -> None:
        result = {
            "manifest": {"schema_version": 1, "environment": {"git_sha": "abc"}},
            "raw_samples": [{"host": {"cpu_busy_pct_machine": 12.5}}],
            "summary": {"host.cpu_busy_pct_machine": {"mean": 12.5}},
        }
        output = tmp_path / "result.json"

        write_json_result(result, output)

        assert json.loads(output.read_text(encoding="utf-8")) == result

    def test_markdown_has_before_after_deltas_and_denominators(self) -> None:
        baseline = {
            "manifest": {"scenario": {"name": "monitor-control"}},
            "summary": {
                "host.cpu_busy_pct_machine": {"mean": 40.0},
                "containers.monitor.pct_per_core": {"mean": 160.0},
                "containers.monitor.pct_machine": {"mean": 10.0},
                "network.eth0.rx_bytes_per_s": {"mean": 1000.0},
                "multicast.packet_count": {
                    "status": "unavailable",
                    "reason": "tcpdump disabled",
                    "count": 1,
                },
            },
        }
        candidate = {
            "manifest": {"scenario": {"name": "monitor-control"}},
            "summary": {
                "host.cpu_busy_pct_machine": {"mean": 30.0},
                "containers.monitor.pct_per_core": {"mean": 80.0},
                "containers.monitor.pct_machine": {"mean": 5.0},
                "network.eth0.rx_bytes_per_s": {"mean": 750.0},
                "multicast.packet_count": {
                    "status": "unavailable",
                    "reason": "tcpdump disabled",
                    "count": 1,
                },
            },
        }

        report = render_comparison_markdown(baseline, candidate)

        assert "monitor-control" in report
        assert "Whole-machine CPU" in report
        assert "40.00%" in report
        assert "30.00%" in report
        assert "-10.00 percentage points" in report
        assert "Container CPU (% of one core)" in report
        assert "Container CPU (% of machine)" in report
        assert "unavailable (tcpdump disabled)" in report

    def test_markdown_refuses_incompatible_manifests(self) -> None:
        baseline = {
            "manifest": {
                "scenario": {
                    "name": "same",
                    "duration_s": 30.0,
                    "warmup_s": 5.0,
                    "sample_interval_s": 1.0,
                },
                "workload": {"camera_count": 0},
                "environment": {"rmw": "rmw_cyclonedds_cpp"},
            },
            "summary": {},
        }
        candidate = json.loads(json.dumps(baseline))
        candidate["manifest"]["workload"]["camera_count"] = 4

        report = render_comparison_markdown(baseline, candidate)

        assert "INVALID COMPARISON" in report
        assert "workload.camera_count" in report

    def test_markdown_reports_configured_physical_interface_not_only_eth0(
        self,
    ) -> None:
        manifest = {
            "scenario": {"name": "network", "duration_s": 30.0},
            "environment": {"physical_interfaces": ["enp5s0"]},
        }
        baseline = {
            "manifest": manifest,
            "summary": {"network.enp5s0.rx_bytes_per_s": {"mean": 2048.0}},
        }
        candidate = {
            "manifest": manifest,
            "summary": {"network.enp5s0.rx_bytes_per_s": {"mean": 1024.0}},
        }

        report = render_comparison_markdown(baseline, candidate)

        assert "enp5s0" in report
        assert "2048.00 B/s" in report
        assert "1024.00 B/s" in report

    def test_markdown_reports_cpu_for_streamer_only_result(self) -> None:
        manifest = {"scenario": {"name": "streamer-one-camera"}}
        baseline = {
            "manifest": manifest,
            "summary": {
                "containers.streamer.pct_per_core": {"mean": 120.0},
                "containers.streamer.pct_machine": {"mean": 15.0},
            },
        }
        candidate = {
            "manifest": manifest,
            "summary": {
                "containers.streamer.pct_per_core": {"mean": 80.0},
                "containers.streamer.pct_machine": {"mean": 10.0},
            },
        }

        report = render_comparison_markdown(baseline, candidate)

        assert "Container CPU streamer (% of one core)" in report
        assert "120.00%" in report
        assert "80.00%" in report
        assert "Container CPU streamer (% of machine)" in report

    def test_markdown_reports_physical_and_loopback_rx_and_tx(self) -> None:
        manifest = {
            "scenario": {"name": "network"},
            "environment": {"physical_interfaces": ["enp5s0"]},
        }
        baseline = {
            "manifest": manifest,
            "summary": {
                "network.enp5s0.rx_bytes_per_s": {"mean": 4000.0},
                "network.enp5s0.tx_bytes_per_s": {"mean": 3000.0},
                "network.lo.rx_bytes_per_s": {"mean": 2000.0},
                "network.lo.tx_bytes_per_s": {"mean": 1000.0},
            },
        }
        candidate = {
            "manifest": manifest,
            "summary": {
                "network.enp5s0.rx_bytes_per_s": {"mean": 3500.0},
                "network.enp5s0.tx_bytes_per_s": {"mean": 2500.0},
                "network.lo.rx_bytes_per_s": {"mean": 2800.0},
                "network.lo.tx_bytes_per_s": {"mean": 1800.0},
            },
        }

        report = render_comparison_markdown(baseline, candidate)

        assert "Physical RX (enp5s0)" in report
        assert "Physical TX (enp5s0)" in report
        assert "Loopback RX (lo)" in report
        assert "Loopback TX (lo)" in report

    def test_markdown_includes_monitor_and_recorder_evidence(self) -> None:
        manifest = {"scenario": {"name": "normal-collection"}}
        baseline = {
            "manifest": manifest,
            "summary": {
                "services.monitor.callback_lag_ms": {"mean": 0.0023},
                "services.recorder.message_count": {"mean": 1000.0},
                "services.recorder.dropped_messages": {"mean": 3.0},
            },
        }
        candidate = {
            "manifest": manifest,
            "summary": {
                "services.monitor.callback_lag_ms": {"mean": 0.0017},
                "services.recorder.message_count": {"mean": 1100.0},
                "services.recorder.dropped_messages": {"mean": 0.0},
            },
        }

        report = render_comparison_markdown(baseline, candidate)

        assert "Monitor callback lag" in report
        assert "0.0023 ms" in report
        assert "0.0017 ms" in report
        assert "-0.0006 ms" in report
        assert "Recorder messages" in report
        assert "1000.00" in report
        assert "1100.00" in report
        assert "Recorder dropped messages" in report
