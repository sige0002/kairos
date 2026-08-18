# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Resolve robot config paths against the committed and local config trees.

Committed robots live under ``config/<robot>/...``; user-defined ones under the
gitignored ``config/local/<robot>/...``. ``make`` derives local-aware container
paths before starting compose, but plain ``docker compose`` interpolation
cannot test file existence, so its ``${VAR:-/config/<robot>/...}`` fallbacks
always name the committed tree — a local robot then resolves to a path that
does not exist. Every service funnels its config paths through
:func:`resolve_config_path` at startup so raw-compose deployments (notably the
robot edge of the cross-host split, started without ``make``) still find the
local tree.
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger("kairos")

# The config mount root's basename: ./config on the host, /config in Docker.
_CONFIG_SEGMENT = "config"
_LOCAL_SEGMENT = "local"


def resolve_config_path(path: str) -> str:
    """Return *path*, or its ``config/local/`` twin when only the twin exists.

    An existing path (or an empty string, used for "disabled") is returned
    unchanged. A missing ``.../config/<robot>/...`` path is retried as
    ``.../config/local/<robot>/...``; if that twin exists it is returned (with
    an INFO log), otherwise the original path is returned so the caller's own
    missing-file handling still sees the value it was given.
    """
    if not path:
        return path
    given = Path(path)
    if given.exists():
        return path
    parts = list(given.parts)
    try:
        root = parts.index(_CONFIG_SEGMENT)
    except ValueError:
        return path
    if parts[root + 1 : root + 2] == [_LOCAL_SEGMENT]:
        return path
    local = Path(*parts[: root + 1], _LOCAL_SEGMENT, *parts[root + 1 :])
    if local.exists():
        logger.info("config path %s not found; using the local tree: %s", path, local)
        return str(local)
    return path
