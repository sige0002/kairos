# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Scan the active robot's LeRobot profile library and report what it holds.

A profile is a rosbag2lerobot robot config YAML under
``config/<robot>/lerobot/`` (committed) or ``config/local/<robot>/lerobot/``
(gitignored, for a confidential robot). The library is a handful of NAMED
profiles — ``default`` / ``arm_only`` / ``lowfps`` — that an operator picks
between; editing one at conversion time is deliberately not a path here.

Validation goes through the converter's own loader, so "valid" means the exact
thing the conversion will mean by it. Where the converter is not installed (a
dev host, CI) the loader is absent: profiles are still listed, with ``valid``
left unknown rather than assumed — and the caller is told why, so an
"everything is fine" reading is never manufactured from a missing validator.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import yaml

from lerobot_exporter.models import ProfileInfo

logger = logging.getLogger("kairos")

PROFILE_ASPECT = "lerobot"


@dataclass(frozen=True)
class ProfileScan:
    """The library as found on disk, plus whether it could be validated."""

    items: list[ProfileInfo]
    validator_unavailable: bool


def _load_config_module():
    """The converter's config loader, or ``None`` when it is not installed.

    Imported lazily and by name: the exporter's own dependency set deliberately
    excludes the converter (see pyproject), so this import is the one place that
    knows whether the bundled submodule made it into this image.
    """
    try:
        from rosbag2lerobot.config import load_config
    except Exception:  # noqa: BLE001 - any import failure means "not available".
        return None
    return load_config


def _topics_from_mapping(raw: object) -> list[str]:
    """``topic`` values from a raw observations/actions list."""
    if not isinstance(raw, list):
        return []
    topics: list[str] = []
    for entry in raw:
        if isinstance(entry, dict):
            topic = entry.get("topic")
            if isinstance(topic, str) and topic:
                topics.append(topic)
    return topics


def _describe_unvalidated(path: Path) -> tuple[list[str], int | None, list[str]]:
    """``(topics, fps, errors)`` from a plain YAML read.

    Used when the converter is absent. The file is still the same YAML, so the
    orchestrator's preflight material (the topic list) survives; what is lost is
    the schema check, and that loss is reported rather than papered over.
    """
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        return [], None, [f"Could not read the profile: {exc}"]
    if not isinstance(raw, dict):
        return [], None, ["Profile is not a YAML mapping."]
    fps = raw.get("fps")
    topics = _topics_from_mapping(raw.get("observations")) + _topics_from_mapping(
        raw.get("actions")
    )
    return (
        list(dict.fromkeys(topics)),
        fps if isinstance(fps, int) and not isinstance(fps, bool) else None,
        [],
    )


def _describe_validated(path: Path, source: str, load_config) -> ProfileInfo:
    """Load *path* through the converter's loader and project the result."""
    try:
        config = load_config(path)
    except Exception as exc:  # noqa: BLE001 - a bad profile is data, not a 500.
        return ProfileInfo(
            name=path.stem,
            path=str(path),
            source=source,
            valid=False,
            errors=[str(exc)],
        )
    topics = [
        feature.topic
        for feature in (*config.observations, *config.actions)
        if getattr(feature, "topic", None)
    ]
    return ProfileInfo(
        name=path.stem,
        path=str(path),
        source=source,
        valid=True,
        topics=list(dict.fromkeys(topics)),
        fps=config.fps,
    )


def _profile_files(
    config_dir: str | Path, config_local_dir: str | Path, robot: str
) -> list[tuple[Path, str]]:
    """``(path, source)`` for every profile of *robot*, committed first.

    A stem present in both trees resolves to the committed one, matching how
    the orchestrator's config catalog resolves a robot (committed first, then
    local) — one name must not mean two files depending on who reads it.
    """
    found: dict[str, tuple[Path, str]] = {}
    for root, source in ((config_dir, "committed"), (config_local_dir, "local")):
        directory = Path(root) / robot / PROFILE_ASPECT
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.yaml")):
            if path.is_file() and path.stem not in found:
                found[path.stem] = (path, source)
    return [found[stem] for stem in sorted(found)]


def scan_profiles(
    config_dir: str | Path, config_local_dir: str | Path, robot: str
) -> ProfileScan:
    """List *robot*'s profile library, validating each where possible."""
    load_config = _load_config_module()
    items: list[ProfileInfo] = []
    for path, source in _profile_files(config_dir, config_local_dir, robot):
        if load_config is not None:
            items.append(_describe_validated(path, source, load_config))
            continue
        topics, fps, errors = _describe_unvalidated(path)
        items.append(
            ProfileInfo(
                name=path.stem,
                path=str(path),
                source=source,
                valid=None,
                errors=errors,
                topics=topics,
                fps=fps,
            )
        )
    return ProfileScan(items=items, validator_unavailable=load_config is None)
