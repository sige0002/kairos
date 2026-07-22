"""Pure helpers for the bridge node (no dora / ROS imports).

Cell-B verified behavior of the pinned bridge: type resolution is lazy and
sourced ONLY from ``$AMENT_PREFIX_PATH/share/<pkg>/msg/*.msg``; when the type
cannot be resolved the event ``value`` arrives as a ``RuntimeError`` object
(the node neither crashes nor drops silently). Calling ``.nbytes`` /
``.to_pylist()`` on it is a secondary failure, so every value goes through
:func:`classify_value` first.
"""

from __future__ import annotations

from typing import Any, NamedTuple


class ValueInfo(NamedTuple):
    """Classification of one external (ROS 2) event value."""

    bridged: bool
    size_bytes: int | None
    error: str | None


def classify_value(value: Any) -> ValueInfo:
    """Classify a bridge event value before touching Arrow accessors."""
    if isinstance(value, BaseException):
        return ValueInfo(bridged=False, size_bytes=None, error=str(value))
    try:
        size = int(getattr(value, "nbytes", 0) or 0)
    except Exception as exc:  # defensive: unknown value shapes stay countable
        return ValueInfo(bridged=False, size_bytes=None, error=str(exc))
    return ValueInfo(bridged=True, size_bytes=size, error=None)


def extract_stamp_ns(value: Any) -> int | None:
    """Best-effort ``header.stamp`` (ns since epoch) from a decoded message.

    The bridge delivers each message as a pyarrow struct array; messages
    without a std_msgs Header (or non-struct payloads) yield ``None``.
    """
    try:
        typ = value.type
        if not hasattr(typ, "field"):
            return None
        names = [typ.field(i).name for i in range(typ.num_fields)]
        if "header" not in names:
            return None
        header = value.field("header")
        stamp = header.field("stamp")
        sec = stamp.field("sec")[0].as_py()
        nanosec = stamp.field("nanosec")[0].as_py()
        if not sec and not nanosec:
            # Zero stamp = "not stamped" by convention (Sample contract);
            # treating it as epoch 0 would fabricate epoch-sized delays.
            return None
        return int(sec) * 1_000_000_000 + int(nanosec)
    except Exception:
        return None


def dora_type_name(ros_type: str) -> str:
    """``pkg/msg/Type`` -> ``pkg/Type`` (create_topic rejects the infix)."""
    return ros_type.replace("/msg/", "/")


def decode_first(value: Any) -> dict | None:
    """Arrow struct array -> the first element as a nested dict.

    The whole-struct conversion is EXPENSIVE for camera payloads (~ms) — call
    it only behind a gate (probe active / rate gate / keyframe gate).
    """
    try:
        rows = value.to_pylist()
    except Exception:
        return None
    if not rows or not isinstance(rows[0], dict):
        return None
    return rows[0]


def feed_row_from_tuple(
    topic: str, sample: tuple[int, int, int | None, bool]
) -> dict[str, Any]:
    """One drained metrics-subscription sample -> a ``/internal/samples`` row.

    Sample shape (frozen pyo3 contract of the carried dora patch):
    ``(recv_ns_monotonic, size_bytes, stamp_ns | None, bridged)``.
    """
    recv_ns, size, stamp_ns, bridged = sample
    row: dict[str, Any] = {
        "topic": topic,
        "recv_t": recv_ns / 1e9,
        "size": size,
        "bridged": bridged,
    }
    if stamp_ns is not None:
        row["stamp_s"] = stamp_ns / 1e9
    return row


def feed_row(
    topic: str,
    t_recv_ns: int,
    info: ValueInfo,
    stamp_ns: int | None,
) -> dict[str, Any]:
    """Build one ``POST /internal/samples`` row from a bridge arrival."""
    row: dict[str, Any] = {
        "topic": topic,
        "recv_t": t_recv_ns / 1e9,
        "size": info.size_bytes or 0,
        "bridged": info.bridged,
    }
    if stamp_ns is not None:
        row["stamp_s"] = stamp_ns / 1e9
    return row
