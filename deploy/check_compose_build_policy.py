#!/usr/bin/env python3
"""Verify Compose build policy and deployment-critical DDS configuration."""

from __future__ import annotations

import ipaddress
import json
import os
import socket
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROXY_ARGS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
)
LAYOUTS = {
    "single-host": (("compose/compose.yaml",), None),
    "single-host+audio": (("compose/compose.yaml",), "audio"),
    "robot-edge": (("compose/robot.yaml",), None),
    "recording-host": (("compose/recording.yaml",), None),
    "single-host+lerobot": (
        ("compose/compose.yaml", "compose/lerobot.yaml"),
        None,
    ),
    "test-harness": (("deploy/test/compose.yaml",), None),
}
PROXY_CASES = {
    "uppercase": {
        "environment": {
            "HTTP_PROXY": "kairos-policy-http",
            "HTTPS_PROXY": "kairos-policy-https",
            "NO_PROXY": "kairos-policy-no",
        },
        "expected": {
            "HTTP_PROXY": "kairos-policy-http",
            "HTTPS_PROXY": "kairos-policy-https",
            "NO_PROXY": "kairos-policy-no",
            "http_proxy": "kairos-policy-http",
            "https_proxy": "kairos-policy-https",
            "no_proxy": "kairos-policy-no",
        },
    },
    "lowercase": {
        "environment": {
            "http_proxy": "kairos-policy-http",
            "https_proxy": "kairos-policy-https",
            "no_proxy": "kairos-policy-no",
        },
        "expected": {
            "HTTP_PROXY": "kairos-policy-http",
            "HTTPS_PROXY": "kairos-policy-https",
            "NO_PROXY": "kairos-policy-no",
            "http_proxy": "kairos-policy-http",
            "https_proxy": "kairos-policy-https",
            "no_proxy": "kairos-policy-no",
        },
    },
}

CYCLONEDDS_NAMESPACE = {"cdds": "https://cdds.io/config"}
SHARED_CYCLONEDDS_PATH = ROOT / "config/cyclonedds-shared-domain.xml"
SHARED_CYCLONEDDS_URI = "file:///config/cyclonedds-shared-domain.xml"
ROS_LAYOUTS = {
    "single-host": (
        ("compose/compose.yaml",),
        {"recorder", "monitor", "streamer", "probe"},
    ),
    "robot-edge": (
        ("compose/robot.yaml",),
        {"recorder", "monitor", "streamer", "probe"},
    ),
}


def render(
    files: tuple[str, ...], proxy_env: dict[str, str], profile: str | None
) -> dict[str, object]:
    env = os.environ.copy()
    for name in PROXY_ARGS:
        env.pop(name, None)
    env.update(proxy_env)
    if profile is not None:
        env["COMPOSE_PROFILES"] = profile
    command = ["docker", "compose", "--project-directory", str(ROOT)]
    for path in files:
        command.extend(("-f", path))
    command.extend(("config", "--format", "json"))
    completed = subprocess.run(
        command,
        cwd=ROOT,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def check_layout(
    name: str,
    files: tuple[str, ...],
    profile: str | None,
    proxy_case: str,
    proxy_env: dict[str, str],
    expected: dict[str, str],
) -> list[str]:
    errors: list[str] = []
    services = render(files, proxy_env, profile).get("services", {})
    if not isinstance(services, dict):
        return [f"{name}: rendered services are not an object"]

    for service_name, service in services.items():
        if not isinstance(service, dict) or "build" not in service:
            continue
        build = service["build"]
        if not isinstance(build, dict):
            errors.append(f"{name}/{service_name}: build must use mapping syntax")
            continue
        if build.get("network") != "host":
            errors.append(f"{name}/{service_name}: build.network must be host")
        args = build.get("args", {})
        if not isinstance(args, dict):
            errors.append(f"{name}/{service_name}: build.args must be a mapping")
            continue
        invalid = [arg for arg in PROXY_ARGS if args.get(arg) != expected[arg]]
        if invalid:
            errors.append(
                f"{name}/{service_name}: proxy args do not inherit the "
                f"{proxy_case} environment: {', '.join(invalid)}"
            )
    return errors


def check_shared_cyclonedds_profile() -> list[str]:
    """Validate the safety-critical semantics of the shared-LAN profile."""
    try:
        root = ET.parse(SHARED_CYCLONEDDS_PATH).getroot()
    except (OSError, ET.ParseError) as exc:
        return [f"shared CycloneDDS profile does not parse: {exc}"]

    errors: list[str] = []
    allow_multicast = root.find(".//cdds:AllowMulticast", CYCLONEDDS_NAMESPACE)
    if (
        allow_multicast is None
        or (allow_multicast.text or "").strip().lower() != "spdp"
    ):
        errors.append("shared CycloneDDS profile: AllowMulticast must be spdp")

    participant_index = root.find(".//cdds:ParticipantIndex", CYCLONEDDS_NAMESPACE)
    if (
        participant_index is None
        or (participant_index.text or "").strip().lower() != "none"
    ):
        errors.append("shared CycloneDDS profile: ParticipantIndex must be none")

    interface_bindings = [
        value.strip().lower()
        for interface in root.findall(".//cdds:NetworkInterface", CYCLONEDDS_NAMESPACE)
        for value in (interface.get("name"), interface.get("address"))
        if value and value.strip()
    ]
    interface_bindings.extend(
        (element.text or "").strip().lower()
        for element in root.findall(
            ".//cdds:NetworkInterfaceAddress", CYCLONEDDS_NAMESPACE
        )
        if (element.text or "").strip()
    )
    if interface_bindings and all(
        _is_loopback_binding(binding) for binding in interface_bindings
    ):
        errors.append("shared CycloneDDS profile must not bind exclusively to loopback")
    return errors


def _is_loopback_binding(value: str) -> bool:
    """Classify known interface names, loopback addresses, and loopback CIDRs."""
    binding = value.strip().lower()
    if binding in {"lo", "localhost"}:
        return True
    try:
        if "/" in binding:
            network = ipaddress.ip_network(binding, strict=False)
        else:
            try:
                address = ipaddress.ip_address(binding)
            except ValueError:
                # Cyclone/inet_aton also accept historical IPv4 spellings such
                # as 127.1, a single 32-bit integer, and octal components.
                address = ipaddress.ip_address(socket.inet_aton(binding))
            return address.is_loopback
    except (OSError, ValueError):
        # Unknown interface names may be routable and must not be rejected.
        return False
    loopback_network = ipaddress.ip_network(
        "127.0.0.0/8" if network.version == 4 else "::1/128"
    )
    return network.subnet_of(loopback_network)


def check_loopback_classifier() -> list[str]:
    """Keep the safety check aware of the complete IPv4 loopback range."""
    errors: list[str] = []
    for binding in (
        "lo",
        "localhost",
        "127.0.0.0",
        "127.0.0.0/8",
        "127.1",
        "2130706433",
        "0177.0.0.1",
        "::1",
    ):
        if not _is_loopback_binding(binding):
            errors.append(f"loopback classifier rejected {binding}")
    for binding in (
        "eth0",
        "192.0.2.1",
        "192.2.1",
        "3221225985",
        "0300.0.2.1",
        "127.0.0.0/7",
        "::/0",
    ):
        if _is_loopback_binding(binding):
            errors.append(f"loopback classifier accepted routable binding {binding}")
    return errors


def _config_mount_resolves_profile(service: dict[str, object]) -> bool:
    """Return whether the service exposes the committed profile at its URI path."""
    for volume in service.get("volumes", []):
        if not isinstance(volume, dict) or volume.get("target") != "/config":
            continue
        if not volume.get("read_only"):
            continue
        source = volume.get("source")
        if not isinstance(source, str):
            continue
        mounted_profile = Path(source) / SHARED_CYCLONEDDS_PATH.name
        if mounted_profile.resolve() == SHARED_CYCLONEDDS_PATH.resolve():
            return mounted_profile.is_file()
    return False


def check_ros_cyclonedds_wiring() -> list[str]:
    """Render supported ROS layouts with the shared profile selected."""
    errors: list[str] = []
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as env_file:
        env_file.write("RMW_IMPLEMENTATION=rmw_cyclonedds_cpp\n")
        env_file.write(f"CYCLONEDDS_URI={SHARED_CYCLONEDDS_URI}\n")
        env_file.flush()
        render_env = {
            "KAIROS_ENV_FILE": env_file.name,
            "RMW_IMPLEMENTATION": "rmw_cyclonedds_cpp",
        }

        for layout_name, (files, expected_services) in ROS_LAYOUTS.items():
            services = render(files, render_env, None).get("services", {})
            if not isinstance(services, dict):
                errors.append(f"{layout_name}: rendered services are not an object")
                continue
            missing = expected_services - services.keys()
            if missing:
                errors.append(
                    f"{layout_name}: missing ROS services: {', '.join(sorted(missing))}"
                )
            for service_name in sorted(expected_services & services.keys()):
                service = services[service_name]
                if not isinstance(service, dict):
                    errors.append(f"{layout_name}/{service_name}: invalid service")
                    continue
                environment = service.get("environment", {})
                if (
                    not isinstance(environment, dict)
                    or environment.get("RMW_IMPLEMENTATION") != "rmw_cyclonedds_cpp"
                ):
                    errors.append(
                        f"{layout_name}/{service_name}: Cyclone DDS RMW is not selected"
                    )
                if (
                    not isinstance(environment, dict)
                    or environment.get("CYCLONEDDS_URI") != SHARED_CYCLONEDDS_URI
                ):
                    errors.append(
                        f"{layout_name}/{service_name}: CYCLONEDDS_URI is not "
                        "passed through"
                    )
                if not _config_mount_resolves_profile(service):
                    errors.append(
                        f"{layout_name}/{service_name}: /config does not resolve "
                        "the shared profile"
                    )
    return errors


def main() -> int:
    errors = check_loopback_classifier()
    errors.extend(check_shared_cyclonedds_profile())
    errors.extend(check_ros_cyclonedds_wiring())
    errors.extend(
        error
        for name, (files, profile) in LAYOUTS.items()
        for proxy_case, case in PROXY_CASES.items()
        for error in check_layout(
            name,
            files,
            profile,
            proxy_case,
            case["environment"],
            case["expected"],
        )
    )
    if errors:
        print("Compose build policy check failed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    print("Compose build policy check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
