"""topic_probe.field_introspect is a re-export of the shared library module.

The introspection logic moved to :mod:`kairos_common.field_introspect` (shared
with dora_runner's ``signal_report``); its behaviour is exhaustively tested in
the library. Here we only assert the backward-compatible shim at the old path
exposes the same objects, so topic_probe's call sites keep importing it.
"""

from __future__ import annotations

from types import SimpleNamespace

from kairos_common import field_introspect as lib
from topic_probe import field_introspect as shim


def test_shim_reexports_the_shared_objects() -> None:
    # Same function/constant objects, not copies — one implementation.
    assert shim.iter_numeric_fields is lib.iter_numeric_fields
    assert shim.extract_value is lib.extract_value
    assert shim.parse_path is lib.parse_path
    assert shim.DEFAULT_MAX_ARRAY == lib.DEFAULT_MAX_ARRAY
    assert shim.DEFAULT_MAX_DEPTH == lib.DEFAULT_MAX_DEPTH
    assert shim.DEFAULT_MAX_FIELDS == lib.DEFAULT_MAX_FIELDS


def test_shim_walks_and_extracts_through_the_old_import_path() -> None:
    msg = SimpleNamespace(pose=SimpleNamespace(x=1.5), data=[10.0, 20.0])
    assert shim.iter_numeric_fields(msg) == ["pose.x", "data[0]", "data[1]"]
    assert shim.extract_value(msg, "pose.x") == 1.5
    assert shim.extract_value(msg, "data[1]") == 20.0
