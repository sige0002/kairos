"""Time helpers. Timestamps are UTC ISO8601 across all kairos APIs."""

from __future__ import annotations

from datetime import UTC, datetime


def utc_now_iso8601() -> str:
    """Return the current UTC time as an ISO8601 string with a ``Z`` suffix.

    Example: ``2026-06-24T01:23:45.123Z`` (millisecond precision). This is the
    canonical timestamp format for kairos APIs (see ``config.md``).
    """
    now = datetime.now(UTC)
    # Millisecond precision + a literal Z (rather than +00:00) per the spec.
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
