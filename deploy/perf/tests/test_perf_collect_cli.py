"""Adversarial contracts for the read-only performance collector CLI."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import perf_collect
import pytest
from perf_collect import CollectionError, LiveCollector
from perf_harness import parse_proc_stat, unavailable


def _scenario(**overrides: object) -> dict[str, Any]:
    result: dict[str, Any] = {
        "scenario_name": "monitor-control",
        "duration_s": 30.0,
        "warmup_s": 5.0,
        "sample_interval_s": 1.0,
        "camera_count": 0,
        "selected_topics": ["/example/control"],
        "preview_layout": "none",
        "preview_caps": {"max_fps": None},
        "recorder_state": "created",
        "probe_state": "idle",
        "robot_motion": "stationary",
        "rmw": "rmw_cyclonedds_cpp",
        "transport_evidence": {"cyclonedds_safe_profile": True},
        "config_hashes": {"recording": "abc"},
    }
    result.update(overrides)
    return result


class TestLiveCollectorOrdering:
    def test_process_cpu_delta_uses_prior_not_just_stored_snapshot(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        collector = object.__new__(LiveCollector)
        collector.containers = [{"sample_key": "monitor", "pid": 123}]
        collector.physical_interfaces = {"eth0"}
        collector.service_urls = {}
        collector.http_timeout_s = 0.1
        collector.cpu_count = 4
        collector.clock_ticks = 100
        collector.previous = {
            "monotonic": 10.0,
            "host_cpu": parse_proc_stat("cpu 100 0 0 900 0 0 0 0\n"),
            "network": {},
            "containers": {"monitor": {"process_ticks": 100}},
        }
        current = {
            "monotonic": 11.0,
            "host_cpu": parse_proc_stat("cpu 150 0 0 950 0 0 0 0\n"),
            "network": {},
            "containers": {"monitor": {"process_ticks": 150}},
        }
        monkeypatch.setattr(perf_collect, "_counter_snapshot", lambda _: current)
        monkeypatch.setattr(perf_collect.os, "getloadavg", lambda: (1.0, 2.0, 3.0))
        monkeypatch.setattr(
            perf_collect, "_read_process_gauges", lambda _: {"rss_bytes": 1024}
        )
        monkeypatch.setattr(collector, "_network", lambda *_: {})
        monkeypatch.setattr(collector, "_containers", lambda *_: {"monitor": {}})
        monkeypatch.setattr(collector, "_services", lambda: {})

        sample = collector.collect()

        assert sample["processes"]["monitor"]["pct_per_core"] == 50.0
        assert sample["processes"]["monitor"]["pct_machine"] == 12.5
        assert collector.previous is current


class TestTcpdumpBoundary:
    def test_collector_uses_harness_sigint_runner_not_subprocess_timeout(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured: dict[str, Any] = {}

        def fake_capture(**kwargs: Any) -> dict[str, Any]:
            captured.update(kwargs)
            return {"status": "available", "packet_count": 0}

        monkeypatch.setattr(perf_collect, "capture_multicast_packets", fake_capture)

        result = perf_collect._capture_tcpdump(
            True,
            5.0,
            {
                "tcpdump": {
                    "interface": "eth0",
                    "multicast_host": "239.255.0.1",
                    "port": 7651,
                }
            },
        )

        assert result["packet_count"] == 0
        # Omitting `run` selects perf_harness's Popen/SIGINT implementation,
        # which allows tcpdump to emit its final packet summary.
        assert "run" not in captured


class TestScenarioValidation:
    @pytest.mark.parametrize(
        "values",
        [
            {"duration_s": 0},
            {"duration_s": float("nan")},
            {"sample_interval_s": 0},
            {"warmup_s": -1},
            {"warmup_s": 30},
            {"duration_s": 1, "warmup_s": 0.1, "sample_interval_s": 1},
        ],
    )
    def test_invalid_timing_fails_before_any_runtime_probe(
        self, values: dict[str, object]
    ) -> None:
        with pytest.raises(CollectionError):
            perf_collect._validate_timing(_scenario(**values))

    @pytest.mark.parametrize("field", ["scenario_name", "rmw", "robot_motion"])
    def test_identity_fields_must_not_be_empty(
        self, field: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setattr(
            perf_collect,
            "_git_identity",
            lambda _: {"sha": "abc", "dirty": False, "dirty_hash": None},
        )
        monkeypatch.setattr(
            perf_collect, "_config_hashes", lambda *_: {"recording": "abc"}
        )

        with pytest.raises(CollectionError, match=field):
            perf_collect._build_runtime_manifest(
                _scenario(**{field: ""}),
                duration_s=30.0,
                warmup_s=5.0,
                interval_s=1.0,
                containers=[],
                excluded=[],
                interfaces={"eth0"},
                root=tmp_path,
                collection={},
            )


class TestContainerSelection:
    def test_include_and_exclude_apply_to_compose_service_or_name(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        rows = [
            {"ID": "aaa", "Names": "kairos-monitor-1"},
            {"ID": "bbb", "Names": "kairos-recorder-1"},
            {"ID": "ccc", "Names": "unrelated"},
        ]

        def fake_run(*args: object, **kwargs: object) -> subprocess.CompletedProcess:
            return subprocess.CompletedProcess(
                args, 0, stdout="\n".join(json.dumps(row) for row in rows)
            )

        inspected = [
            {
                "Id": "a" * 64,
                "Name": "/kairos-monitor-1",
                "Config": {
                    "Labels": {"com.docker.compose.service": "monitor"},
                    "Image": "kairos-monitor:test",
                    "Env": [],
                },
                "State": {"Pid": 101},
            },
            {
                "Id": "b" * 64,
                "Name": "/kairos-recorder-1",
                "Config": {
                    "Labels": {"com.docker.compose.service": "recorder"},
                    "Image": "kairos-recorder:test",
                    "Env": [],
                },
                "State": {"Pid": 102},
            },
        ]
        monkeypatch.setattr(perf_collect.subprocess, "run", fake_run)
        monkeypatch.setattr(perf_collect, "_run_json", lambda _: inspected)
        monkeypatch.setattr(
            perf_collect, "_cgroup_path", lambda pid: Path(f"/cgroup/{pid}")
        )

        included, excluded = perf_collect._container_inventory(
            {
                "include_containers": ["monitor", "kairos-recorder-1"],
                "exclude_containers": ["recorder"],
            }
        )

        assert [item["service"] for item in included] == ["monitor"]
        assert [item["service"] for item in excluded] == ["recorder"]

    def test_filter_selecting_no_running_container_supports_host_only_scenario(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        row = json.dumps({"ID": "aaa", "Names": "kairos-monitor-1"})
        monkeypatch.setattr(
            perf_collect.subprocess,
            "run",
            lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, stdout=row),
        )
        monkeypatch.setattr(
            perf_collect,
            "_run_json",
            lambda _: [
                {
                    "Id": "a" * 64,
                    "Name": "/kairos-monitor-1",
                    "Config": {
                        "Labels": {"com.docker.compose.service": "monitor"},
                        "Image": "image",
                    },
                    "State": {"Pid": 101},
                }
            ],
        )
        monkeypatch.setattr(perf_collect, "_cgroup_path", lambda _: Path("/cgroup"))

        included, excluded = perf_collect._container_inventory(
            {"include_containers": ["streamer"]}
        )

        assert included == []
        assert [item["service"] for item in excluded] == ["monitor"]

    def test_no_kairos_candidates_supports_all_services_stopped(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        unrelated = json.dumps({"ID": "aaa", "Names": "database-1"})
        monkeypatch.setattr(
            perf_collect.subprocess,
            "run",
            lambda *args, **kwargs: subprocess.CompletedProcess(
                args, 0, stdout=unrelated
            ),
        )
        inspect_called = False

        def should_not_inspect(argv: object) -> list:
            nonlocal inspect_called
            inspect_called = True
            return []

        monkeypatch.setattr(perf_collect, "_run_json", should_not_inspect)

        assert perf_collect._container_inventory({}) == ([], [])
        assert inspect_called is False


class TestHostOnlyCollection:
    def test_counter_snapshot_accepts_empty_container_list(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        contents = {
            "/proc/stat": "cpu 100 0 0 900 0 0 0 0\n",
            "/proc/net/dev": "lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n",
        }

        class FakePath:
            def __init__(self, raw: str) -> None:
                self.raw = raw

            def read_text(self, *, encoding: str) -> str:
                return contents[self.raw]

        monkeypatch.setattr(perf_collect, "Path", FakePath)
        monkeypatch.setattr(perf_collect.time, "monotonic", lambda: 10.0)

        snapshot = perf_collect._counter_snapshot([])

        assert snapshot["monotonic"] == 10.0
        assert snapshot["containers"] == {}
        assert snapshot["host_cpu"]["total_ticks"] == 1000

    def test_live_collector_reports_empty_container_and_process_maps(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        snapshots = iter(
            [
                {
                    "monotonic": 10.0,
                    "host_cpu": parse_proc_stat("cpu 100 0 0 900 0 0 0 0\n"),
                    "network": {},
                    "containers": {},
                },
                {
                    "monotonic": 11.0,
                    "host_cpu": parse_proc_stat("cpu 110 0 0 990 0 0 0 0\n"),
                    "network": {},
                    "containers": {},
                },
            ]
        )
        monkeypatch.setattr(
            perf_collect, "_counter_snapshot", lambda _: next(snapshots)
        )
        monkeypatch.setattr(perf_collect.os, "getloadavg", lambda: (0.1, 0.2, 0.3))
        monkeypatch.setattr(LiveCollector, "_services", lambda _: {})
        collector = LiveCollector(
            [], physical_interfaces=set(), service_urls={}, http_timeout_s=0.1
        )

        sample = collector.collect()

        assert sample["containers"] == {}
        assert sample["processes"] == {}
        assert sample["host"]["cpu_busy_pct_machine"] == 10.0


class TestServiceFailures:
    def test_unreachable_services_and_passive_probe_are_all_explicit(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        collector = object.__new__(LiveCollector)
        collector.service_urls = {
            "monitor": "http://localhost:1/metrics",
            "streamer": "http://localhost:2/stream/status",
            "recorder": "http://localhost:3/record/status",
        }
        collector.http_timeout_s = 0.1
        monkeypatch.setattr(
            perf_collect,
            "fetch_json",
            lambda *args, **kwargs: unavailable("endpoint unreachable"),
        )

        services = collector._services()

        assert services["monitor"] == unavailable("endpoint unreachable")
        assert services["streamer"] == unavailable("endpoint unreachable")
        assert services["recorder"] == unavailable("endpoint unreachable")
        assert services["probe"] == unavailable(
            "no passive topic-probe status endpoint"
        )


class TestCollectorCli:
    def test_collect_scenario_has_top_level_result_schema_version(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        class FakeCollector:
            def __init__(self, *args: object, **kwargs: object) -> None:
                pass

            def collect(self) -> dict[str, Any]:
                return {"host": {"cpu_busy_pct_machine": 10.0}}

        usage = SimpleNamespace(ru_utime=0.0, ru_stime=0.0, ru_maxrss=1)
        monkeypatch.setattr(perf_collect, "_container_inventory", lambda _: ([], []))
        monkeypatch.setattr(perf_collect, "_physical_interfaces", lambda _: set())
        monkeypatch.setattr(
            perf_collect,
            "_build_runtime_manifest",
            lambda *args, **kwargs: {"schema_version": 1, "environment": {}},
        )
        monkeypatch.setattr(perf_collect, "LiveCollector", FakeCollector)
        monkeypatch.setattr(
            perf_collect,
            "collect_fixed_window",
            lambda **kwargs: [kwargs["collect"]()],
        )
        monkeypatch.setattr(
            perf_collect, "_capture_tcpdump", lambda *args: unavailable("disabled")
        )
        monkeypatch.setattr(perf_collect.resource, "getrusage", lambda _: usage)
        monkeypatch.setattr(perf_collect.time, "monotonic", lambda: 1.0)

        result = perf_collect.collect_scenario(
            _scenario(duration_s=1.0, warmup_s=0.0),
            root=tmp_path,
            tcpdump_enabled=False,
        )

        assert result["schema_version"] == "kairos.perf.result/v1"

    def test_invalid_scenario_returns_two_without_starting_collection(
        self, tmp_path: Path, capsys: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scenario = tmp_path / "scenario.json"
        scenario.write_text("not-json", encoding="utf-8")
        called = False

        def should_not_collect(*args: object, **kwargs: object) -> dict:
            nonlocal called
            called = True
            return {}

        monkeypatch.setattr(perf_collect, "collect_scenario", should_not_collect)

        code = perf_collect.main(
            ["collect", "--scenario", str(scenario), "--output", str(tmp_path / "x")]
        )

        captured = capsys.readouterr()
        assert code == 2
        assert "perf-collect: invalid scenario JSON" in captured.err
        assert captured.out == ""
        assert called is False

    def test_successful_cli_writes_machine_readable_result(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scenario = tmp_path / "scenario.json"
        output = tmp_path / "result.json"
        scenario.write_text(json.dumps(_scenario()), encoding="utf-8")
        expected = {"manifest": {"schema_version": 1}, "raw_samples": []}
        monkeypatch.setattr(
            perf_collect, "collect_scenario", lambda *args, **kwargs: expected
        )

        code = perf_collect.main(
            ["collect", "--scenario", str(scenario), "--output", str(output)]
        )

        assert code == 0
        assert json.loads(output.read_text(encoding="utf-8")) == expected
