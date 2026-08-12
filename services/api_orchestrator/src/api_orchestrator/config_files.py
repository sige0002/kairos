# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Reading and writing the operator-editable YAML config files.

The Settings screens let an operator edit ``recording/default.yaml`` and
``monitoring/alerts.yaml`` in place. Two mechanics that job needs live here,
away from the HTTP layer that decides what to do about them:

:func:`atomic_write_yaml` — a save must never leave a half-written config where
a service will read one, and must survive power loss rather than only a
concurrent reader. It serialises the mapping and hands the bytes to
``kairos_common.atomic_io``, so an edited config gets the same
temp → fsync → replace → fsync-dir guarantee as every capture sidecar.

:class:`StrictSafeLoader` — PyYAML silently keeps the LAST of two identical
mapping keys, so text that visibly contains two rules parses to one and saves
with no error. Refusing to load such a file is what keeps the operator's own
text from being the only place the dropped rule ever existed.

The loader stays orchestrator-local rather than becoming a ``kairos_common``
primitive: refusing a duplicate key is a decision about THIS editor's contract
with the operator, not a general YAML rule.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from kairos_common.atomic_io import atomic_write_text


def atomic_write_yaml(path: Path, data: dict[str, Any]) -> None:
    """Write *data* to *path* as YAML, durably and atomically.

    Creates the parent dir if needed. Serialising first and writing once means
    the crash-safe path (temp file in the same directory → fsync → ``os.replace``
    → fsync the directory) is the shared one rather than a second copy of it;
    on any failure the temp file is removed and the original is left untouched.
    Raises ``OSError`` if the file cannot be persisted — the caller turns that
    into a 500 rather than reporting a save that did not happen.
    """
    atomic_write_text(path, yaml.safe_dump(data, sort_keys=False, allow_unicode=True))


class DuplicateYamlKey(yaml.constructor.ConstructorError):
    """A mapping key written twice in the operator's YAML."""

    def __init__(self, key: Any, line: int) -> None:
        super().__init__(None, None, f"found duplicate key {key!r}", None)
        self.key = key
        self.line = line


class StrictSafeLoader(yaml.SafeLoader):
    """SafeLoader that REFUSES duplicate mapping keys.

    PyYAML silently keeps the LAST occurrence, so YAML that visibly contains two
    rules parses to one and saves with no error — the operator's own text is the
    only place the dropped rule ever existed. Refusing the save is the honest
    outcome; nothing valid is lost, since no correct alerts.yaml carries a
    duplicate key and the canonical writer above never emits one.

    Duplicates are detected on the keys AS WRITTEN, before ``flatten_mapping``
    expands ``<<`` merges — an anchor legitimately overriding an inherited field
    is a different thing from the same key typed twice, and must stay allowed.
    """

    #: ``<<`` — consumed by ``flatten_mapping`` in the base loader and never
    #: constructed as a key, so it must be stepped over rather than resolved.
    _MERGE_TAG = "tag:yaml.org,2002:merge"

    def construct_mapping(self, node: Any, deep: bool = False) -> dict[Any, Any]:
        seen: set[Any] = set()
        for key_node, _value_node in node.value:
            if key_node.tag == self._MERGE_TAG:
                continue
            key = self.construct_object(key_node, deep=deep)
            try:
                duplicate = key in seen
            except TypeError:
                continue  # unhashable key: the base loader reports it
            if duplicate:
                raise DuplicateYamlKey(key, key_node.start_mark.line + 1)
            seen.add(key)
        return super().construct_mapping(node, deep=deep)
