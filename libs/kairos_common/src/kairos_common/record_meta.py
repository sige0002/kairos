# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The placeholders a RECORDED capture uses when it has no operator or task.

Shared because both entry points into a recording must produce the *same*
placeholders: the orchestrator's ``/api/v1/record/start``, and a direct call to
the recorder's own ``/record/start`` with no session metadata. They used to be
two copies kept in step by a comment, which is exactly the arrangement that
drifts.

The values must not be null. §3.3 gives a null operator/task a meaning of its
own — the capture was *imported*, not recorded here — which ``bag_import`` sets
deliberately. A capture recorded on this machine by nobody in particular has to
say that, not borrow the import spelling and misfile its own origin.
"""

from __future__ import annotations

UNKNOWN_OPERATOR = "unknown_operator"
UNKNOWN_TASK = "unknown_task"


def default_meta(value: str | None, default: str) -> str:
    """Coerce an empty/whitespace metadata field to a stable placeholder."""
    return value.strip() if value and value.strip() else default
