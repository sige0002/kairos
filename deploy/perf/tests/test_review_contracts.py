"""Regression contracts derived from the independent issue-71 review."""

from __future__ import annotations

import json
import math
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import perf_collect
import pytest
from perf_collect import CollectionError
from perf_harness import (
    aggregate_samples,
    build_manifest,
    comparison_mismatches,
    render_comparison_markdown,
    unavailable,
)


def _scenario(**overrides: object) -> dict[str, Any]:
    scenario: dict[str, Any] = {
        "scenario_name": "streamer-one-client",
        "duration_s": 10.0,
        "warmup_s": 0.0,
        "sample_interval_s": 1.0,
        "services": {
            "monitor": "stopped",
            "streamer": "running",
            "recorder": "stopped",
            "probe": "stopped",
        },
        "monitor_topic_set": "control",
        "camera_count": 1,
        "camera_topics": ["/example/camera"],
        "connected_clients": 1,
        "selected_topics": ["/example/control"],
        "preview_layout": "main-only",
        "preview_caps": {"max_fps": 15},
        "recorder_state": "created",
        "probe_state": "idle",
        "probe_topic": "/example/state",
        "probe_field": "value",
        "robot_motion": "fixed-replay",
        "rmw": "rmw_cyclonedds_cpp",
        "transport_evidence": {"cyclonedds_safe_profile": True},
        "config_hashes": {"recording": "abc"},
        "collection": {"mode": "read-only"},
    }
    scenario.update(overrides)
    return scenario


def _basic_manifest() -> dict[str, Any]:
    return build_manifest(
        scenario_name="normal-collection",
        duration_s=30.0,
        warmup_s=5.0,
        sample_interval_s=1.0,
        camera_count=1,
        selected_topics=["/example/control"],
        preview_layout="main-only",
        preview_caps={"max_fps": 15},
        recorder_state="recording",
        probe_state="active",
        robot_motion="fixed-replay",
        rmw="rmw_cyclonedds_cpp",
        transport_evidence={"cyclonedds_safe_profile": True},
        config_hashes={"recording": "abc"},
        git_sha="abc",
    )


class TestManifestCompleteness:
    def test_builder_preserves_complete_workload_and_host_identity(self) -> None:
        manifest = build_manifest(
            scenario_name="services-stopped",
            duration_s=30.0,
            warmup_s=5.0,
            sample_interval_s=1.0,
            services={
                "monitor": "stopped",
                "streamer": "stopped",
                "recorder": "stopped",
                "probe": "stopped",
            },
            monitor_topic_set="none",
            camera_count=0,
            camera_topics=[],
            connected_clients=0,
            selected_topics=[],
            preview_layout="none",
            preview_caps={"max_fps": None},
            recorder_state="unavailable",
            probe_state="unavailable",
            probe_topic=None,
            probe_field=None,
            robot_motion="fixed-replay",
            rmw="rmw_cyclonedds_cpp",
            transport_evidence={"cyclonedds_safe_profile": True},
            config_hashes={"recording": "abc"},
            git_sha="abc",
            cpu_count=16,
            physical_interfaces=["enp5s0"],
            included_container_services=[],
        )

        assert manifest["workload"]["services"] == {
            "monitor": "stopped",
            "streamer": "stopped",
            "recorder": "stopped",
            "probe": "stopped",
        }
        assert manifest["workload"]["recorder_state"] == "unavailable"
        assert manifest["workload"]["probe_state"] == "unavailable"
        assert manifest["workload"]["monitor_topic_set"] == "none"
        assert manifest["workload"]["camera_topics"] == []
        assert manifest["workload"]["connected_clients"] == 0
        assert manifest["workload"]["probe_topic"] is None
        assert manifest["workload"]["probe_field"] is None
        assert manifest["environment"]["cpu_count"] == 16
        assert manifest["environment"]["physical_interfaces"] == ["enp5s0"]
        assert manifest["environment"]["included_container_services"] == []

    @pytest.mark.parametrize(
        ("path", "changed"),
        [
            ("workload.services", {"monitor": "stopped"}),
            ("workload.monitor_topic_set", "control-plus-bulk"),
            ("workload.camera_topics", ["/example/other-camera"]),
            ("workload.connected_clients", 2),
            ("workload.probe_topic", "/example/other-state"),
            ("workload.probe_field", "velocity"),
            ("environment.cpu_count", 32),
            ("environment.physical_interfaces", ["enp6s0"]),
            ("environment.included_container_services", ["streamer"]),
        ],
    )
    def test_comparison_rejects_untracked_workload_or_host_drift(
        self, path: str, changed: object
    ) -> None:
        baseline = _basic_manifest()
        candidate = json.loads(json.dumps(baseline))
        for manifest in (baseline, candidate):
            manifest["workload"].update(
                {
                    "services": {"monitor": "running"},
                    "monitor_topic_set": "control",
                    "camera_topics": ["/example/camera"],
                    "connected_clients": 1,
                    "probe_topic": "/example/state",
                    "probe_field": "value",
                }
            )
            manifest["environment"].update(
                {
                    "cpu_count": 16,
                    "physical_interfaces": ["enp5s0"],
                    "included_container_services": ["monitor"],
                }
            )
        parent, key = path.rsplit(".", 1)
        candidate[parent][key] = changed

        assert path in comparison_mismatches(baseline, candidate)


def _patch_collection_runtime(
    monkeypatch: pytest.MonkeyPatch,
    *,
    interfaces: set[str] | None = None,
    multicast: dict[str, Any] | None = None,
) -> None:
    class FakeCollector:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def collect(self) -> dict[str, Any]:
            return {"host": {"cpu_busy_pct_machine": 10.0}}

    usage = SimpleNamespace(ru_utime=0.0, ru_stime=0.0, ru_maxrss=1)
    monkeypatch.setattr(perf_collect, "_container_inventory", lambda _: ([], []))
    if interfaces is not None:
        monkeypatch.setattr(perf_collect, "_physical_interfaces", lambda _: interfaces)
    monkeypatch.setattr(
        perf_collect,
        "_git_identity",
        lambda _: {
            "sha": "abc",
            "dirty": False,
            "workspace_fingerprint": "0" * 64,
            "untracked_count": 0,
        },
    )
    monkeypatch.setattr(perf_collect, "LiveCollector", FakeCollector)
    monkeypatch.setattr(
        perf_collect,
        "collect_fixed_window",
        lambda **kwargs: [
            {
                **kwargs["collect"](),
                "elapsed_s": min(
                    (index + 1) * kwargs["interval_s"], kwargs["duration_s"]
                ),
            }
            for index in range(math.ceil(kwargs["duration_s"] / kwargs["interval_s"]))
        ],
    )
    monkeypatch.setattr(
        perf_collect,
        "_capture_tcpdump",
        lambda *args: multicast or unavailable("tcpdump disabled"),
    )
    monkeypatch.setattr(perf_collect.resource, "getrusage", lambda _: usage)
    monkeypatch.setattr(perf_collect.time, "monotonic", lambda: 1.0)


class TestRuntimeManifestEvidence:
    def test_enabled_tcpdump_identity_and_filter_are_recorded(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _patch_collection_runtime(
            monkeypatch,
            interfaces={"enp5s0"},
            multicast={"status": "available", "packet_count": 0},
        )
        scenario = _scenario(
            collection={
                "mode": "read-only",
                "tcpdump": {
                    "interface": "enp5s0",
                    "multicast_host": "239.255.0.1",
                    "port": 7651,
                },
            }
        )

        result = perf_collect.collect_scenario(
            scenario, root=tmp_path, tcpdump_enabled=True
        )

        assert result["manifest"]["environment"]["tcpdump"] == {
            "enabled": True,
            "interface": "enp5s0",
            "group": "239.255.0.1",
            "port": 7651,
            "filter": "udp and dst host 239.255.0.1 and dst port 7651",
            "status": {"status": "available", "packet_count": 0},
        }

    def test_disabled_tcpdump_is_explicitly_unavailable_in_manifest(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _patch_collection_runtime(monkeypatch, interfaces={"enp5s0"})

        result = perf_collect.collect_scenario(
            _scenario(), root=tmp_path, tcpdump_enabled=False
        )

        evidence = result["manifest"]["environment"]["tcpdump"]
        assert evidence["enabled"] is False
        assert evidence["status"] == unavailable("tcpdump disabled")


class TestAggregationAndReportCoverage:
    def test_list_valued_streams_aggregate_numeric_leaves(self) -> None:
        samples = [
            {
                "services": {
                    "streamer": {
                        "streams": [
                            {
                                "received_fps": received,
                                "decoded_fps": received / 2,
                                "client_count": 1,
                                "resolution": {"width": 640, "height": 480},
                            }
                        ]
                    }
                }
            }
            for received in (20.0, 30.0)
        ]

        summary = aggregate_samples(samples, warmup_samples=0)["summary"]

        assert summary["services.streamer.streams.0.received_fps"]["mean"] == 25.0
        assert summary["services.streamer.streams.0.resolution.width"]["mean"] == 640

    def test_markdown_includes_remaining_required_evidence(self) -> None:
        manifest = {"scenario": {"name": "full"}}
        baseline = {
            "manifest": manifest,
            "summary": {
                "host.load1": {"mean": 1.0},
                "processes.streamer.pct_per_core": {"mean": 20.0},
                "services.monitor.topic_rates_hz./example/control": {"mean": 25.0},
                "services.monitor.topic_bandwidth_bps./example/control": {
                    "mean": 4096.0
                },
                "services.streamer.streams.0.received_fps": {"mean": 30.0},
                "services.streamer.streams.0.decoded_fps": {"mean": 15.0},
                "services.streamer.streams.0.output_fps": {"mean": 14.0},
                "services.streamer.streams.0.client_count": {"mean": 1.0},
                "services.streamer.streams.0.resolution.width": {"mean": 640.0},
                "services.streamer.streams.0.resolution.height": {"mean": 480.0},
                "services.recorder.bytes": {"mean": 10000.0},
                "services.recorder.state": {"value": "recording"},
                "services.recorder.integrity": {"value": "ok"},
                "services.recorder.post_stop_validation": {"value": "pass"},
            },
            "observer_overhead": {"self_user_cpu_s": 0.02},
        }
        candidate = json.loads(json.dumps(baseline))
        candidate["summary"]["host.load1"]["mean"] = 0.8
        candidate["observer_overhead"]["self_user_cpu_s"] = 0.01

        report = render_comparison_markdown(baseline, candidate)

        for expected in (
            "Load average (1m)",
            "Process CPU streamer",
            "/example/control rate",
            "/example/control bandwidth",
            "Streamer 0 received FPS",
            "Streamer 0 decoded FPS",
            "Streamer 0 output FPS",
            "Streamer 0 clients",
            "Streamer 0 resolution",
            "Recorder bytes",
            "Recorder state",
            "recording",
            "Recorder integrity",
            "Recorder post-stop validation",
            "Observer self CPU",
        ):
            assert expected in report


class TestSampleDefaultsAndUrls:
    def test_committed_sample_autodetects_nics_and_marks_no_config_hashes(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        sample_path = (
            Path(__file__).parents[1] / "scenarios/replay-monitor-control.json"
        )
        scenario = json.loads(sample_path.read_text(encoding="utf-8"))
        collection = scenario["collection"]
        assert "physical_interfaces" not in collection

        class FakeInterface:
            name = "enp5s0"

            def __truediv__(self, child: str) -> FakeInterface:
                return self

            def exists(self) -> bool:
                return True

        class FakeNetRoot:
            def iterdir(self) -> list[FakeInterface]:
                return [FakeInterface()]

        monkeypatch.setattr(perf_collect, "Path", lambda _: FakeNetRoot())
        assert perf_collect._physical_interfaces(collection) == {"enp5s0"}
        assert perf_collect._config_hashes(scenario, tmp_path) == unavailable(
            "no config files configured"
        )

    @pytest.mark.parametrize(
        "url",
        [
            "http://localhost:8001@evil.example/metrics",
            "http://example.com:8001/metrics",
            "http://localhost:8001/metrics#fragment",
            "https://localhost:8001/metrics",
            "http://localhost/metrics",
        ],
    )
    def test_service_url_rejects_ambiguous_or_nonlocal_targets(self, url: str) -> None:
        with pytest.raises(CollectionError):
            perf_collect._service_urls({"service_urls": {"monitor": url}})

    @pytest.mark.parametrize(
        "url",
        [
            "http://localhost:8001/metrics",
            "http://127.0.0.1:8001/metrics",
        ],
    )
    def test_service_url_accepts_local_http_with_explicit_port(self, url: str) -> None:
        assert perf_collect._service_urls({"service_urls": {"monitor": url}}) == {
            "monitor": url
        }
