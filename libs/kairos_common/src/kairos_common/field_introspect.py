# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Numeric-field introspection — the pure-logic core of topic_probe.

topic_probe is the one kairos service *allowed* to decode message payloads (it
is isolated from the non-intrusive monitor and the recorder on purpose). Given a
**decoded** message object — a rosidl message, a dataclass, a dict, or any plain
object with attributes — this module walks its numeric leaves and produces the
dotted field paths the UI offers for plotting (e.g. ``pose.position.x``,
``data[2]``). It then extracts the live value at a chosen path.

It is deliberately ROS-agnostic so it can be unit-tested with plain Python
objects (no rclpy): the rclpy seam (:mod:`topic_probe.ros_subscriber`) only has
to hand us a decoded message; everything here is pure logic.

Caps keep introspection bounded on pathological messages (point clouds, huge
arrays): fixed limits on array indices walked, recursion depth, and total field
count. Numeric = any ``numbers.Real`` (``int``/``float`` and the numpy scalars
rosidl decodes numeric leaves to), with ``bool`` excluded — it is not a plot
signal and ``isinstance(True, numbers.Real)`` would otherwise smuggle it in.
"""

from __future__ import annotations

import numbers
from collections.abc import Mapping

# Bounds so introspecting a pathological message (e.g. a point cloud) stays cheap
# and the field list stays usable in a dropdown.
DEFAULT_MAX_ARRAY = 16  # indices walked per array/sequence
DEFAULT_MAX_DEPTH = 12  # nested-message recursion guard
DEFAULT_MAX_FIELDS = 256  # total numeric leaves returned


def _is_numeric(value: object) -> bool:
    """True for plottable numeric scalars (``int``/``float`` + numpy, never bool).

    Uses ``numbers.Real`` rather than ``isinstance(value, (int, float))`` so the
    numpy scalars rosidl decodes numeric leaves (and fixed-length array elements)
    to count as numeric — ``np.float32`` is not a subclass of ``float``. Both
    ``bool`` and ``np.bool_`` are excluded (the latter is not a ``numbers.Real``;
    the explicit check drops Python ``bool``, which is).
    """
    return isinstance(value, numbers.Real) and not isinstance(value, bool)


def _is_str_like(value: object) -> bool:
    """Strings/bytes are leaves but never numeric — skip without recursing."""
    return isinstance(value, (str, bytes, bytearray))


def _child_fields(obj: object) -> list[tuple[str, object]]:
    """Return the named sub-fields of a composite object, in declaration order.

    Handles the shapes topic_probe actually sees: rosidl messages
    (``get_fields_and_field_types``), dicts, dataclasses, ``__slots__`` objects,
    and plain attribute objects (``types.SimpleNamespace`` in tests). Returns an
    empty list for anything without named fields (so the caller treats it as a
    leaf).
    """
    # rosidl-generated message: authoritative field order + names.
    get_fields = getattr(obj, "get_fields_and_field_types", None)
    if callable(get_fields):
        try:
            names = list(get_fields().keys())
        except Exception:  # noqa: BLE001 - defensive: never let one type abort
            names = []
        return [(name, getattr(obj, name, None)) for name in names]

    if isinstance(obj, Mapping):
        return [(str(key), value) for key, value in obj.items()]

    # dataclass instance.
    dc_fields = getattr(type(obj), "__dataclass_fields__", None)
    if dc_fields is not None:
        return [(name, getattr(obj, name, None)) for name in dc_fields]

    # __slots__ object (rosidl messages store fields as ``_name`` slots, but the
    # get_fields path above already handled those; this covers plain slotted
    # classes). Strip a single leading underscore to expose the public name.
    slots = getattr(type(obj), "__slots__", None)
    if slots:
        out: list[tuple[str, object]] = []
        for slot in slots:
            public = slot[1:] if slot.startswith("_") else slot
            out.append((public, getattr(obj, public, getattr(obj, slot, None))))
        return out

    # Plain attribute object (e.g. SimpleNamespace). Skip private/dunder attrs.
    obj_dict = getattr(obj, "__dict__", None)
    if isinstance(obj_dict, Mapping):
        return [
            (str(key), value)
            for key, value in obj_dict.items()
            if not str(key).startswith("_")
        ]
    return []


def _is_sequence(value: object) -> bool:
    """True for indexable, non-string array-likes (list/tuple/array.array/ndarray).

    Structural ``__len__`` + ``__getitem__`` rather than
    ``collections.abc.Sequence`` so fixed-length rosidl numeric arrays
    (``float64[N]``, decoded to ``numpy.ndarray`` — NOT a registered Sequence)
    are walked and indexed the same as variable-length ones (``float64[]``,
    decoded to ``array.array`` — which is). Strings/bytes are leaves and Mappings
    are keyed objects, so both are excluded.
    """
    if _is_str_like(value) or isinstance(value, Mapping):
        return False
    return hasattr(value, "__len__") and hasattr(value, "__getitem__")


def iter_numeric_fields(
    root: object,
    *,
    max_array: int = DEFAULT_MAX_ARRAY,
    max_depth: int = DEFAULT_MAX_DEPTH,
    max_fields: int = DEFAULT_MAX_FIELDS,
) -> list[str]:
    """List the dotted paths of every plottable numeric leaf under *root*.

    Walks nested messages (dotted: ``a.b.c``) and small fixed arrays (indexed:
    ``data[2]``, ``points[0].x``). Bounded by *max_array* / *max_depth* /
    *max_fields*. Order is stable (declaration / sequence order).
    """
    out: list[str] = []

    def walk(node: object, prefix: str, depth: int) -> None:
        if len(out) >= max_fields or depth > max_depth:
            return
        if _is_numeric(node):
            if prefix:
                out.append(prefix)
            return
        if node is None or _is_str_like(node):
            return
        if _is_sequence(node):
            for i, item in enumerate(node):
                if i >= max_array or len(out) >= max_fields:
                    break
                walk(item, f"{prefix}[{i}]", depth + 1)
            return
        children = _child_fields(node)
        for name, value in children:
            if len(out) >= max_fields:
                break
            child_prefix = f"{prefix}.{name}" if prefix else name
            walk(value, child_prefix, depth + 1)

    walk(root, "", 0)
    return out


def parse_path(path: str) -> list[str | int]:
    """Tokenize a dotted/indexed field path into attr names and array indices.

    ``"pose.position.x"`` -> ``["pose", "position", "x"]``;
    ``"data[2]"`` -> ``["data", 2]``; ``"a[0].b[1]"`` -> ``["a", 0, "b", 1]``.
    Raises :class:`ValueError` on a malformed path.
    """
    tokens: list[str | int] = []
    for segment in path.split("."):
        if not segment:
            raise ValueError(f"empty segment in path: {path!r}")
        name, _, rest = segment.partition("[")
        if name:
            tokens.append(name)
        elif not rest:
            raise ValueError(f"empty segment in path: {path!r}")
        # Parse any trailing [i][j]... indices on this segment.
        while rest:
            index_str, sep, rest = rest.partition("]")
            if sep != "]":
                raise ValueError(f"unbalanced '[' in path: {path!r}")
            try:
                tokens.append(int(index_str))
            except ValueError as exc:
                raise ValueError(
                    f"non-integer index {index_str!r} in path: {path!r}"
                ) from exc
            if rest.startswith("["):
                rest = rest[1:]
            elif rest:
                raise ValueError(f"trailing junk {rest!r} in path: {path!r}")
    if not tokens:
        raise ValueError(f"empty path: {path!r}")
    return tokens


def extract_value(root: object, path: str) -> float | None:
    """Resolve *path* against decoded message *root*, as a float or ``None``.

    ``None`` when the path does not resolve (missing attr/key, out-of-range
    index) or the value at the end is not numeric. Never raises for a
    well-formed path that simply does not match the data.
    """
    node: object = root
    for token in parse_path(path):
        if isinstance(token, int):
            if not _is_sequence(node):
                return None
            seq = node
            if token < 0 or token >= len(seq):  # type: ignore[arg-type]
                return None
            node = seq[token]  # type: ignore[index]
        else:
            if isinstance(node, Mapping):
                if token not in node:
                    return None
                node = node[token]
            else:
                if not hasattr(node, token):
                    return None
                node = getattr(node, token)
    if _is_numeric(node):
        return float(node)
    return None
