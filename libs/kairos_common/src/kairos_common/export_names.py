# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The one naming contract for LeRobot export output names (§6.2).

Shared so the orchestrator (which COMPOSES ``<operator>_<profile>_<memo>`` and
shows it in preflight) and the exporter (which VALIDATES the name before it
becomes a directory) agree by construction. When they disagreed, preflight
promised a destination the exporter then rejected as ``invalid_output_name``:
an operator named ``Alice Smith`` or a memo in kanji sailed through composition
and failed at submit.

A valid segment is a single path component: starts alphanumeric (so dotfiles
and ``..`` can never be addressed), then alphanumerics plus ``.`` ``_`` ``-``,
bounded in length. The composer sanitises to exactly this so what it shows is
what the exporter accepts.
"""

from __future__ import annotations

import re
import unicodedata

# The fixed root every export name lives under, as recorded in the ledger and
# served by the files API. Kept here beside the segment rule so the "output is
# exactly exports/<segment>" invariant has one home.
EXPORTS_DIRNAME = "exports"

EXPORT_SEGMENT_MAX_LEN = 128

# One path segment: alphanumeric start, then the safe punctuation set. This is
# the authority both sides use — the exporter to refuse, the orchestrator to
# produce something that will not be refused.
_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_UNSAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")
_LEADING_JUNK_RE = re.compile(r"^[^A-Za-z0-9]+")


def is_valid_export_segment(value: str) -> bool:
    """Whether *value* is already a safe single export-name segment."""
    return (
        isinstance(value, str)
        and 0 < len(value) <= EXPORT_SEGMENT_MAX_LEN
        and _SEGMENT_RE.match(value) is not None
    )


def compose_export_name(*segments: str) -> str:
    """Join already-sanitised segments into one valid export name.

    ``_`` is the joiner, so the whole name is itself a single segment — but the
    JOIN can exceed the length bound that each piece satisfies alone (a long
    operator label plus a long memo). Truncating here, to the same
    ``is_valid_export_segment`` contract the exporter enforces, is what keeps
    preflight from promising a name that submit then rejects. The trailing
    trim keeps the cut from landing on a ``_``/``.``/``-``.
    """
    name = "_".join(s for s in segments if s)
    if len(name) > EXPORT_SEGMENT_MAX_LEN:
        name = name[:EXPORT_SEGMENT_MAX_LEN].rstrip("_.-")
    return name


def sanitize_export_segment(value: str | None, fallback: str) -> str:
    """A valid export segment derived from *value*, or *fallback* if none remains.

    ASCII-folds first so accented and non-Latin names keep as much of
    themselves as ASCII allows rather than collapsing to all-underscores, then
    replaces any remaining unsafe run with a single ``_``, trims leading
    non-alphanumerics (the segment must start alphanumeric), and caps the
    length. A value that reduces to nothing yields *fallback* — never an empty
    or unsafe segment.
    """
    text = (value or "").strip()
    # NFKD + ASCII drop turns "Ålëx" into "Alex" and "山田" into "" — the latter
    # then falls through to fallback rather than becoming a wall of underscores.
    folded = (
        unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    )
    collapsed = _UNSAFE_RE.sub("_", folded)
    trimmed = _LEADING_JUNK_RE.sub("", collapsed).strip("_")
    trimmed = trimmed[:EXPORT_SEGMENT_MAX_LEN].rstrip("_.-")
    if not trimmed or not is_valid_export_segment(trimmed):
        return fallback
    return trimmed
