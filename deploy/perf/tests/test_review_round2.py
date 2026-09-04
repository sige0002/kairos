"""Comparison-axis and runnable-sample contracts from review round two."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from perf_harness import build_manifest, comparison_mismatches, unavailable


def _manifest() -> dict[str, Any]:
    return build_manifest(
        scenario_name="controlled-comparison",
        duration_s=30.0,
        warmup_s=5.0,
        sample_interval_s=1.0,
        services={"monitor": "running", "streamer": "stopped"},
        monitor_topic_set="control",
        camera_count=0,
        camera_topics=[],
        connected_clients=0,
        selected_topics=["/example/control"],
        preview_layout="none",
        preview_caps={"max_fps": None},
        recorder_state="created",
        probe_state="idle",
        probe_topic=None,
        probe_field=None,
        robot_motion="fixed-replay",
        rmw="rmw_cyclonedds_cpp",
        transport_evidence={"transport_proof": "recorded"},
        config_hashes={"recording": "abc"},
        git_sha="abc",
        cpu_count=16,
        physical_interfaces=["enp5s0"],
        included_container_services=["monitor"],
    )


def _tcpdump(
    *,
    enabled: bool = True,
    interface: str = "enp5s0",
    group: str = "239.255.0.1",
    port: int = 7651,
    packet_count: int = 0,
) -> dict[str, Any]:
    return {
        "enabled": enabled,
        "interface": interface,
        "group": group,
        "port": port,
        "filter": f"udp and dst host {group} and dst port {port}",
        "status": {"status": "available", "packet_count": packet_count},
    }


class TestDerivedComparisonIdentity:
    def test_services_axis_allows_only_services_and_derived_container_set(self) -> None:
        baseline = _manifest()
        candidate = _manifest()
        for manifest in (baseline, candidate):
            manifest["comparison"] = {"allowed_axes": ["workload.services"]}
        candidate["workload"]["services"] = {
            "monitor": "stopped",
            "streamer": "running",
        }
        candidate["environment"]["included_container_services"] = ["streamer"]

        assert comparison_mismatches(baseline, candidate) == []

        candidate["workload"]["camera_count"] = 1
        candidate["scenario"]["name"] = "different-scenario"
        mismatches = comparison_mismatches(baseline, candidate)
        assert "workload.camera_count" in mismatches
        assert "scenario.name" in mismatches

    def test_services_axis_allows_derived_runtime_rmw_start_stop_change(self) -> None:
        baseline = _manifest()
        candidate = _manifest()
        for manifest in (baseline, candidate):
            manifest["comparison"] = {"allowed_axes": ["workload.services"]}
        baseline["environment"]["runtime_rmw"] = {"monitor": "rmw_cyclonedds_cpp"}
        candidate["workload"]["services"] = {
            "monitor": "stopped",
            "streamer": "stopped",
        }
        candidate["environment"]["included_container_services"] = []
        candidate["environment"]["runtime_rmw"] = {}

        assert comparison_mismatches(baseline, candidate) == []

    def test_rmw_axis_allows_derived_runtime_rmw_but_not_tcpdump_drift(self) -> None:
        baseline = _manifest()
        candidate = _manifest()
        for manifest in (baseline, candidate):
            manifest["comparison"] = {"allowed_axes": ["environment.rmw"]}
            manifest["environment"]["tcpdump"] = _tcpdump()
        baseline["environment"]["runtime_rmw"] = {"monitor": "rmw_cyclonedds_cpp"}
        candidate["environment"]["rmw"] = "rmw_fastrtps_cpp"
        candidate["environment"]["runtime_rmw"] = {"monitor": "rmw_fastrtps_cpp"}

        assert comparison_mismatches(baseline, candidate) == []

        candidate["environment"]["tcpdump"]["port"] = 7652
        assert "environment.tcpdump.port" in comparison_mismatches(baseline, candidate)

    def test_undeclared_runtime_rmw_drift_is_rejected(self) -> None:
        baseline = _manifest()
        candidate = _manifest()
        baseline["environment"]["runtime_rmw"] = {"monitor": "rmw_cyclonedds_cpp"}
        candidate["environment"]["runtime_rmw"] = {"monitor": "rmw_fastrtps_cpp"}

        assert "environment.runtime_rmw" in comparison_mismatches(baseline, candidate)

    @pytest.mark.parametrize(
        ("bad_side", "runtime_rmw"),
        [
            ("baseline", {"monitor": "rmw_fastrtps_cpp"}),
            ("candidate", {"monitor": "rmw_cyclonedds_cpp"}),
            (
                "baseline",
                {
                    "monitor": "rmw_cyclonedds_cpp",
                    "streamer": "rmw_fastrtps_cpp",
                },
            ),
            (
                "candidate",
                {
                    "monitor": "rmw_fastrtps_cpp",
                    "streamer": "rmw_cyclonedds_cpp",
                },
            ),
        ],
    )
    def test_rmw_axis_never_hides_manifest_internal_runtime_mismatch(
        self, bad_side: str, runtime_rmw: dict[str, str]
    ) -> None:
        baseline = _manifest()
        candidate = _manifest()
        for manifest in (baseline, candidate):
            manifest["comparison"] = {"allowed_axes": ["environment.rmw"]}
        baseline["environment"]["runtime_rmw"] = {"monitor": "rmw_cyclonedds_cpp"}
        candidate["environment"]["rmw"] = "rmw_fastrtps_cpp"
        candidate["environment"]["runtime_rmw"] = {"monitor": "rmw_fastrtps_cpp"}
        target = baseline if bad_side == "baseline" else candidate
        target["environment"]["runtime_rmw"] = runtime_rmw

        mismatches = comparison_mismatches(baseline, candidate)

        assert any("runtime_rmw" in path for path in mismatches)

    def test_unavailable_runtime_rmw_does_not_fabricate_mismatch(self) -> None:
        baseline = _manifest()
        candidate = _manifest()
        for manifest in (baseline, candidate):
            manifest["comparison"] = {"allowed_axes": ["environment.rmw"]}
            manifest["environment"]["runtime_rmw"] = {
                "monitor": unavailable("variable absent")
            }
        candidate["environment"]["rmw"] = "rmw_fastrtps_cpp"

        assert comparison_mismatches(baseline, candidate) == []

    def test_empty_runtime_rmw_map_is_valid_when_services_are_stopped(self) -> None:
        baseline = _manifest()
        candidate = _manifest()
        for manifest in (baseline, candidate):
            manifest["workload"]["services"] = {
                "monitor": "stopped",
                "streamer": "stopped",
            }
            manifest["environment"]["included_container_services"] = []
            manifest["environment"]["runtime_rmw"] = {}

        assert comparison_mismatches(baseline, candidate) == []


class TestTcpdumpComparisonIdentity:
    def test_measured_outcome_may_differ_when_configuration_is_identical(self) -> None:
        baseline = _manifest()
        candidate = _manifest()
        baseline["environment"]["tcpdump"] = _tcpdump(packet_count=9)
        candidate["environment"]["tcpdump"] = _tcpdump(packet_count=0)

        assert comparison_mismatches(baseline, candidate) == []

    def test_each_tcpdump_configuration_difference_is_rejected(self) -> None:
        replacements: dict[str, Any] = {
            "enabled": False,
            "interface": "enp6s0",
            "group": "239.255.0.2",
            "port": 7652,
            "filter": "udp and dst host 239.255.0.2 and dst port 7652",
        }
        for field, replacement in replacements.items():
            baseline = _manifest()
            candidate = _manifest()
            baseline["environment"]["tcpdump"] = _tcpdump()
            candidate["environment"]["tcpdump"] = _tcpdump()
            candidate["environment"]["tcpdump"][field] = replacement

            assert f"environment.tcpdump.{field}" in comparison_mismatches(
                baseline, candidate
            )


def test_committed_runnable_sample_has_complete_workload_identity() -> None:
    sample_path = Path(__file__).parents[1] / "scenarios/replay-monitor-control.json"
    sample = json.loads(sample_path.read_text(encoding="utf-8"))

    for field in (
        "services",
        "monitor_topic_set",
        "camera_topics",
        "connected_clients",
        "probe_topic",
        "probe_field",
    ):
        assert field in sample
