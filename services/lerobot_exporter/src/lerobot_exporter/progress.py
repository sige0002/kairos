# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Read the converter's progress out of the output tree it is writing.

Two files, two questions, deliberately separate:

- ``meta/job_summary.json`` — the episode LEDGER (``n_success`` / ``n_failed``),
  rewritten after each episode finishes. It answers "how many are done".
- ``meta/progress.json`` — the HEARTBEAT, rewritten every few seconds while an
  episode is being converted. It answers "how far into the current episode" and,
  through ``updated_at``, "is anything still happening at all".

Both are written atomically upstream, but a reader can still catch a file that
does not parse (a truncated write on a filesystem that does not honour the
rename, an older converter with a different shape). Every failure here degrades
to "no new information" — never to a failed export.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

META_DIRNAME = "meta"
PROGRESS_FILENAME = "progress.json"
JOB_SUMMARY_FILENAME = "job_summary.json"


@dataclass(frozen=True)
class EpisodeCounts:
    """Episode outcomes so far, from ``job_summary.json``."""

    done: int
    failed: int


@dataclass(frozen=True)
class Heartbeat:
    """One reading of ``progress.json``."""

    episode_pct: float | None
    # Epoch seconds. Falls back to the file's mtime when the converter's own
    # ``updated_at`` is missing or unparsable — the point of the field is
    # liveness, and the file being rewritten is itself evidence of that.
    updated_at: float


def _read_meta(output_dir: Path, filename: str) -> dict[str, Any] | None:
    """Parse ``<output_dir>/meta/<filename>``; ``None`` if absent or unreadable."""
    path = output_dir / META_DIRNAME / filename
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)


def read_episode_counts(output_dir: Path) -> EpisodeCounts | None:
    """Episode successes/failures so far, or ``None`` before the first episode."""
    data = _read_meta(output_dir, JOB_SUMMARY_FILENAME)
    if data is None:
        return None
    done = _as_int(data.get("n_success"))
    failed = _as_int(data.get("n_failed"))
    if done is None and failed is None:
        return None
    return EpisodeCounts(done=max(0, done or 0), failed=max(0, failed or 0))


def _parse_updated_at(value: Any) -> float | None:
    """Epoch seconds from either an epoch number or an ISO-8601 timestamp."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def read_heartbeat(output_dir: Path) -> Heartbeat | None:
    """The latest heartbeat, or ``None`` when the converter has written none."""
    path = output_dir / META_DIRNAME / PROGRESS_FILENAME
    data = _read_meta(output_dir, PROGRESS_FILENAME)
    if data is None:
        return None
    updated_at = _parse_updated_at(data.get("updated_at"))
    if updated_at is None:
        try:
            updated_at = path.stat().st_mtime
        except OSError:
            return None
    return Heartbeat(episode_pct=_episode_pct(data), updated_at=updated_at)


def _episode_pct(data: dict[str, Any]) -> float | None:
    """Percent complete WITHIN the current episode, or ``None`` if unknowable.

    The denominator is the bag's message count, known before the episode starts,
    so this is a real fraction rather than a spinner. A zero/absent total yields
    ``None``: an invented 0 % or 100 % would be a claim we cannot make.
    """
    done = _as_int(data.get("messages_done"))
    total = _as_int(data.get("messages_total"))
    if done is None or total is None or total <= 0:
        return None
    return round(min(100.0, max(0.0, done / total * 100.0)), 1)
