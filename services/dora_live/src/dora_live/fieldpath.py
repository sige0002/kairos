"""Dotted-path field access over decoded (dict-shaped) messages.

The bridge decodes ROS messages into Arrow structs; ``.to_pylist()[0]`` yields
nested dicts/lists. These helpers mirror the path grammar of
``kairos_common.field_introspect`` (``pose.position.x``, ``data[2]``) but walk
dicts instead of ROS message objects, so the probe surface stays
path-compatible with topic_probe.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from typing import Any

_INDEX_RE = re.compile(r"^(?P<name>[^\[\]]*)(?:\[(?P<index>\d+)\])?$")

# Introspection guards: huge arrays (images, pointclouds) would otherwise
# enumerate thousands of numeric leaves.
_MAX_ARRAY_LEAVES = 8
_MAX_FIELDS = 200


def extract_value(data: dict[str, Any], path: str) -> float | None:
    """Resolve a dotted path to a numeric value (None when unresolvable)."""
    current: Any = data
    for part in path.split("."):
        m = _INDEX_RE.match(part)
        if m is None or not m.group("name"):
            return None
        if not isinstance(current, dict):
            return None
        current = current.get(m.group("name"))
        index = m.group("index")
        if index is not None:
            if not isinstance(current, (list, tuple)):
                return None
            i = int(index)
            if i >= len(current):
                return None
            current = current[i]
    if isinstance(current, bool):
        return float(current)
    if isinstance(current, (int, float)):
        return float(current)
    return None


def iter_numeric_paths(data: dict[str, Any], prefix: str = "") -> Iterator[str]:
    """Yield dotted paths of numeric leaves (bounded; see module guards)."""
    count = 0
    for path in _iter_paths(data, prefix):
        yield path
        count += 1
        if count >= _MAX_FIELDS:
            return


def _iter_paths(value: Any, prefix: str) -> Iterator[str]:
    if isinstance(value, bool):
        if prefix:
            yield prefix
    elif isinstance(value, (int, float)):
        if prefix:
            yield prefix
    elif isinstance(value, dict):
        for key, child in value.items():
            child_prefix = f"{prefix}.{key}" if prefix else str(key)
            yield from _iter_paths(child, child_prefix)
    elif isinstance(value, (list, tuple)):
        for i, child in enumerate(value[:_MAX_ARRAY_LEAVES]):
            yield from _iter_paths(child, f"{prefix}[{i}]")
