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
import re
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

# What ``hashlib.sha256().hexdigest()`` produces. Shared with
# ``capture_sidecars`` by convention rather than by import: this module is the
# ledger's own validation and must not depend on the sidecar schema.
_SHA256_HEX = re.compile(r"\A[0-9a-f]{64}\Z")


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
    {
        "capture_discarded",
        "capture_deleted",
        "capture_archived",
        # A human letting a validation failure through into a dataset. Not a
        # tombstone — the capture stays — but it belongs here for the same
        # reason the tombstones do: it is the only durable record of a
        # judgement that overrode the system's own verdict.
        "capture_validation_overridden",
    }
)
# Tombstones proper: the capture's local bytes are gone for good. ``archived``
# is excluded — the bytes moved somewhere the operator chose and the capture is
# still real, so it must not be normalised into "this never existed" (§8 rule 3).
TOMBSTONE_KINDS: frozenset[str] = frozenset({"capture_discarded", "capture_deleted"})

DATASET_KINDS: frozenset[str] = frozenset(
    {
        "dataset_created",
        "dataset_updated",
        "dataset_member_added",
        "dataset_member_removed",
        "dataset_deleted",
        # The terminal transition (§6.x): a dataset leaving this installation.
        # ``started`` freezes the member set and says where the bytes are going;
        # ``dataset_archived`` seals the run. Neither is a tombstone — like
        # ``capture_archived``, the data still exists, just not here.
        "dataset_archive_started",
        "dataset_archived",
        # A LeRobot export completed (§6.2). NON-terminal and not a tombstone:
        # the dataset is untouched and the artifact is a derivative. Recorded
        # so "what left this installation as training data, built from which
        # captures, with which config" survives the exports/ folder itself
        # being deleted or carried away. Replay ignores it (no row to rebuild —
        # the output tree's own conversion_log.json is its source of truth).
        "dataset_exported",
    }
)

# Collect batches (§8). A batch's row is the only place its project, operator,
# target and daily number ever lived, so without these lines "delete kairos.db
# and restart" silently loses every batch while the recordings that belonged to
# them come back still naming one.
#
# Three kinds rather than one, for the same reason datasets have three: what a
# batch IS at creation and what happens to it later are different facts.
# ``batch_created`` carries no status — every batch is active when it is
# created, so a status there would say nothing and a replay that believed it
# would reconstruct a finished batch as an open one.
BATCH_KINDS: frozenset[str] = frozenset(
    {
        "batch_created",
        # The full mutable label set after an edit, like ``dataset_updated``:
        # carrying the complete set means replay order alone reconstructs it.
        "batch_updated",
        # The terminal transition: status, why, and when.
        "batch_ended",
    }
)

KINDS: frozenset[str] = CAPTURE_KINDS | DATASET_KINDS | BATCH_KINDS

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
    # Present when the archive was one member of a dataset archive (§6.x): the
    # event then also answers "which sealed dataset is this recording NNN of?".
    # Optional because a per-capture archive has no dataset to name.
    "dataset_id": str,
    "membership_id": str,
    "display_index": int,
}

# ``files`` is validated separately from the scalars above because its shape,
# not just its type, is what makes it useful: one record per archived file,
# ``{"path", "size", "sha256"}`` — the same vocabulary
# ``object_manifest.json`` uses for the digest (§3.2), so an archived capture
# and a local one describe their bytes identically.
#
# This is what lets the ledger ALONE audit an archive. Once the source is
# deleted the manifest goes with it, and without per-file hashes the event can
# say only "N bytes went to /mnt/nas" — which cannot answer "is the copy still
# intact?" years later. Optional like the rest: §9-1 puts the append before the
# archive proceeds, so an archive must remain possible even if hashing did not.
_ARCHIVE_FILE_FIELDS: dict[str, type] = {"path": str, "size": int, "sha256": str}


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
    elif kind == "dataset_updated":
        _validate_dataset_updated_payload(payload)
    elif kind == "dataset_archive_started":
        _validate_dataset_archive_started_payload(payload)
    elif kind == "dataset_archived":
        _validate_dataset_archived_payload(payload)
    elif kind == "dataset_exported":
        _validate_dataset_exported_payload(payload)
    elif kind in BATCH_KINDS:
        _validate_batch_payload(kind, payload)

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


def _validate_batch_payload(kind: str, payload: dict[str, Any]) -> None:
    """Every batch line must say which batch it is about.

    A batch event is the only record of that batch, so one that cannot be
    attributed is not a partial fact — it is an unattributable one, and the
    replay would have to drop it silently.
    """
    batch_id = payload.get("batch_id")
    if not isinstance(batch_id, str) or not batch_id:
        raise ValueError(f"{kind} requires a non-empty batch_id")
    if kind == "batch_created" and "status" in payload:
        # Status is not a creation fact; ``batch_ended`` carries it. Refusing
        # here stops a future caller from reintroducing the stale-status replay
        # this split exists to prevent.
        raise ValueError("batch_created may not carry status; use batch_ended")


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
    _validate_archive_files(payload.get("files"))


def _validate_archive_files(files: Any) -> None:
    """Check the optional per-file digest list. Raises ``ValueError``.

    Validated field by field rather than waved through as "a list", because
    this list is an audit record that outlives everything else about the
    capture: a malformed entry is discovered when someone is trying to prove an
    archived recording is intact, which is the worst possible moment to find
    out the hashes were never usable.
    """
    if files is None:
        return
    if not isinstance(files, list):
        raise ValueError(f"capture_archived files must be a list or absent: {files!r}")
    for entry in files:
        if not isinstance(entry, dict):
            raise ValueError(f"capture_archived files[] must be objects: {entry!r}")
        for key, expected in _ARCHIVE_FILE_FIELDS.items():
            value = entry.get(key)
            if isinstance(value, bool) or not isinstance(value, expected):
                raise ValueError(
                    f"capture_archived files[].{key} must be "
                    f"{expected.__name__}: {entry!r}"
                )
        if entry["size"] < 0:
            raise ValueError(f"capture_archived files[].size must be >= 0: {entry!r}")
        if not _SHA256_HEX.match(entry["sha256"]):
            # Lowercase hex specifically, matching §3.2's digest input: an
            # uppercase spelling of the same hash would compare unequal against
            # a manifest that recorded it the canonical way.
            raise ValueError(
                f"capture_archived files[].sha256 must be 64 lowercase hex "
                f"characters: {entry!r}"
            )


def _validate_dataset_exported_payload(payload: dict[str, Any]) -> None:
    """Check a ``dataset_exported`` payload (§6.2): a completed LeRobot export.

    ``output`` is data-root RELATIVE (``exports/<name>``) — an absolute path
    would bake one mount point's view into a record that outlives every mount.
    ``captures`` is the input snapshot: without it the line could not answer
    "built from which recordings" once the dataset's membership changes.
    """
    for key in ("dataset_id", "export_id", "output"):
        value = payload.get(key)
        if not isinstance(value, str) or not value:
            raise ValueError(f"dataset_exported requires a non-empty {key}: {value!r}")
    output = payload["output"]
    if output.startswith("/"):
        raise ValueError(
            f"dataset_exported output must be data-root relative: {output!r}"
        )
    captures = payload.get("captures")
    if not isinstance(captures, list) or not captures:
        raise ValueError("dataset_exported requires a non-empty captures snapshot")
    for entry in captures:
        if not isinstance(entry, dict) or not entry.get("capture_id"):
            raise ValueError(
                f"dataset_exported captures[] entries need a capture_id: {entry!r}"
            )


def _validate_dataset_updated_payload(payload: dict[str, Any]) -> None:
    """Check a ``dataset_updated`` payload (§6): a label change.

    Carries the COMPLETE new label set, not a diff: a replay applies events in
    order and the latest one must be able to state the labels on its own,
    without reconstructing them from every rename that came before.
    """
    for key in ("dataset_id", "name"):
        value = payload.get(key)
        if not isinstance(value, str) or not value:
            raise ValueError(f"dataset_updated requires a non-empty {key}: {value!r}")
    for key in ("operator", "task"):
        value = payload.get(key)
        if value is not None and not isinstance(value, str):
            raise ValueError(f"dataset_updated {key} must be str or absent: {value!r}")


def _validate_dataset_archive_started_payload(payload: dict[str, Any]) -> None:
    """Check a ``dataset_archive_started`` payload (§6.x).

    Self-contained on purpose, like ``dataset_member_added``: this one event
    must be able to re-create the dataset row *and* every member row, because
    after the archive completes the members' bytes are gone and a truncated
    ledger head may have lost the ``dataset_created`` line. ``members`` is
    therefore required and fully shape-checked — it is the frozen set the
    resume path replays, and a malformed entry would surface as a hole in a
    dataset that can no longer be rebuilt any other way.
    """
    for key in ("dataset_id", "destination", "dataset_name"):
        value = payload.get(key)
        if not isinstance(value, str) or not value:
            raise ValueError(
                f"dataset_archive_started requires a non-empty {key}: {value!r}"
            )
    for key in ("operator", "task", "reason"):
        value = payload.get(key)
        if value is not None and not isinstance(value, str):
            raise ValueError(
                f"dataset_archive_started {key} must be str or absent: {value!r}"
            )
    _validate_archive_mode(payload, "dataset_archive_started")
    members = payload.get("members")
    if not isinstance(members, list) or not members:
        raise ValueError(
            f"dataset_archive_started requires a non-empty members list: {members!r}"
        )
    for entry in members:
        if not isinstance(entry, dict):
            raise ValueError(
                f"dataset_archive_started members[] must be objects: {entry!r}"
            )
        for key in ("membership_id", "capture_id"):
            value = entry.get(key)
            if not isinstance(value, str) or not value:
                raise ValueError(
                    f"dataset_archive_started members[].{key} must be a "
                    f"non-empty str: {entry!r}"
                )
        index = entry.get("display_index")
        if isinstance(index, bool) or not isinstance(index, int) or index < 1:
            raise ValueError(
                f"dataset_archive_started members[].display_index must be a "
                f"positive int: {entry!r}"
            )


def _validate_dataset_archived_payload(payload: dict[str, Any]) -> None:
    """Check a ``dataset_archived`` payload (§6.x).

    The terminal seal. ``manifest_sha256`` is the hash of the
    ``dataset_manifest.json`` the run left at the destination — recorded here
    so the ledger alone can later prove the manifest was not altered after the
    seal. Optional like the archive digests: the seal must not be blocked by a
    hash that could not be computed.
    """
    for key in ("dataset_id", "destination"):
        value = payload.get(key)
        if not isinstance(value, str) or not value:
            raise ValueError(f"dataset_archived requires a non-empty {key}: {value!r}")
    if payload.get("dataset_name") is not None and not isinstance(
        payload["dataset_name"], str
    ):
        raise ValueError(
            f"dataset_archived dataset_name must be str or absent: "
            f"{payload['dataset_name']!r}"
        )
    for key in ("member_total", "bytes_total"):
        value = payload.get(key)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(
                f"dataset_archived {key} must be a non-negative int or absent: "
                f"{value!r}"
            )
    manifest_sha256 = payload.get("manifest_sha256")
    if manifest_sha256 is not None and (
        not isinstance(manifest_sha256, str) or not _SHA256_HEX.match(manifest_sha256)
    ):
        raise ValueError(
            f"dataset_archived manifest_sha256 must be 64 lowercase hex "
            f"characters or absent: {manifest_sha256!r}"
        )
    _validate_archive_mode(payload, "dataset_archived")


def _validate_archive_mode(payload: dict[str, Any], kind: str) -> None:
    """``mode`` is ``copy`` (sources kept) or ``move`` (sources removed).

    Optional for compatibility with events written before copy mode existed —
    an absent mode reads as ``move``, which is what those runs did.
    """
    mode = payload.get("mode")
    if mode is not None and mode not in ("copy", "move"):
        raise ValueError(f"{kind} mode must be 'copy', 'move' or absent: {mode!r}")


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

    Two kinds of line are skipped, both because they are well-formed and say so:
    pre-v2 lines (a different shape entirely, which must not be misread as v2
    events with missing fields) and kinds this version does not know.

    A line that does not parse at all is skipped ONLY where it can be a write
    that never completed — see the torn-tail note below. Anywhere else it was a
    whole, fsynced record until something changed it, so it raises
    :class:`LedgerUnreadableError`: silently dropping it would state "nothing
    was ever deleted" about whatever it said, and §5 makes that answer
    authoritative. Failing to read the **file** raises the same way, for the
    same reason.

    **Every caller must handle** :class:`LedgerUnreadableError`. This function
    raising is not the exceptional path it used to be — a damaged line reaches
    it, and a damaged line is an ordinary consequence of someone editing the
    file. An unguarded call in a request handler is a bare 500 with no error
    code; an unguarded call anywhere else is a traceback where a refusal
    belonged.

    ``strict=False`` returns **the events that did parse** and logs which line
    was dropped. The result is explicitly INCOMPLETE and must never be used to
    decide whether something was destroyed or whether a number was issued: a
    tombstone that is missing reads as "this was never deleted", which is how a
    destroyed capture comes back, and a missing ``dataset_updated`` re-issues a
    retired index. Use it only where the answer is shown rather than acted on —
    a status column that says "no archive recorded" for one row is a wrong
    pixel; the same gap in a rebuild or an index reclaim is data loss.

    Returning the partial list rather than ``[]`` is deliberate, and it is the
    safer of the two: ``[]`` is indistinguishable from a ledger where nothing
    ever happened, which for tombstones is the maximally destructive reading.
    Fewer facts beats zero facts; neither is authoritative, and ``strict=True``
    is what authoritative means here.
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
    lines = text.splitlines()
    # Which line, if any, may legitimately be half-written. An append is one
    # ``line + "\n"`` to a file opened O_APPEND, so a write that died mid-line
    # leaves its partial bytes at the END of the file with no newline after
    # them. That is what this forgives, and the newline test is the whole of
    # it: without it a hand-edited LAST line — the most recent tombstone, the
    # likeliest thing an operator touches — is silently dropped again.
    #
    # "At the end of the file" is not the same as "the last line forever".
    # ``append_with_slack_release`` retries after ENOSPC, and O_APPEND puts the
    # retry's bytes straight after the torn ones, on the same line, with a
    # newline of its own. The merged line then parses as neither record and is
    # NOT forgiven — correctly: by then a completed, fsynced record is
    # unreadable, which is the case this function must refuse rather than skip.
    torn_tail = len(lines) - 1 if lines and not text.endswith("\n") else -1
    for index, raw in enumerate(lines):
        line = raw.strip()
        if not line:
            continue
        record: Any = None
        try:
            record = json.loads(line)
            damage = None if isinstance(record, dict) else "is not a JSON object"
        except ValueError:
            damage = "does not parse as JSON"
        if damage is not None:
            if index == torn_tail:
                # The append never completed, so the event never happened and
                # the history is intact without it.
                continue
            # It did complete, and the line is gone anyway. What it said is
            # unknowable, and the one thing it is most likely to have said is
            # that a capture was destroyed — which this function returning
            # without it would state as "nothing was ever deleted". §5 makes
            # that answer authoritative, so it must not be guessed.
            message = (
                f"{path} line {index + 1} {damage}, and it is not a truncated "
                "final write. A completed append is durable, so this was a "
                "whole record that has been damaged since — possibly the "
                "record of something irreversible."
            )
            if strict:
                raise LedgerUnreadableError(message)
            # Degraded, not empty: keep reading and hand back what survives.
            # Discarding the readable events too would answer "nothing ever
            # happened", which for tombstones is the most destructive reading
            # available — see the strict=False note in the docstring.
            logger.warning("lifecycle ledger damaged", extra={"error": message})
            continue
        if record.get("schema_version") != LEDGER_SCHEMA_VERSION:
            # Pre-v2 lines and anything a future version writes: a different
            # shape, deliberately not read as a v2 event with missing fields.
            continue
        if record.get("kind") not in KINDS:
            # A kind this version does not know — forward compatibility, not
            # damage: the line is well-formed and says so.
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


def batch_events(data_dir: str | Path) -> list[dict[str, Any]]:
    """Every batch event, oldest first — the history batches are rebuilt from.

    Order matters here too: ``batch_created`` then ``batch_updated`` for the
    same batch is what says the later labels win, and ``batch_ended`` after
    both is what says it is no longer open.
    """
    return [event for event in read_all(data_dir) if event.get("kind") in BATCH_KINDS]


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
