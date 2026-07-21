"""Pure helpers shared by the metrics dataflow node and its tests."""

from __future__ import annotations

from typing import Any

FLUSH_MAX_ROWS = 500


def row_from_meta(meta: dict[str, Any]) -> dict[str, Any] | None:
    """Convert bridge ``send_output`` metadata into a feed row.

    Returns ``None`` for rows without the mandatory keys (defensive: an
    unknown producer on the bus must not poison the feed).
    """
    topic = meta.get("topic")
    t_recv_ns = meta.get("t_recv_ns")
    if not topic or t_recv_ns is None:
        return None
    try:
        recv_t = int(t_recv_ns) / 1e9
    except (TypeError, ValueError):
        return None
    row: dict[str, Any] = {
        "topic": topic,
        "recv_t": recv_t,
        "size": _opt_int(meta.get("size")) or 0,
        "bridged": meta.get("bridged", "1") == "1",
    }
    stamp_ns = _opt_int(meta.get("stamp_ns"))
    if stamp_ns is not None:
        row["stamp_s"] = stamp_ns / 1e9
    return row


def _opt_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
