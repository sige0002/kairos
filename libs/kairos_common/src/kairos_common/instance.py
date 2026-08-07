"""``instance.json``: this installation's identity, minted once and never again.

Contract §1. ``source_instance_id`` is what a replica row is keyed by — it is the
answer to "which machine holds a copy of this capture". Every capture ever
recorded here carries it in its manifest, so regenerating the id would not create
a new installation, it would orphan every replica row and every sidecar that
still names the old one. The file is therefore write-once: read it if it is
there, create it only if it is not, and refuse to guess if it is unreadable.

**Concurrent first start.** Orchestrator, recorder and dora_runner can come up
together on a fresh data_dir and all find no instance.json. A plain atomic write
would let each of them win in turn, and a service that had already read the first
id would keep using an id no longer on disk. So creation goes through ``os.link``,
which fails with ``EEXIST`` instead of overwriting: the loser deletes its temp
file and re-reads the winner's id. The link still happens *after* the temp file is
fully written and fsynced, so the name never appears with partial content —
which ``O_CREAT|O_EXCL`` on the destination itself could not promise.

**A corrupt file is fatal, not a reason to re-mint.** A 0-byte instance.json
after power loss looks exactly like "no instance yet", and silently minting a
replacement is the one outcome that cannot be undone. :class:`CorruptInstanceError`
stops startup instead, leaving an operator to restore or deliberately delete it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from kairos_common.atomic_io import create_exclusive_json
from kairos_common.ids import new_instance_id
from kairos_common.time import utc_now_iso8601

INSTANCE_FILENAME = "instance.json"
INSTANCE_SCHEMA_VERSION = 2


class CorruptInstanceError(RuntimeError):
    """``instance.json`` exists but cannot be trusted to name this installation."""


@dataclass(frozen=True)
class InstanceInfo:
    """The identity of one kairos installation (one ``data_dir``)."""

    instance_id: str
    created_at: str
    schema_version: int = INSTANCE_SCHEMA_VERSION

    def to_json(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "instance_id": self.instance_id,
            "created_at": self.created_at,
        }


def instance_path(data_dir: str | Path) -> Path:
    return Path(data_dir) / INSTANCE_FILENAME


def _parse(raw: bytes, path: Path) -> InstanceInfo:
    if not raw.strip():
        raise CorruptInstanceError(f"{path} is empty (0 bytes)")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise CorruptInstanceError(f"{path} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise CorruptInstanceError(f"{path} is not a JSON object")
    instance_id = data.get("instance_id")
    if not isinstance(instance_id, str) or not instance_id:
        raise CorruptInstanceError(f"{path} has no instance_id")
    created_at = data.get("created_at")
    return InstanceInfo(
        instance_id=instance_id,
        created_at=created_at if isinstance(created_at, str) else "",
        schema_version=(
            data["schema_version"]
            if isinstance(data.get("schema_version"), int)
            else INSTANCE_SCHEMA_VERSION
        ),
    )


def read_instance(data_dir: str | Path) -> InstanceInfo | None:
    """The recorded identity, or ``None`` if this data_dir has none yet.

    Raises :class:`CorruptInstanceError` when the file exists but is unusable —
    never ``None``, which the caller would read as "mint a new one".
    """
    path = instance_path(data_dir)
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise CorruptInstanceError(f"{path} is unreadable: {exc}") from exc
    return _parse(raw, path)


def load_or_create_instance(data_dir: str | Path) -> InstanceInfo:
    """Return this installation's identity, minting it on first start only.

    Safe to call from every service at startup and from several at once: exactly
    one id is ever created for a ``data_dir``, and every caller returns it.
    """
    existing = read_instance(data_dir)
    if existing is not None:
        return existing

    path = instance_path(data_dir)
    info = InstanceInfo(instance_id=new_instance_id(), created_at=utc_now_iso8601())
    if create_exclusive_json(path, info.to_json()):
        return info
    # Someone else claimed the name between our read and our link. Their id is
    # the installation's id; ours was never visible to anyone.
    winner = read_instance(data_dir)
    if winner is None:  # pragma: no cover - the file existed a moment ago
        raise CorruptInstanceError(f"{path} vanished during creation")
    return winner
