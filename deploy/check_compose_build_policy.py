#!/usr/bin/env python3
"""Verify the proxy/network policy of every Compose-built Kairos image."""

from __future__ import annotations

import json
import os
import subprocess
import sys
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
    "single-host": ("compose/compose.yaml",),
    "robot-edge": ("compose/robot.yaml",),
    "recording-host": ("compose/recording.yaml",),
    "single-host+lerobot": ("compose/compose.yaml", "compose/lerobot.yaml"),
    "single-host+voicevox": ("compose/compose.yaml", "compose/voicevox.yaml"),
    "recording-host+voicevox": (
        "compose/recording.yaml",
        "compose/voicevox.yaml",
    ),
    "test-harness": ("deploy/test/compose.yaml",),
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


def render(files: tuple[str, ...], proxy_env: dict[str, str]) -> dict[str, object]:
    env = os.environ.copy()
    for name in PROXY_ARGS:
        env.pop(name, None)
    env.update(proxy_env)
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
    proxy_case: str,
    proxy_env: dict[str, str],
    expected: dict[str, str],
) -> list[str]:
    errors: list[str] = []
    services = render(files, proxy_env).get("services", {})
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


def main() -> int:
    errors = [
        error
        for name, files in LAYOUTS.items()
        for proxy_case, case in PROXY_CASES.items()
        for error in check_layout(
            name,
            files,
            proxy_case,
            case["environment"],
            case["expected"],
        )
    ]
    if errors:
        print("Compose build policy check failed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    print("Compose build policy check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
