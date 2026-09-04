#!/usr/bin/env python3
"""Collect a bounded, read-only Kairos live-load measurement."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import re
import resource
import subprocess
import sys
import time
import urllib.parse
from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from perf_harness import (
    aggregate_samples,
    build_manifest,
    capture_multicast_packets,
    collect_fixed_window,
    cpu_delta,
    extract_service_metrics,
    fetch_json,
    network_delta,
    normalize_container_cpu,
    parse_net_dev,
    parse_proc_stat,
    sha256_file,
    unavailable,
    write_json_result,
)

_ROS_ENV_ALLOWLIST = (
    "RMW_IMPLEMENTATION",
    "ROS_DISTRO",
    "ROS_DOMAIN_ID",
    "CYCLONEDDS_URI",
    "FASTRTPS_DEFAULT_PROFILES_FILE",
)
_DEFAULT_SERVICE_URLS = {
    "monitor": "http://127.0.0.1:8001/metrics",
    "streamer": "http://127.0.0.1:8002/stream/status",
    "recorder": "http://127.0.0.1:8010/record/status",
}
_CGROUP_COUNTERS = ("rbytes", "wbytes", "rios", "wios", "dbytes", "dios")
_ALLOWED_COMPARISON_AXES = {
    "scenario.duration_s",
    "scenario.warmup_s",
    "scenario.sample_interval_s",
    "workload.camera_count",
    "workload.services",
    "workload.monitor_topic_set",
    "workload.camera_topics",
    "workload.connected_clients",
    "workload.selected_topics",
    "workload.preview_layout",
    "workload.preview_caps",
    "workload.recorder_state",
    "workload.probe_state",
    "workload.probe_topic",
    "workload.probe_field",
    "workload.robot_motion",
    "environment.rmw",
    "environment.transport_evidence",
    "environment.config_hashes",
    "environment.cpu_count",
    "environment.physical_interfaces",
    "environment.included_container_services",
}


class CollectionError(RuntimeError):
    """A user-facing failure to prepare or run a measurement."""


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Collect a bounded, read-only live-load benchmark."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    collect = commands.add_parser("collect", help="collect one named scenario")
    collect.add_argument("--scenario", required=True, type=Path)
    collect.add_argument("--output", required=True, type=Path)
    collect.add_argument(
        "--tcpdump",
        action="store_true",
        help="enable the optional bounded ROS user-data multicast probe",
    )
    return parser


def _load_scenario(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise CollectionError(f"could not read scenario: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise CollectionError(f"invalid scenario JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise CollectionError("scenario must be a JSON object")
    return value


def _number(scenario: Mapping[str, Any], key: str) -> float:
    value = scenario.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CollectionError(f"scenario {key} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise CollectionError(f"scenario {key} must be a finite number")
    return result


def _validate_timing(scenario: Mapping[str, Any]) -> tuple[float, float, float, int]:
    duration_s = _number(scenario, "duration_s")
    warmup_s = _number(scenario, "warmup_s")
    interval_s = _number(scenario, "sample_interval_s")
    if duration_s <= 0 or interval_s <= 0:
        raise CollectionError("duration_s and sample_interval_s must be positive")
    if warmup_s < 0 or warmup_s >= duration_s:
        raise CollectionError("warmup_s must be non-negative and less than duration_s")
    expected_samples = math.ceil(duration_s / interval_s)
    warmup_samples = math.ceil(warmup_s / interval_s)
    if expected_samples - warmup_samples < 1:
        raise CollectionError("timing must leave at least one measurement sample")
    return duration_s, warmup_s, interval_s, warmup_samples


def _run_json(argv: Sequence[str]) -> Any:
    try:
        completed = subprocess.run(
            list(argv),
            check=True,
            capture_output=True,
            text=True,
            timeout=5.0,
        )
        return json.loads(completed.stdout)
    except FileNotFoundError as exc:
        raise CollectionError(f"required command not installed: {argv[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise CollectionError(f"command timed out: {argv[0]}") from exc
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.strip() or "command failed"
        raise CollectionError(f"{argv[0]}: {detail}") from exc
    except json.JSONDecodeError as exc:
        raise CollectionError(f"{argv[0]} returned invalid JSON") from exc


def _container_inventory(
    collection: Mapping[str, Any],
) -> tuple[list[dict], list[dict]]:
    # Docker emits one JSON object per line rather than one JSON array.
    try:
        completed = subprocess.run(
            ["docker", "ps", "--format", "{{json .}}"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5.0,
        )
        rows = [json.loads(line) for line in completed.stdout.splitlines() if line]
    except FileNotFoundError as exc:
        raise CollectionError("required command not installed: docker") from exc
    except subprocess.TimeoutExpired as exc:
        raise CollectionError("docker ps timed out") from exc
    except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        raise CollectionError("could not enumerate Docker containers") from exc

    candidate_ids = [
        str(row["ID"])
        for row in rows
        if re.match(r"^kairos[-_]", str(row.get("Names", "")))
    ]
    if not candidate_ids:
        return [], []
    inspected = _run_json(["docker", "inspect", *candidate_ids])
    if not isinstance(inspected, list):
        raise CollectionError("docker inspect returned an unexpected payload")

    include_value = collection.get("include_containers", collection.get("containers"))
    include = _string_set(include_value, "containers")
    exclude = _string_set(collection.get("exclude_containers"), "exclude_containers")
    found: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for item in inspected:
        if not isinstance(item, Mapping):
            continue
        labels = item.get("Config", {}).get("Labels") or {}
        service = str(labels.get("com.docker.compose.service") or "unknown")
        name = str(item.get("Name", "")).removeprefix("/")
        identity = {
            "id": str(item.get("Id", ""))[:12],
            "name": name,
            "service": service,
            "image": str(item.get("Config", {}).get("Image", "unknown")),
        }
        selected = (not include or service in include or name in include) and not (
            service in exclude or name in exclude
        )
        if not selected:
            skipped.append(identity)
            continue
        pid = item.get("State", {}).get("Pid")
        if not isinstance(pid, int) or pid <= 0:
            skipped.append({**identity, "reason": "container has no running PID"})
            continue
        identity["pid"] = pid
        identity["ros_environment"] = _allowed_environment(item)
        identity["cgroup"] = _cgroup_path(pid)
        found.append(identity)
    duplicate_services = {
        name
        for name, count in Counter(c["service"] for c in found).items()
        if count > 1
    }
    for container in found:
        container["sample_key"] = (
            container["name"]
            if container["service"] in duplicate_services
            else container["service"]
        )
    return found, skipped


def _string_set(value: Any, field: str) -> set[str]:
    if value is None:
        return set()
    if not isinstance(value, list) or not all(
        isinstance(item, str) and item for item in value
    ):
        raise CollectionError(f"collection.{field} must be an array of strings")
    return set(value)


def _allowed_environment(container: Mapping[str, Any]) -> dict[str, Any]:
    raw = container.get("Config", {}).get("Env") or []
    parsed = dict(entry.split("=", 1) for entry in raw if "=" in entry)
    return {
        key: parsed[key] if key in parsed else unavailable("variable absent")
        for key in _ROS_ENV_ALLOWLIST
    }


def _cgroup_path(pid: int) -> Path:
    try:
        lines = Path(f"/proc/{pid}/cgroup").read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise CollectionError(f"could not read cgroup for container PID {pid}") from exc
    entry = next((line for line in lines if line.startswith("0::")), None)
    if entry is None:
        raise CollectionError("cgroup v2 is required for direct collection")
    relative = entry.partition("::")[2].lstrip("/")
    path = (Path("/sys/fs/cgroup") / relative).resolve()
    root = Path("/sys/fs/cgroup").resolve()
    if path == root or not path.is_relative_to(root):
        raise CollectionError("refusing to attribute the host cgroup to a container")
    return path


def _physical_interfaces(collection: Mapping[str, Any]) -> set[str]:
    configured = collection.get("physical_interfaces")
    if configured is not None:
        return _string_set(configured, "physical_interfaces")
    root = Path("/sys/class/net")
    try:
        return {path.name for path in root.iterdir() if (path / "device").exists()}
    except OSError:
        return set()


def _read_int(path: Path) -> int:
    return int(path.read_text(encoding="utf-8").strip())


def _read_cpu_usage(path: Path) -> int:
    fields = dict(
        line.split(maxsplit=1)
        for line in (path / "cpu.stat").read_text(encoding="utf-8").splitlines()
    )
    return int(fields["usage_usec"])


def _read_io(path: Path) -> dict[str, int]:
    totals = {field: 0 for field in _CGROUP_COUNTERS}
    for line in (path / "io.stat").read_text(encoding="utf-8").splitlines():
        for entry in line.split()[1:]:
            key, _, value = entry.partition("=")
            if key in totals:
                totals[key] += int(value)
    return totals


def _read_process_ticks(pid: int) -> int:
    raw = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    fields = raw[raw.rfind(")") + 2 :].split()
    return int(fields[11]) + int(fields[12])


def _read_process_gauges(pid: int) -> dict[str, int]:
    status = Path(f"/proc/{pid}/status").read_text(encoding="utf-8")
    values: dict[str, int] = {}
    for line in status.splitlines():
        key, _, raw = line.partition(":")
        if key == "VmRSS":
            values["rss_bytes"] = int(raw.split()[0]) * 1024
        elif key == "Threads":
            values["threads"] = int(raw.strip())
    return values


def _counter_snapshot(containers: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "monotonic": time.monotonic(),
        "host_cpu": parse_proc_stat(Path("/proc/stat").read_text(encoding="utf-8")),
        "network": parse_net_dev(Path("/proc/net/dev").read_text(encoding="utf-8")),
        "containers": {
            item["sample_key"]: {
                "cpu_usec": _read_cpu_usage(item["cgroup"]),
                "io": _read_io(item["cgroup"]),
                "process_ticks": _read_process_ticks(item["pid"]),
            }
            for item in containers
        },
    }


class LiveCollector:
    """Read fixed container, host, network, process, and service evidence."""

    def __init__(
        self,
        containers: list[dict[str, Any]],
        *,
        physical_interfaces: set[str],
        service_urls: Mapping[str, str],
        http_timeout_s: float,
    ) -> None:
        self.containers = containers
        self.physical_interfaces = physical_interfaces
        self.service_urls = service_urls
        self.http_timeout_s = http_timeout_s
        self.cpu_count = os.cpu_count() or 1
        self.clock_ticks = os.sysconf("SC_CLK_TCK")
        self.previous = _counter_snapshot(containers)

    def collect(self) -> dict[str, Any]:
        """Collect one sample without changing any service or container state."""
        captured_at = datetime.now(UTC).isoformat()
        try:
            current = _counter_snapshot(self.containers)
            elapsed = current["monotonic"] - self.previous["monotonic"]
            host = cpu_delta(
                self.previous["host_cpu"],
                current["host_cpu"],
                cpu_count=self.cpu_count,
            )
            host["cpu_busy_pct_machine"] = host.pop("busy_pct_machine")
            host["cpu_busy_core_equivalents"] = host.pop("busy_core_equivalents")
            load1, load5, load15 = os.getloadavg()
            host.update({"load1": load1, "load5": load5, "load15": load15})
            network = self._network(
                self.previous["network"], current["network"], elapsed
            )
            containers = self._containers(current, elapsed)
            processes = self._processes(current, elapsed)
            self.previous = current
        except (OSError, ValueError, KeyError, ZeroDivisionError) as exc:
            reason = f"counter read failed: {type(exc).__name__}"
            host = unavailable(reason)
            network = unavailable(reason)
            containers = unavailable(reason)
            processes = unavailable(reason)
        return {
            "captured_at": captured_at,
            "host": host,
            "network": network,
            "containers": containers,
            "processes": processes,
            "services": self._services(),
        }

    def _network(
        self, before: Mapping[str, Any], after: Mapping[str, Any], elapsed: float
    ) -> dict[str, Any]:
        values = network_delta(
            before, after, physical_interfaces=self.physical_interfaces
        )
        for counters in values.values():
            for field in (
                "rx_bytes",
                "tx_bytes",
                "rx_packets",
                "tx_packets",
                "rx_multicast_packets",
            ):
                counters[f"{field}_per_s"] = counters[field] / elapsed
        return values

    def _containers(self, current: Mapping[str, Any], elapsed: float) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for item in self.containers:
            key = item["sample_key"]
            before = self.previous["containers"][key]
            after = current["containers"][key]
            cpu_pct = (after["cpu_usec"] - before["cpu_usec"]) / (elapsed * 1e6) * 100
            io_delta = {
                name: after["io"][name] - before["io"][name]
                for name in _CGROUP_COUNTERS
            }
            result[key] = {
                **normalize_container_cpu(cpu_pct, cpu_count=self.cpu_count),
                "memory_bytes": _read_int(item["cgroup"] / "memory.current"),
                "pids": _read_int(item["cgroup"] / "pids.current"),
                "io": io_delta,
                "io_per_s": {name: value / elapsed for name, value in io_delta.items()},
            }
        return result

    def _processes(self, current: Mapping[str, Any], elapsed: float) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for item in self.containers:
            key = item["sample_key"]
            before = self.previous["containers"][key]["process_ticks"]
            after = current["containers"][key]["process_ticks"]
            cpu_pct = (after - before) / self.clock_ticks / elapsed * 100
            try:
                gauges: Any = _read_process_gauges(item["pid"])
            except (OSError, ValueError):
                gauges = unavailable("container init process unavailable")
            result[key] = {
                "role": "container_init",
                "pid": item["pid"],
                "pct_per_core": cpu_pct,
                "pct_machine": cpu_pct / self.cpu_count,
                "gauges": gauges,
            }
        return result

    def _services(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for name in ("monitor", "streamer", "recorder"):
            url = self.service_urls.get(name)
            payload = (
                fetch_json(url, timeout_s=self.http_timeout_s)
                if isinstance(url, str) and url
                else unavailable("endpoint not configured")
            )
            result[name] = extract_service_metrics(name, payload)
        result["probe"] = unavailable("no passive topic-probe status endpoint")
        return result


def _service_urls(collection: Mapping[str, Any]) -> dict[str, str]:
    configured = collection.get("service_urls")
    if configured is None:
        return dict(_DEFAULT_SERVICE_URLS)
    if not isinstance(configured, Mapping):
        raise CollectionError("collection.service_urls must be an object")
    result: dict[str, str] = {}
    for name, value in configured.items():
        if name not in _DEFAULT_SERVICE_URLS or not isinstance(value, str):
            raise CollectionError("service_urls must contain only string service URLs")
        try:
            parsed = urllib.parse.urlsplit(value)
            port = parsed.port
        except ValueError as exc:
            raise CollectionError(f"invalid service URL for {name}") from exc
        if (
            parsed.scheme != "http"
            or parsed.hostname not in {"localhost", "127.0.0.1"}
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or port is None
            or not 1 <= port <= 65535
        ):
            raise CollectionError(
                "service URLs must be local HTTP URLs with an explicit port"
            )
        result[name] = value
    return result


def _git_identity(root: Path) -> dict[str, Any]:
    def run(*args: str) -> bytes:
        return subprocess.run(
            ["git", "-C", str(root), *args],
            check=True,
            capture_output=True,
            timeout=5.0,
        ).stdout

    try:
        sha = run("rev-parse", "HEAD").decode().strip()
        status = run("status", "--porcelain=v1", "-z")
        diff = run("diff", "--binary", "HEAD")
    except (
        FileNotFoundError,
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
    ):
        return {"sha": "unknown", "dirty": unavailable("git identity unavailable")}
    digest = hashlib.sha256(status + b"\0" + diff).hexdigest() if status else None
    return {"sha": sha, "dirty": bool(status), "dirty_hash": digest}


def _config_hashes(scenario: Mapping[str, Any], root: Path) -> dict[str, Any]:
    paths = scenario.get("config_paths")
    if paths is None:
        configured = scenario.get("config_hashes")
        if configured is None:
            return unavailable("no config files configured")
        if not isinstance(configured, Mapping):
            raise CollectionError("config_hashes must be an object")
        if not configured:
            return unavailable("no config files configured")
        return dict(configured)
    if not isinstance(paths, Mapping):
        raise CollectionError("config_paths must be an object")
    if not paths:
        return unavailable("no config files configured")
    hashes: dict[str, Any] = {}
    for name, raw_path in paths.items():
        if not isinstance(name, str) or not isinstance(raw_path, str):
            raise CollectionError("config_paths keys and values must be strings")
        path = Path(raw_path)
        if not path.is_absolute():
            path = root / path
        try:
            hashes[name] = sha256_file(path)
        except OSError:
            hashes[name] = unavailable("config file unavailable")
    return hashes


def _required(scenario: Mapping[str, Any], name: str, expected: type) -> Any:
    value = scenario.get(name)
    if isinstance(value, bool) or not isinstance(value, expected):
        raise CollectionError(f"scenario {name} must be {expected.__name__}")
    return value


def _required_nonempty_string(scenario: Mapping[str, Any], name: str) -> str:
    value = _required(scenario, name, str)
    if not value.strip():
        raise CollectionError(f"scenario {name} must not be empty")
    return value


def _optional_string(scenario: Mapping[str, Any], name: str) -> str | None:
    value = scenario.get(name)
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise CollectionError(f"scenario {name} must be a string or null")
    return value


def _optional_string_list(scenario: Mapping[str, Any], name: str) -> list[str] | None:
    value = scenario.get(name)
    if value is None:
        return None
    if not isinstance(value, list) or not all(
        isinstance(item, str) and item for item in value
    ):
        raise CollectionError(f"scenario {name} must be an array of strings")
    return list(value)


def _optional_nonnegative_int(scenario: Mapping[str, Any], name: str) -> int | None:
    value = scenario.get(name)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise CollectionError(f"scenario {name} must be a non-negative integer")
    return value


def _optional_services(scenario: Mapping[str, Any]) -> dict[str, str] | None:
    value = scenario.get("services")
    if value is None:
        return None
    if not isinstance(value, Mapping) or not all(
        isinstance(key, str) and key and isinstance(state, str) and state
        for key, state in value.items()
    ):
        raise CollectionError("scenario services must map service names to states")
    return dict(value)


def _comparison_axes(scenario: Mapping[str, Any]) -> list[str] | None:
    comparison = scenario.get("comparison")
    if comparison is None:
        return None
    if not isinstance(comparison, Mapping):
        raise CollectionError("scenario comparison must be an object")
    axes = comparison.get("allowed_axes")
    if not isinstance(axes, list) or len(axes) != 1:
        raise CollectionError("comparison.allowed_axes must contain exactly one axis")
    if not all(isinstance(axis, str) and axis for axis in axes):
        raise CollectionError("comparison.allowed_axes must contain strings")
    if len(set(axes)) != len(axes):
        raise CollectionError("comparison.allowed_axes must not contain duplicates")
    unknown = sorted(set(axes) - _ALLOWED_COMPARISON_AXES)
    if unknown:
        raise CollectionError(f"unknown comparison axis: {unknown[0]}")
    return list(axes)


def _build_runtime_manifest(
    scenario: Mapping[str, Any],
    *,
    duration_s: float,
    warmup_s: float,
    interval_s: float,
    containers: list[dict[str, Any]],
    excluded: list[dict[str, Any]],
    interfaces: set[str],
    root: Path,
    collection: Mapping[str, Any],
) -> dict[str, Any]:
    git = _git_identity(root)
    hashes = _config_hashes(scenario, root)
    selected_topics = _required(scenario, "selected_topics", list)
    if not all(isinstance(topic, str) and topic for topic in selected_topics):
        raise CollectionError("scenario selected_topics must contain strings")
    manifest = build_manifest(
        scenario_name=_required_nonempty_string(scenario, "scenario_name"),
        duration_s=duration_s,
        warmup_s=warmup_s,
        sample_interval_s=interval_s,
        camera_count=_required(scenario, "camera_count", int),
        selected_topics=selected_topics,
        preview_layout=_required(scenario, "preview_layout", str),
        preview_caps=_required(scenario, "preview_caps", dict),
        recorder_state=_required(scenario, "recorder_state", str),
        probe_state=_required(scenario, "probe_state", str),
        robot_motion=_required_nonempty_string(scenario, "robot_motion"),
        rmw=_required_nonempty_string(scenario, "rmw"),
        transport_evidence=_required(scenario, "transport_evidence", dict),
        config_hashes=hashes,
        git_sha=git["sha"],
        services=_optional_services(scenario),
        monitor_topic_set=_optional_string(scenario, "monitor_topic_set"),
        camera_topics=_optional_string_list(scenario, "camera_topics"),
        connected_clients=_optional_nonnegative_int(scenario, "connected_clients"),
        probe_topic=_optional_string(scenario, "probe_topic"),
        probe_field=_optional_string(scenario, "probe_field"),
        cpu_count=os.cpu_count() or 1,
        physical_interfaces=sorted(interfaces),
        included_container_services=sorted(item["service"] for item in containers),
    )
    manifest["environment"].update(
        {
            "git_dirty": git.get("dirty"),
            "git_dirty_hash": git.get("dirty_hash"),
            "cpu_count": os.cpu_count() or 1,
            "cgroup_version": 2,
            "physical_interfaces": sorted(interfaces),
            "containers": {
                "included": [_public_container(item) for item in containers],
                "excluded": excluded,
            },
            "runtime_rmw": {
                item["sample_key"]: item["ros_environment"]["RMW_IMPLEMENTATION"]
                for item in containers
            },
            "ros_environment_allowlist": list(_ROS_ENV_ALLOWLIST),
            "service_endpoints": _service_endpoint_manifest(collection),
        }
    )
    axes = _comparison_axes(scenario)
    if axes is not None:
        manifest["comparison"] = {"allowed_axes": axes}
    return manifest


def _public_container(item: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: item[key]
        for key in ("id", "name", "service", "image", "sample_key", "ros_environment")
    }


def _service_endpoint_manifest(collection: Mapping[str, Any]) -> dict[str, str]:
    configured = collection.get("service_urls")
    if configured is None:
        return {name: "default-localhost" for name in _DEFAULT_SERVICE_URLS}
    if not isinstance(configured, Mapping):
        return {name: "invalid" for name in _DEFAULT_SERVICE_URLS}
    return {
        name: "localhost" if name in configured else "unavailable"
        for name in _DEFAULT_SERVICE_URLS
    }


def _capture_tcpdump(
    enabled: bool, duration_s: float, collection: Mapping[str, Any]
) -> dict[str, Any]:
    config = collection.get("tcpdump", {})
    if not isinstance(config, Mapping):
        raise CollectionError("collection.tcpdump must be an object")

    port = config.get("port")
    if port is not None and (isinstance(port, bool) or not isinstance(port, int)):
        raise CollectionError("collection.tcpdump.port must be an integer")
    return capture_multicast_packets(
        enabled=enabled,
        duration_s=duration_s,
        interface=config.get("interface"),
        multicast_host=config.get("multicast_host"),
        port=port,
    )


def _tcpdump_manifest(
    enabled: bool,
    collection: Mapping[str, Any],
    status: Mapping[str, Any],
) -> dict[str, Any]:
    config = collection.get("tcpdump", {})
    if not isinstance(config, Mapping):
        raise CollectionError("collection.tcpdump must be an object")
    interface = config.get("interface")
    group = config.get("multicast_host")
    port = config.get("port")
    result: dict[str, Any] = {
        "enabled": enabled,
        "interface": interface,
        "group": group,
        "port": port,
        "status": dict(status),
    }
    result["filter"] = (
        f"udp and dst host {group} and dst port {port}"
        if isinstance(group, str) and isinstance(port, int)
        else unavailable("tcpdump filter not configured")
    )
    return result


def _tcpdump_config(manifest: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: manifest[key]
        for key in ("enabled", "interface", "group", "port", "filter")
    }


def collect_scenario(
    scenario: Mapping[str, Any], *, root: Path, tcpdump_enabled: bool
) -> dict[str, Any]:
    """Run a validated scenario and return its complete result object."""
    duration_s, warmup_s, interval_s, warmup_samples = _validate_timing(scenario)
    collection = scenario.get("collection", {})
    if not isinstance(collection, Mapping):
        raise CollectionError("scenario collection must be an object")
    if collection.get("mode", "read-only") != "read-only":
        raise CollectionError("collection.mode must be read-only")
    timeout = collection.get("http_timeout_s", min(0.2, interval_s / 4))
    if (
        isinstance(timeout, bool)
        or not isinstance(timeout, (int, float))
        or timeout <= 0
    ):
        raise CollectionError("collection.http_timeout_s must be positive")
    service_urls = _service_urls(collection)
    containers, excluded = _container_inventory(collection)
    interfaces = _physical_interfaces(collection)
    manifest = _build_runtime_manifest(
        scenario,
        duration_s=duration_s,
        warmup_s=warmup_s,
        interval_s=interval_s,
        containers=containers,
        excluded=excluded,
        interfaces=interfaces,
        root=root,
        collection=collection,
    )
    collector = LiveCollector(
        containers,
        physical_interfaces=interfaces,
        service_urls=service_urls,
        http_timeout_s=float(timeout),
    )
    usage_before = resource.getrusage(resource.RUSAGE_SELF)
    children_before = resource.getrusage(resource.RUSAGE_CHILDREN)
    wall_start = time.monotonic()
    started_at = datetime.now(UTC).isoformat()
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        multicast_future = executor.submit(
            _capture_tcpdump, tcpdump_enabled, duration_s, collection
        )
        samples = collect_fixed_window(
            duration_s=duration_s,
            interval_s=interval_s,
            collect=collector.collect,
        )
        multicast = multicast_future.result()
    wall_s = time.monotonic() - wall_start
    tcpdump_manifest = _tcpdump_manifest(tcpdump_enabled, collection, multicast)
    environment = manifest.setdefault("environment", {})
    environment["tcpdump"] = tcpdump_manifest
    environment["tcpdump_config"] = _tcpdump_config(tcpdump_manifest)
    environment["tcpdump_result"] = multicast
    usage_after = resource.getrusage(resource.RUSAGE_SELF)
    children_after = resource.getrusage(resource.RUSAGE_CHILDREN)
    for sample in samples:
        sample["multicast"] = multicast
    aggregated = aggregate_samples(samples, warmup_samples=warmup_samples)
    return {
        "schema_version": "kairos.perf.result/v1",
        "manifest": manifest,
        "started_at": started_at,
        "completed_at": datetime.now(UTC).isoformat(),
        "observer_overhead": {
            "wall_s": wall_s,
            "self_user_cpu_s": usage_after.ru_utime - usage_before.ru_utime,
            "self_system_cpu_s": usage_after.ru_stime - usage_before.ru_stime,
            "child_user_cpu_s": children_after.ru_utime - children_before.ru_utime,
            "child_system_cpu_s": children_after.ru_stime - children_before.ru_stime,
            "max_rss_kib": usage_after.ru_maxrss,
        },
        **aggregated,
    }


def main(argv: Sequence[str] | None = None) -> int:
    """Run the collection CLI and return a shell-friendly status code."""
    args = _parser().parse_args(argv)
    try:
        scenario = _load_scenario(args.scenario)
        root = Path(__file__).resolve().parents[2]
        result = collect_scenario(scenario, root=root, tcpdump_enabled=args.tcpdump)
        write_json_result(result, args.output)
    except (CollectionError, ValueError, OSError) as exc:
        print(f"perf-collect: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
