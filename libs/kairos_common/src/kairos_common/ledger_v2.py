"""lifecycle.jsonl v2: the append-only record of what was destroyed or declared.

Contract §5. One JSON object per line at ``<data_dir>/lifecycle.jsonl``, newest
last. Two families of event live here and nothing else:

* **tombstones** — ``capture_discarded`` / ``capture_deleted`` / ``capture_archived``.
  These are written *before* the bytes are touched (§7 step 1, §9-1), so a crash
  can leave the ledger claiming a deletion that has not finished, but never a
  deletion that finished with no record. Only the first direction is recoverable:
  a resume pass finds the event and completes the removal. The other direction
  loses the fact that an operator deliberately discarded data, and a later
  transfer would quietly bring it back.
* **dataset facts** — datasets exist as database rows plus these events (§6). The
  ledger is what lets ``display_index`` stay retired after a member is removed:
  the high-water mark is recoverable from history, so a number is never handed to
  two different recordings.

**Recording events are deliberately absent** (§9-5). Adding a ``capture_started``
kind would make ``start`` depend on this file being writable, and the one thing
that must survive a full disk is the ability to record. :func:`append` rejects
any kind outside :data:`KINDS`, so the invariant cannot be eroded by a later
patch that "just adds one event".

**The ENOSPC escape hatch.** Discarding captures is how an operator frees a full
disk — and a full disk is exactly when the ledger-first rule cannot append, which
would block the discard and leave no way out. So :func:`ensure_slack` reserves a
1 MB file at startup, and :func:`append_with_slack_release` deletes it to buy the
few hundred bytes an append needs. The reservation is only worth making before
the disk fills, which is why it happens at startup rather than on first failure.

Review edits are **not** here: ``record.json`` is authoritative for review state
(§4.1-4), and mirroring it into an append-only file would create a second truth
that can disagree. Pre-v2 lines are not read at all (alpha reset); they are
skipped by schema_version, as are lines that a partial write left unparseable.
"""

from __future__ import annotations

import errno
import json
import logging
import os
import secrets
from pathlib import Path
from typing import Any

from kairos_common.atomic_io import fsync_dir
from kairos_common.ids import new_event_id
from kairos_common.time import utc_now_iso8601

logger = logging.getLogger("kairos")

LEDGER_NAME = "lifecycle.jsonl"
LEDGER_SCHEMA_VERSION = 2

SLACK_NAME = ".ledger-slack"
# Enough for thousands of ledger lines — the point is not capacity but having
# *any* free block to write into once the filesystem reports ENOSPC.
SLACK_BYTES = 1024 * 1024


class LedgerUnreadableError(OSError):
    """The ledger exists but could not be read in full.

    Distinct from "there is no ledger yet" on purpose. An empty history means
    nothing was ever discarded, deleted or archived; an unreadable file means we
    do not know. Since the ledger is what outranks the manifests (§8 rule 3),
    treating the second as the first would rebuild a catalog that quietly
    resurrects every capture an operator destroyed.
    """


# Captures leaving this installation.
CAPTURE_KINDS: frozenset[str] = frozenset(
    {"capture_discarded", "capture_deleted", "capture_archived"}
)
# Tombstones proper: the capture's local bytes are gone for good. ``archived``
# is excluded — the bytes moved somewhere the operator chose and the capture is
# still real, so it must not be normalised into "this never existed" (§8 rule 3).
TOMBSTONE_KINDS: frozenset[str] = frozenset({"capture_discarded", "capture_deleted"})

DATASET_KINDS: frozenset[str] = frozenset(
    {
        "dataset_created",
        "dataset_member_added",
        "dataset_member_removed",
        "dataset_deleted",
    }
)

KINDS: frozenset[str] = CAPTURE_KINDS | DATASET_KINDS

# Envelope fields the ledger owns. A payload may not set them: a caller that
# could supply its own ``event_id`` could forge idempotency, and one that could
# supply ``at`` could rewrite history.
_ENVELOPE_KEYS: frozenset[str] = frozenset(
    {"schema_version", "event_id", "source_instance_id", "kind", "capture_id", "at"}
)

# Descriptive fields ``capture_archived`` carries beyond the destination
# (rev.2.1). Archiving deletes the local copy, so this event is the *only*
# surviving description of the capture — a rebuild after the database is lost
# has nothing else to reconstruct the row from. They are optional rather than
# required because §9-1 puts this append before the archive proceeds: a capture
# whose message_count was never determined must still be archivable.
_ARCHIVE_OPTIONAL_FIELDS: dict[str, type | tuple[type, ...]] = {
    "run_id": str,
    "operator": str,
    "task": str,
    "bytes": int,
    "message_count": int,
}


def ledger_path(data_dir: str | Path) -> Path:
    return Path(data_dir) / LEDGER_NAME


def slack_path(data_dir: str | Path) -> Path:
    return Path(data_dir) / SLACK_NAME


def build_event(
    kind: str,
    *,
    instance_id: str,
    capture_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate and stamp one event without writing it.

    Split out from :func:`append` so a caller can mint the ``event_id`` first —
    §7's resume path replays a deletion by event_id, and idempotency needs the id
    to exist before the side effects do.
    """
    if kind not in KINDS:
        # Includes any recording-lifecycle kind someone tries to add (§9-5).
        raise ValueError(f"unknown ledger kind {kind!r}; allowed: {sorted(KINDS)}")
    if not instance_id:
        raise ValueError("instance_id is required: a ledger line must say who wrote it")
    if kind in CAPTURE_KINDS and not capture_id:
        raise ValueError(f"{kind} requires a capture_id")

    payload = dict(payload or {})
    collisions = _ENVELOPE_KEYS & payload.keys()
    if collisions:
        raise ValueError(f"payload may not set envelope fields: {sorted(collisions)}")
    if kind == "capture_archived":
        _validate_archive_payload(payload)

    event: dict[str, Any] = {
        "schema_version": LEDGER_SCHEMA_VERSION,
        "event_id": new_event_id(),
        "source_instance_id": instance_id,
        "kind": kind,
        "capture_id": capture_id,
        "at": utc_now_iso8601(),
    }
    event.update(payload)
    return event


def _validate_archive_payload(payload: dict[str, Any]) -> None:
    """Check a ``capture_archived`` payload (§6, rev.2.1).

    ``destination`` is required — an archive event that does not say where the
    bytes went answers none of the questions it exists for. The descriptive
    fields are optional but type-checked, because a rebuild will copy them
    straight onto a capture row and a string where an int belongs would surface
    as a broken catalog long after the archive itself.
    """
    destination = payload.get("destination")
    if not isinstance(destination, str) or not destination:
        raise ValueError("capture_archived requires a non-empty destination")
    for key, expected in _ARCHIVE_OPTIONAL_FIELDS.items():
        value = payload.get(key)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, expected):
            raise ValueError(
                f"capture_archived {key} must be "
                f"{getattr(expected, '__name__', expected)} or absent: {value!r}"
            )


def append(
    data_dir: str | Path,
    kind: str,
    *,
    instance_id: str,
    capture_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Append one event durably; return the event as written.

    Raises ``OSError``. Every kind here is fatal on failure (§5): each one is
    about to be followed by an irreversible act, and a ledger line that was
    buffered but not persisted is exactly the state where the act survives the
    crash and the record of it does not.

    ``ValueError`` for an unknown kind or a payload that collides with the
    envelope — a programming error, not a runtime condition.
    """
    event = build_event(
        kind, instance_id=instance_id, capture_id=capture_id, payload=payload
    )
    write_event(data_dir, event)
    return event


def write_event(data_dir: str | Path, event: dict[str, Any]) -> None:
    """Append an already-built *event*, with the §5 fsync discipline."""
    path = ledger_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(event, ensure_ascii=False) + "\n"
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line)
        handle.flush()
        os.fsync(handle.fileno())
    # The file's own fsync does not persist the directory ENTRY when this very
    # call created the ledger.
    fsync_dir(path.parent)


def read_all(data_dir: str | Path, *, strict: bool = True) -> list[dict[str, Any]]:
    """Every v2 event, oldest first. Missing file = no history.

    Individual lines that do not parse are skipped rather than fatal, and that
    is load bearing twice over: a write that hit ENOSPC mid-line leaves a
    truncated tail that must not make the whole ledger unreadable, and pre-v2
    lines (a different shape entirely) must not be misread as v2 events with
    missing fields.

    Failing to read the **file** is a different matter and raises
    :class:`LedgerUnreadableError` by default. A permission error or a bad
    sector would otherwise be indistinguishable from "nothing was ever
    deleted", and every consumer here treats that answer as authoritative.
    Pass ``strict=False`` only where a missing history genuinely degrades
    gracefully — never in a rebuild.
    """
    path = ledger_path(data_dir)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        # No ledger yet is a real, complete answer: nothing has ever left.
        return []
    except (OSError, UnicodeDecodeError) as exc:
        if strict:
            raise LedgerUnreadableError(f"{path} could not be read: {exc}") from exc
        logger.warning("lifecycle ledger unreadable", extra={"error": str(exc)})
        return []

    events: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict):
            continue
        if record.get("schema_version") != LEDGER_SCHEMA_VERSION:
            continue
        if record.get("kind") not in KINDS:
            continue
        events.append(record)
    return events


def tombstones(data_dir: str | Path) -> dict[str, dict[str, Any]]:
    """capture_id → the latest ``discarded``/``deleted`` event for it.

    The override in §8 rule 3: whatever a manifest on disk still claims, a
    capture named here was deliberately destroyed. Latest wins, so a capture
    discarded and later deleted reports its final fate.
    """
    latest: dict[str, dict[str, Any]] = {}
    for event in read_all(data_dir):
        if event.get("kind") not in TOMBSTONE_KINDS:
            continue
        capture_id = event.get("capture_id")
        if isinstance(capture_id, str) and capture_id:
            latest[capture_id] = event
    return latest


def archive_events(data_dir: str | Path) -> dict[str, dict[str, Any]]:
    """capture_id → the latest ``capture_archived`` event ("where did it go?").

    Separate from :func:`tombstones` on purpose: an archived capture still
    exists, just not here, so it must not be normalised into a deletion.
    """
    latest: dict[str, dict[str, Any]] = {}
    for event in read_all(data_dir):
        if event.get("kind") != "capture_archived":
            continue
        capture_id = event.get("capture_id")
        if isinstance(capture_id, str) and capture_id:
            latest[capture_id] = event
    return latest


def dataset_events(data_dir: str | Path) -> list[dict[str, Any]]:
    """Every dataset event, oldest first — the history datasets are rebuilt from.

    Order is the whole value: ``member_added`` then ``member_removed`` for the
    same ``display_index`` is what says the number is retired rather than free.
    """
    return [event for event in read_all(data_dir) if event.get("kind") in DATASET_KINDS]


def ensure_slack(data_dir: str | Path) -> Path:
    """Reserve the 1 MB ENOSPC slack file, if it is not already there.

    Call at startup, before the disk can fill. Returns the path; raises
    ``OSError`` if the reservation cannot be made — which on a startup that
    found the disk already full is worth reporting, not hiding.

    The new reservation is built under a temp name and renamed into place, so a
    failure part-way through leaves whatever slack already existed intact. The
    obvious alternative — opening the real path for writing — truncates first,
    and a failure after that point would shrink the reserve at exactly the
    moment the disk is too full to rebuild it.
    """
    path = slack_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if path.stat().st_size >= SLACK_BYTES:
            return path
    except FileNotFoundError:
        pass

    tmp = path.parent / f"{SLACK_NAME}.{os.getpid()}-{secrets.token_hex(4)}.tmp"
    try:
        fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        try:
            _allocate(fd, SLACK_BYTES)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    fsync_dir(path.parent)
    return path


def _allocate(fd: int, size: int) -> None:
    """Reserve *size* bytes of real blocks on *fd*.

    ``posix_fallocate`` asks the filesystem for the blocks directly, which is
    both cheaper than writing a megabyte of zeros and, more importantly, the
    only version that is honest about failure: it returns ENOSPC now rather
    than appearing to succeed against a sparse file that reserves nothing and
    would therefore free nothing when released.
    """
    try:
        os.posix_fallocate(fd, 0, size)
        return
    except AttributeError:  # pragma: no cover - not Linux
        pass
    except OSError as exc:  # pragma: no cover - filesystem without fallocate
        if exc.errno not in (errno.EOPNOTSUPP, errno.EINVAL):
            raise  # ENOSPC and friends are the answer, not a reason to retry
    # Fall back to writing the bytes, which reserves blocks the slow way.
    written = 0
    chunk = b"\0" * 65536
    while written < size:
        written += os.write(fd, chunk[: min(len(chunk), size - written)])


def release_slack(data_dir: str | Path) -> bool:
    """Delete the slack file to free its blocks. ``False`` = there was none."""
    path = slack_path(data_dir)
    try:
        path.unlink()
    except FileNotFoundError:
        return False
    fsync_dir(path.parent)
    return True


def append_with_slack_release(
    data_dir: str | Path,
    kind: str,
    *,
    instance_id: str,
    capture_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """:func:`append`, retried once after freeing the slack file on ENOSPC.

    The discard and delete paths use this. A full disk is the situation an
    operator resolves *by discarding captures*, so the append that must precede
    the discard cannot be allowed to fail for want of a few hundred bytes.

    If there was no slack file to release, the original ``OSError`` propagates
    unchanged — retrying without having freed anything would only produce the
    same failure with a more confusing traceback.
    """
    try:
        return append(
            data_dir,
            kind,
            instance_id=instance_id,
            capture_id=capture_id,
            payload=payload,
        )
    except OSError as exc:
        if exc.errno != errno.ENOSPC:
            raise
        if not release_slack(data_dir):
            raise
        logger.warning(
            "ledger append hit ENOSPC; released slack and retrying",
            extra={"kind": kind, "capture_id": capture_id},
        )
    # Outside the handler so a second ENOSPC is reported on its own terms
    # rather than chained behind the first.
    return append(
        data_dir, kind, instance_id=instance_id, capture_id=capture_id, payload=payload
    )
