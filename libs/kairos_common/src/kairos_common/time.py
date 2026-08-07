"""Time helpers. Timestamps are UTC ISO8601 across all kairos APIs."""

from __future__ import annotations

from datetime import UTC, datetime


def utc_iso8601_of(moment: datetime) -> str:
    """Format *moment* (an aware UTC datetime) in the canonical kairos shape.

    Example: ``2026-06-24T01:23:45.123Z`` (millisecond precision, literal
    ``Z``). Timestamps of the two precisions do not compare consistently as
    strings within the same millisecond, and SQLite range checks (e.g. lease
    expiry) compare them as strings — so every stored stamp must go through
    here or ``utc_now_iso8601``.
    """
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def parse_iso8601(value: str | None) -> datetime | None:
    """Parse a UTC ISO8601 stamp (``None`` when absent or unparseable).

    A naive stamp is read as UTC rather than as local time: everything written
    through :func:`utc_iso8601_of` carries a ``Z``, and the stamps that do not
    come from older sidecars that were UTC all along.
    """
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed


def utc_now_iso8601() -> str:
    """Return the current UTC time as an ISO8601 string with a ``Z`` suffix.

    Example: ``2026-06-24T01:23:45.123Z`` (millisecond precision). This is the
    canonical timestamp format for kairos APIs (see ``config.md``).
    """
    return utc_iso8601_of(datetime.now(UTC))
