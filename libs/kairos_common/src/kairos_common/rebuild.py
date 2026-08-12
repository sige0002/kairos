# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Reconstructing the catalog from what is actually on disk.

Contract §8. ``kairos.db`` is an index, not the truth: delete it and restarting
must bring the catalog back, because the sidecars beside each capture and the
lifecycle ledger together hold everything the database caches. This module is the
translation — filesystem and ledger in, normalized rows out.

Everything here is **pure**: it reads, it decides, it returns. No database
writes, no repairs, no deletions. The orchestrator wires the result into SQLite
inside its own transaction, and that separation is what makes the rules testable
against a directory tree instead of a live stack, and what lets the §9-3
threshold guard inspect a proposed change *before* any of it is applied.

The normalizations that carry the most weight:

**A capture that was recording when the process died is ``interrupted``, not
``recording``** (rule 2). A ``recording`` row after a restart is a lie that no
later event will correct — nothing is writing to it any more. It becomes
``failed`` instead when neither ``metadata.yaml`` nor any ``*.mcap`` is there,
matching the recorder's own finalise judgement so a crash and a clean stop
classify the same bag identically.

**The ledger outranks the manifest** (rule 3). If an operator discarded a capture
and the machine died before the directory was moved to ``.trash``, the manifest
still describes a healthy recording. Believing it would resurrect data somebody
deliberately destroyed, so a tombstone wins and the leftover directory is
reported for the delete-resume pass.

**A corrupt manifest is reported, never dropped** (rule 4). "Unparseable" and
"absent" are the same thing to a naive scan, and treating them alike lets one
bad write erase a capture from the catalog silently. Corrupt entries come back in
their own list *and* as a replica row in state ``corrupt``, so the row set alone
says the bytes are here and their description is broken. They deliberately have
**no** ``captures`` row — the manifest was the only thing that could say what the
capture is, so a row would be fabricated — which means a caller joining captures
to replicas will find corrupt replicas unmatched. That set is exactly what wants
repairing.

**An archived capture is still a capture** (§6). Archiving copies the bytes out,
verifies them and then deletes the source, so a successful archive leaves nothing
under ``objects/``. The ``capture_archived`` event is all that remains, and a row
is reconstructed from it — otherwise the capture would silently vanish from the
catalog on the next rebuild. A capture that was archived and *later* discarded or
deleted takes the tombstone, which is the later intent.

**Review state comes from ``record.json``** (rule 5 / §4.1-4). Pass
``known_revisions`` to compare against what the database already holds: a sidecar
at or ahead of the DB wins, and the reverse direction is *reported*, not
corrected, because a DB ahead of its sidecar means something wrote review state
without going through §4.1 and quietly overwriting either side would hide it.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field, replace
from enum import StrEnum
from pathlib import Path
from typing import Any

from kairos_common import ledger_v2
from kairos_common.capture_sidecars import (
    FAILED_START_SUFFIX,
    OBJECT_MANIFEST_FILENAME,
    ROSBAG2_METADATA_FILENAME,
    UNFINALIZED_STATES,
    CaptureState,
    DigestState,
    ObjectManifestV2,
    ReviewStatus,
    SidecarStatus,
    objects_dir,
    read_object_manifest,
    read_quick_check,
    read_record,
    trash_dir,
)
from kairos_common.ids import is_uuid7


class ReplicaState(StrEnum):
    """Where one installation's copy of a capture stands (§8).

    ``missing_unmanaged`` is the one that matters most: it is what an external
    ``rm -rf`` produces. Deleting bytes behind kairos's back is not a deletion
    (§9-2) — the capture row stays, and the replica says the copy vanished
    without anyone asking, so it surfaces as a warning instead of looking like
    a completed cleanup.
    """

    present_unverified = "present_unverified"
    present_verified = "present_verified"
    trashed = "trashed"
    absent_managed = "absent_managed"
    missing_unmanaged = "missing_unmanaged"
    corrupt = "corrupt"


@dataclass(frozen=True)
class CaptureRow:
    """One normalized ``captures`` row, ready for the orchestrator to upsert.

    Timestamps the database owns (``created_at`` / ``updated_at``) are absent by
    design: they describe when the row was written, which a rebuild is in no
    position to reconstruct.
    """

    capture_id: str
    state: str
    run_id: str | None = None
    source_instance_id: str | None = None
    operator: str | None = None
    task: str | None = None
    robot: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    topics: tuple[dict[str, Any], ...] = ()
    compression: str | None = None
    split: dict[str, Any] | None = None
    error: str | None = None
    message_count: int | None = None
    bytes: int | None = None
    task_result: str | None = None
    failure_reason: str | None = None
    quality: str | None = None
    quality_source: str | None = None
    review_status: str = ReviewStatus.pending
    review_revision: int = 0
    # False when the caller's database is ahead of ``record.json`` (§4.1-4): the
    # review columns below are unreliable and the caller must keep its own.
    review_from_sidecar: bool = True
    batch_id: str | None = None
    index_in_batch: int | None = None
    deleted_at: str | None = None
    delete_kind: str | None = None
    delete_reason: str | None = None
    # Set when the row was reconstructed from a ``capture_archived`` event: the
    # local copy is gone on purpose and these say when, and to where.
    archived_at: str | None = None
    archive_destination: str | None = None
    # Not a ``captures`` column. Carried so the caller can re-queue terminal
    # captures whose digest never completed (§8 reconciler) without a second
    # pass over every manifest.
    digest_state: str | None = None
    # The orchestrator's stop-time verdict, from ``quick_check.json`` (§4.2).
    # ``None`` means the sidecar is absent or unreadable, which is also what a
    # capture recorded before that sidecar existed looks like — so the caller
    # must LEAVE a column alone rather than blank it. Opaque here: the shape
    # belongs to the orchestrator.
    quick_check: dict[str, Any] | None = None


@dataclass(frozen=True)
class ReplicaRow:
    """One normalized ``replicas`` row for this installation."""

    capture_id: str
    instance_id: str
    state: str
    path: str | None = None
    manifest_digest: str | None = None
    # Left ``None``: a rebuild reads a manifest, it does not re-hash the bytes,
    # so it is in no position to claim a verification time (§9-4).
    verified_at: str | None = None


@dataclass(frozen=True)
class CorruptSidecar:
    """A sidecar that exists but cannot be read. Reported, never silently dropped."""

    capture_id: str | None
    path: str
    reason: str


@dataclass(frozen=True)
class RebuildResult:
    """Everything one scan concluded, with nothing applied yet."""

    captures: tuple[CaptureRow, ...] = ()
    replicas: tuple[ReplicaRow, ...] = ()
    corrupt: tuple[CorruptSidecar, ...] = ()
    # Captures left alone because the recorder could not be asked about them
    # (rule 1's fallback): no row is produced and the caller re-passes later.
    deferred: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()


@dataclass
class _Review:
    """The review overlay for one capture, from ``record.json``."""

    revision: int = 0
    review_status: str = ReviewStatus.pending
    task_result: str | None = None
    failure_reason: str | None = None
    quality: str | None = None
    quality_source: str | None = None
    batch_id: str | None = None
    index_in_batch: int | None = None
    # §4.2 label overrides, by field name. Empty = the manifest stands.
    labels: dict[str, str] = field(default_factory=dict)
    from_sidecar: bool = True


@dataclass
class _Accumulator:
    captures: list[CaptureRow] = field(default_factory=list)
    replicas: list[ReplicaRow] = field(default_factory=list)
    corrupt: list[CorruptSidecar] = field(default_factory=list)
    deferred: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def has_bag(capture_path: Path) -> bool:
    """Whether a capture directory holds recorded data (rule 2's discriminator).

    ``metadata.yaml`` or at least one ``*.mcap`` at the top level — the same
    files the recorder's ``_finalise`` looks for, so a crashed recording and a
    cleanly stopped one are judged by one standard.
    """
    if (capture_path / ROSBAG2_METADATA_FILENAME).is_file():
        return True
    try:
        return any(capture_path.glob("*.mcap"))
    except OSError:
        return False


def normalize_state(manifest_state: str, capture_path: Path) -> str:
    """Rule 2: an unfinalized manifest becomes ``interrupted``, or ``failed``.

    Terminal states are returned unchanged. In particular a ``completed``
    manifest whose bag has since been removed stays ``completed`` — the recorder
    saw the data, and demoting the row here would blame the recording for a
    disappearance that :class:`ReplicaState` is the right place to describe.
    """
    if manifest_state not in UNFINALIZED_STATES:
        return manifest_state
    if has_bag(capture_path):
        return CaptureState.interrupted.value
    return CaptureState.failed.value


def rebuild(
    data_dir: str | Path,
    *,
    instance_id: str,
    recorder_reachable: bool,
    live_exclusions: Iterable[str],
    known_revisions: Mapping[str, int] | None = None,
) -> RebuildResult:
    """Scan ``objects/`` and the ledger; return the rows they imply.

    *recorder_reachable* and *live_exclusions* are both **required**, and that is
    the point. Rule 1 makes every decision about an unfinalized manifest depend
    on whether the recorder was asked and what it said, so a caller that never
    asked must not be able to express itself as one that asked and got nothing:
    the defaults that would allow it (``False``/``()``) are exactly the values a
    forgetful caller would inherit, and they are the most destructive ones —
    normalizing a live capture to ``interrupted`` while the recorder is still
    writing it.

    *live_exclusions* are capture_ids the recorder reports as in flight. They are
    skipped entirely — no row, no replica, no warning — because the recorder is
    still their sole writer and the normal finalise path will produce the row.

    *recorder_reachable=False* is rule 1's fallback: rather than guess whether a
    ``recording`` manifest is live or abandoned, those captures are listed in
    :attr:`RebuildResult.deferred` and left untouched on disk for a later pass.
    Pass ``live_exclusions=()`` with it — an unreachable recorder told us
    nothing, which is different from telling us "none".

    *known_revisions* maps capture_id to the ``review_revision`` the caller's
    database currently holds, enabling the §4.1-4 divergence check.

    *instance_id* is **this** installation's id, and every replica row is filed
    under it — a transferred capture keeps the sending machine's
    ``source_instance_id`` in its manifest, and filing the local copy under that
    id would claim a copy exists on a machine we know nothing about.

    Raises :class:`~kairos_common.ledger_v2.LedgerUnreadableError` if the ledger
    exists but cannot be read: it outranks the manifests, so rebuilding without
    it would resurrect every capture an operator destroyed.
    """
    root = Path(data_dir)
    live = set(live_exclusions)
    known = dict(known_revisions or {})
    tombstones = ledger_v2.tombstones(root)
    acc = _Accumulator()

    directories, failed_files = _scan_objects(root, acc)
    seen: set[str] = set()

    for entry in directories:
        capture_id = entry.name
        if not is_uuid7(capture_id):
            acc.warnings.append(
                f"objects/{capture_id}: not a capture_id (UUIDv7); ignored"
            )
            continue
        if capture_id in live:
            continue
        row = _row_from_directory(
            entry,
            capture_id,
            instance_id=instance_id,
            tombstones=tombstones,
            known=known,
            acc=acc,
            defer_unfinalized=not recorder_reachable,
        )
        if row is not None:
            seen.add(capture_id)

    for entry in failed_files:
        capture_id = entry.name[: -len(FAILED_START_SUFFIX)]
        if not is_uuid7(capture_id):
            acc.warnings.append(f"objects/{entry.name}: not a capture_id; ignored")
            continue
        if capture_id in live:
            continue
        if capture_id in seen:
            # A directory means the bag exists, which contradicts "the start
            # produced nothing". Trust the bytes and flag the leftover marker.
            acc.warnings.append(
                f"{capture_id}: both objects/{capture_id}/ and "
                f"objects/{capture_id}{FAILED_START_SUFFIX} exist; "
                "the directory wins and the marker is stale"
            )
            continue
        if _row_from_failed_start(entry, capture_id, tombstones, acc) is not None:
            seen.add(capture_id)

    _rows_from_archive_events(root, instance_id, tombstones, seen, live, acc)
    _rows_from_ledger_only_tombstones(root, instance_id, tombstones, seen, live, acc)

    return RebuildResult(
        captures=tuple(sorted(acc.captures, key=lambda r: r.capture_id)),
        replicas=tuple(sorted(acc.replicas, key=lambda r: r.capture_id)),
        corrupt=tuple(acc.corrupt),
        deferred=tuple(sorted(acc.deferred)),
        warnings=tuple(acc.warnings),
    )


def _scan_objects(root: Path, acc: _Accumulator) -> tuple[list[Path], list[Path]]:
    """Split ``objects/`` into capture directories and failed-start markers."""
    objects = objects_dir(root)
    try:
        entries = sorted(objects.iterdir())
    except FileNotFoundError:
        return [], []
    except OSError as exc:
        acc.warnings.append(f"objects/ is unreadable: {exc}")
        return [], []

    directories: list[Path] = []
    failed: list[Path] = []
    for entry in entries:
        if entry.is_symlink():
            # Nothing kairos writes under objects/ is a symlink, and following
            # one would let a link planted here attach another capture's bytes —
            # or a path outside the store entirely — to this capture_id. The
            # views/ tree is where symlinks belong (§6).
            acc.warnings.append(
                f"objects/{entry.name}: unexpected symlink; not followed"
            )
            continue
        if entry.is_dir():
            directories.append(entry)
        elif entry.is_file() and entry.name.endswith(FAILED_START_SUFFIX):
            failed.append(entry)
    return directories, failed


def _row_from_directory(
    entry: Path,
    capture_id: str,
    *,
    instance_id: str,
    tombstones: Mapping[str, dict[str, Any]],
    known: Mapping[str, int],
    acc: _Accumulator,
    defer_unfinalized: bool,
) -> CaptureRow | None:
    read = read_object_manifest(entry)
    if read.status is SidecarStatus.missing:
        # §2's invariant says an incomplete directory under objects/ can only be
        # a live capture, and live ones were excluded above. Adopting this would
        # mean inventing a capture out of a directory name.
        acc.warnings.append(
            f"objects/{capture_id}: no {OBJECT_MANIFEST_FILENAME}; not adopted"
        )
        return None
    if read.status is SidecarStatus.corrupt:
        _report_corrupt_manifest(
            capture_id, entry, read.path, read.error or "", instance_id, acc
        )
        return None

    manifest = read.manifest
    if manifest is None:  # pragma: no cover - an ok read always carries one
        return None
    if manifest.capture_id != capture_id:
        _report_corrupt_manifest(
            capture_id,
            entry,
            read.path,
            (
                f"capture_id mismatch: manifest says {manifest.capture_id}, "
                f"directory is {capture_id}"
            ),
            instance_id,
            acc,
        )
        return None

    if manifest.state in UNFINALIZED_STATES and defer_unfinalized:
        acc.deferred.append(capture_id)
        return None

    state = normalize_state(manifest.state, entry)
    review = _review_overlay(entry, capture_id, known, acc)
    row = _capture_row(manifest, state, review, read_quick_check(entry))

    tombstone = tombstones.get(capture_id)
    if tombstone is not None:
        row = _apply_tombstone(row, tombstone)
        acc.warnings.append(
            f"{capture_id}: ledger records {tombstone.get('kind')} but "
            f"objects/{capture_id}/ still exists; delete-resume required (§7)"
        )

    acc.captures.append(row)
    acc.replicas.append(
        ReplicaRow(
            capture_id=capture_id,
            instance_id=instance_id,
            state=(
                ReplicaState.present_verified
                if manifest.digest_state == DigestState.complete
                else ReplicaState.present_unverified
            ),
            path=str(entry),
            manifest_digest=manifest.manifest_digest,
        )
    )
    return row


def _report_corrupt_manifest(
    capture_id: str,
    capture_path: Path,
    sidecar_path: Path,
    reason: str,
    instance_id: str,
    acc: _Accumulator,
) -> None:
    """Record a manifest that cannot be trusted, without inventing a capture.

    Two outputs, deliberately. The :class:`CorruptSidecar` entry carries the
    reason an operator needs. The replica row makes the *row set* self-describing:
    the bytes are on this machine and their description is broken, which is a
    different state from "no copy here" and has to be visible to anything that
    reads replicas rather than the corrupt list.

    There is still no ``captures`` row — the manifest was the only thing that
    could have said what this capture *is*, so a row would be fabricated. The
    replica therefore has no matching capture row, and callers joining the two
    must tolerate that (it is precisely the set they should be repairing).
    """
    acc.corrupt.append(
        CorruptSidecar(capture_id=capture_id, path=str(sidecar_path), reason=reason)
    )
    acc.replicas.append(
        ReplicaRow(
            capture_id=capture_id,
            instance_id=instance_id,
            state=ReplicaState.corrupt,
            path=str(capture_path),
        )
    )


def _row_from_failed_start(
    entry: Path,
    capture_id: str,
    tombstones: Mapping[str, dict[str, Any]],
    acc: _Accumulator,
) -> CaptureRow | None:
    """§3.4: a start that produced no bag is still a capture that happened."""
    read = read_object_manifest(entry)
    if read.status is not SidecarStatus.ok or read.manifest is None:
        acc.corrupt.append(
            CorruptSidecar(
                capture_id=capture_id,
                path=str(read.path),
                reason=read.error or "unreadable failed-start record",
            )
        )
        return None

    manifest = read.manifest
    if manifest.capture_id != capture_id:
        # Same reasoning as the directory case: the filename and the record must
        # agree, or one of them describes a different start entirely.
        acc.corrupt.append(
            CorruptSidecar(
                capture_id=capture_id,
                path=str(read.path),
                reason=(
                    f"capture_id mismatch: record says {manifest.capture_id}, "
                    f"filename is {capture_id}{FAILED_START_SUFFIX}"
                ),
            )
        )
        return None
    if manifest.state != CaptureState.failed:
        acc.warnings.append(
            f"{capture_id}: failed-start record claims state "
            f"{manifest.state!r}; recorded as failed"
        )
    # No replica row: there are no bytes to hold a copy of.
    row = _capture_row(manifest, CaptureState.failed.value, _Review())
    tombstone = tombstones.get(capture_id)
    if tombstone is not None:
        row = _apply_tombstone(row, tombstone)
    acc.captures.append(row)
    return row


def _rows_from_archive_events(
    root: Path,
    instance_id: str,
    tombstones: Mapping[str, dict[str, Any]],
    seen: set[str],
    live: set[str],
    acc: _Accumulator,
) -> None:
    """Rows for captures that were archived and whose local copy is therefore gone.

    §6 archives a capture by copying it out, verifying the copy, writing the
    ledger event and only then deleting the source — so a successful archive
    leaves nothing under ``objects/``. Without this pass the capture would
    simply vanish from the catalog on the next rebuild, and "where did episode
    011 go" would be unanswerable again, which is the question the ledger was
    introduced to answer.

    The row is honest about its provenance: ``state`` is ``completed`` (the
    capture was terminal when it was archived) but everything else is limited to
    what the event carried, and a warning says so.
    """
    for capture_id, event in sorted(ledger_v2.archive_events(root).items()):
        if capture_id in seen or capture_id in live or not is_uuid7(capture_id):
            continue
        if capture_id in tombstones:
            # Archived first, then discarded or deleted. The tombstone is the
            # later intent and :func:`_rows_from_ledger_only_tombstones` owns it.
            continue
        acc.captures.append(
            CaptureRow(
                capture_id=capture_id,
                state=CaptureState.completed.value,
                run_id=_event_str(event, "run_id"),
                # NOT the event's source_instance_id: that names whoever ran the
                # archive, which for a transferred capture is not the machine
                # that recorded it. Unknown is better than plausibly wrong.
                operator=_event_str(event, "operator"),
                task=_event_str(event, "task"),
                message_count=_event_int(event, "message_count"),
                bytes=_event_int(event, "bytes"),
                archived_at=_event_str(event, "at"),
                archive_destination=_event_str(event, "destination"),
            )
        )
        acc.replicas.append(
            ReplicaRow(
                capture_id=capture_id,
                instance_id=instance_id,
                # The local copy was removed deliberately, by us, after the
                # destination copy was verified.
                state=ReplicaState.absent_managed,
            )
        )
        acc.warnings.append(
            f"{capture_id}: reconstructed from a capture_archived event only "
            f"(archived to {_event_str(event, 'destination')}); the sidecars are "
            "gone, so topics, timestamps and review state cannot be recovered"
        )
        seen.add(capture_id)


def _event_str(event: Mapping[str, Any], key: str) -> str | None:
    value = event.get(key)
    return value if isinstance(value, str) and value else None


def _event_int(event: Mapping[str, Any], key: str) -> int | None:
    value = event.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _rows_from_ledger_only_tombstones(
    root: Path,
    instance_id: str,
    tombstones: Mapping[str, dict[str, Any]],
    seen: set[str],
    live: set[str],
    acc: _Accumulator,
) -> None:
    """Rows for captures the ledger buried and the filesystem no longer holds.

    §7 keeps the row after a deletion ("行は消さない") — the tombstone is the
    answer to "where did that recording go", and it is also what stops a later
    transfer from re-adopting bytes an operator deliberately discarded. The row
    is nearly empty because the ledger is all that is left of the capture.
    """
    for capture_id, event in sorted(tombstones.items()):
        if capture_id in seen or capture_id in live or not is_uuid7(capture_id):
            continue
        row = _apply_tombstone(
            CaptureRow(capture_id=capture_id, state=CaptureState.deleted.value), event
        )
        acc.captures.append(row)
        in_trash = (trash_dir(root) / capture_id).exists()
        acc.replicas.append(
            ReplicaRow(
                capture_id=capture_id,
                instance_id=instance_id,
                # §7 step 5: absent_managed is only correct once the bytes are
                # verifiably gone. Still in .trash = the reaper is unfinished.
                state=(
                    ReplicaState.trashed if in_trash else ReplicaState.absent_managed
                ),
            )
        )


def _capture_row(
    manifest: ObjectManifestV2,
    state: str,
    review: _Review,
    quick_check: dict[str, Any] | None = None,
) -> CaptureRow:
    return CaptureRow(
        capture_id=manifest.capture_id,
        state=state,
        run_id=manifest.run_id,
        source_instance_id=manifest.source_instance_id,
        # §4.2: the operator's labels are applied OVER the manifest's, and the
        # order is the whole contract. The manifest is the recorder's sealed
        # account and is never rewritten, so an edit survives a rebuild only by
        # being re-applied here — read the manifest first, then let record.json
        # correct it. A key absent from ``labels`` is not an override, which is
        # how clearing an edit returns the capture to what was recorded.
        operator=review.labels.get("operator", manifest.operator),
        task=review.labels.get("task", manifest.task),
        robot=review.labels.get("robot", manifest.robot),
        started_at=manifest.started_at,
        ended_at=manifest.ended_at,
        topics=manifest.topics,
        compression=manifest.compression,
        split=manifest.split,
        error=manifest.error,
        message_count=manifest.message_count,
        bytes=manifest.bytes,
        task_result=review.task_result,
        failure_reason=review.failure_reason,
        quality=review.quality,
        quality_source=review.quality_source,
        review_status=review.review_status,
        review_revision=review.revision,
        review_from_sidecar=review.from_sidecar,
        batch_id=review.batch_id,
        index_in_batch=review.index_in_batch,
        digest_state=manifest.digest_state,
        quick_check=quick_check,
    )


def _apply_tombstone(row: CaptureRow, event: Mapping[str, Any]) -> CaptureRow:
    """Rule 3: the ledger's verdict replaces whatever the manifest claimed."""
    discarded = event.get("kind") == "capture_discarded"
    reason = event.get("reason")
    return replace(
        row,
        state=(CaptureState.discarded if discarded else CaptureState.deleted).value,
        deleted_at=event.get("at"),
        delete_kind="discard" if discarded else "delete",
        delete_reason=reason if isinstance(reason, str) else None,
    )


def _review_overlay(
    capture_path: Path,
    capture_id: str,
    known: Mapping[str, int],
    acc: _Accumulator,
) -> _Review:
    """Rule 5 / §4.1-4: read ``record.json`` and decide whether it is authoritative."""
    read = read_record(capture_path)
    if read.status is SidecarStatus.corrupt:
        acc.corrupt.append(
            CorruptSidecar(
                capture_id=capture_id, path=str(read.path), reason=read.error or ""
            )
        )
        # Unreviewed defaults, but the caller must not treat them as the truth:
        # a corrupt sidecar is no reason to wipe review state out of the DB.
        return _Review(from_sidecar=False)

    record = read.record
    sidecar_revision = record.revision if record is not None else 0
    db_revision = known.get(capture_id)
    if db_revision is not None and db_revision > sidecar_revision:
        acc.warnings.append(
            f"{capture_id}: database review_revision {db_revision} is ahead of "
            f"record.json revision {sidecar_revision}; keeping the database "
            "values (§4.1-4)"
        )
        return _Review(from_sidecar=False)

    if record is None:
        # No file = never reviewed (§4). Revision 0 is exactly that statement.
        return _Review()

    return _Review(
        revision=record.revision,
        review_status=record.review_status,
        task_result=record.task_result,
        failure_reason=record.failure_reason,
        quality=record.quality,
        quality_source=record.quality_source,
        batch_id=record.batch_id,
        index_in_batch=record.index_in_batch,
        labels=dict(record.labels),
    )
