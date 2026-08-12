# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Capture-level operations: review, delete, archive, and the resume paths.

Contract §4.1 (review), §6 (archive), §7 (delete). Each of the three writes to
the filesystem *and* the database, and each orders those two writes so that a
crash between them leaves a state the next startup can finish rather than a
state nobody can interpret. They remain one class — :class:`CaptureService` —
assembled here from three modules that each carry the ordering argument for
their own half of the contract:

* :mod:`api_orchestrator.capture_review` — §4.1: the sidecar before the
  database CAS, and the guarded write that makes writing first safe.
* :mod:`api_orchestrator.capture_deletion` — §7: the ledger before any byte
  moves, and the resume paths that finish an interrupted deletion.
* :mod:`api_orchestrator.capture_archive` — §6: copy, verify, record, and only
  then remove the source through the ordinary trash pathway.

What stays here is what all three share: the catalog reads, the §3/§8 manifest
reconciliation, §10 retention, and the guards every mutating path runs first.

The ``record.json`` compare-and-swap primitives stay here too, rather than
moving with the review code that calls them. They are the only writers of the
file §8 rebuilds the whole catalog from, so keeping :func:`_write_record_sidecar`
and :func:`_restore_record_from_row` in one module keeps that contract readable
— and lets a caller substitute the writer to drive the interleaving the CAS
exists to arbitrate (see :meth:`CaptureReviewMixin.save_review`).

The per-capture mutex the three responsibilities share lives in
:mod:`api_orchestrator.capture_locks`, and is deliberately *not* the store's
connection lock.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from kairos_common import ApiError, Compression, ledger_v2
from kairos_common.capture_sidecars import (
    LABEL_FIELDS,
    TERMINAL_STATES,
    UNFINALIZED_STATES,
    CaptureState,
    ObjectManifestV2,
    RecordV2,
    SidecarStatus,
    read_object_manifest,
    read_record,
    write_record,
)
from kairos_common.ids import is_uuid7
from kairos_common.time import parse_iso8601, utc_now_iso8601

from api_orchestrator import layout as layout_mod
from api_orchestrator.capture_archive import (
    CaptureArchiveMixin,
    reject_overlapping_destination,
)
from api_orchestrator.capture_deletion import MAX_REAP_ATTEMPTS, CaptureDeletionMixin
from api_orchestrator.capture_locks import CaptureLocks
from api_orchestrator.capture_review import CaptureReviewMixin
from api_orchestrator.health import StoreHealth, require_delete_available
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import (
    Capture,
    CaptureDetail,
    CaptureTopic,
    RetentionCandidate,
    Split,
    coerce_error,
)
from api_orchestrator.store import CaptureStore
from api_orchestrator.verdict import GATING_PIPELINES, Verdict, verdict_of

logger = logging.getLogger("kairos")


class CaptureService(CaptureReviewMixin, CaptureDeletionMixin, CaptureArchiveMixin):
    """Review, delete and archive one capture at a time.

    Args:
        store: The v2 catalog.
        layout: Data directory paths.
        health: Process-wide store condition (SUSPECT, delete availability).
        instance_id: This installation's id — replicas are filed under it.
        on_first_review: Awaited after the FIRST review save for a capture.
            Carries the side effects §4.1 moved off the retired
            ``POST /episodes``: the batch counter and the auto-pull. Injected so
            this module does not depend on the importer client.
        on_views_change: Called after a review save that edited a label §6's
            tree can be built from. A capture's operator/task are what
            ``views/`` falls back to when the dataset holding it names neither,
            so an edit that did not schedule a regeneration would leave the
            browsable tree pointing at the label the capture used to have.
    """

    def __init__(
        self,
        store: CaptureStore,
        layout: DataLayout,
        health: StoreHealth,
        *,
        instance_id: str,
        on_first_review: Callable[[Capture], Awaitable[None]] | None = None,
        on_views_change: Callable[[], None] | None = None,
    ) -> None:
        self._store = store
        self._layout = layout
        self._health = health
        self._instance_id = instance_id
        self._on_first_review = on_first_review
        self._on_views_change = on_views_change
        self._locks = CaptureLocks()
        # The reaper's per-process attempt bound (§7 step 5). Held on the
        # service rather than in the deletion mixin so one construction site
        # still owns every piece of this object's state.
        self._reap_attempts: dict[str, int] = {}

    @property
    def layout(self) -> DataLayout:
        return self._layout

    @property
    def instance_id(self) -> str:
        return self._instance_id

    def _mutex(self, capture_id: str) -> asyncio.Lock:
        """This capture's §4.1 mutex — the one seam all three paths take."""
        return self._locks.get(capture_id)

    # ---- reads -------------------------------------------------------------

    def get(self, capture_id: str) -> Capture:
        """Return a capture or raise a unified 404."""
        _require_capture_id(capture_id)
        capture = self._store.get_capture(capture_id, instance_id=self._instance_id)
        if capture is None:
            raise ApiError(
                status_code=404,
                code="capture_not_found",
                message=f"Capture not found: {capture_id}",
                details={"capture_id": capture_id},
            )
        return capture

    def get_detail(self, capture_id: str) -> CaptureDetail:
        """A capture enriched with its on-disk sidecars and pipeline reports."""
        capture = self.get(capture_id)
        capture_dir = self._layout.capture_dir(capture_id)
        manifest = read_object_manifest(capture_dir)
        record = read_record(capture_dir)
        return CaptureDetail(
            **capture.model_dump(),
            manifest=manifest.manifest.to_json() if manifest.manifest else None,
            record=record.record.to_json() if record.record else None,
            validation=self._report("fast_validation", capture_id),
            loss=self._report("loss_report", capture_id),
            verdict=str(self.verdict_of(capture_id)),
        )

    def set_validation_override(self, capture_id: str, reason: str | None) -> Capture:
        """Record (or clear) a human override of a NEEDS_REVIEW verdict.

        The ledger line is written FIRST and its failure is fatal: an override
        that survived only as a column would let a capture into a dataset with
        no durable account of who decided that, which is the exact opacity the
        gate exists to prevent (§5's ordering, same as the tombstones').
        """
        self.get(capture_id)  # 404s on an unknown capture
        if reason:
            ledger_v2.append(
                self._layout.data_dir,
                "capture_validation_overridden",
                instance_id=self._instance_id,
                capture_id=capture_id,
                payload={
                    "reason": reason,
                    "verdict": str(self.verdict_of(capture_id)),
                },
            )
        return self._store.update_capture(capture_id, validation_override=reason)

    def verdict_of(self, capture_id: str) -> Verdict:
        """The capture's CURRENT validation verdict, read fresh from disk.

        Derived rather than cached on purpose (see verdict.py): the reports
        outlive the index, so a rebuild restores the verdict for free and a
        re-run can never leave a stale copy on the row.
        """
        return verdict_of({p: self._report(p, capture_id) for p in GATING_PIPELINES})

    def _report(self, pipeline: str, capture_id: str) -> dict[str, Any] | None:
        return layout_mod.read_json(
            self._layout.report_dir(pipeline, capture_id) / "summary.json"
        )

    def has_report(self, pipeline: str, capture_id: str) -> bool:
        """Whether *pipeline* already produced a report for this capture."""
        return (
            self._layout.report_dir(pipeline, capture_id) / "summary.json"
        ).is_file()

    def captures_with_report(self, pipeline: str) -> set[str]:
        """Every capture id *pipeline* has already reported on, in one listing.

        The set complement of :meth:`has_report` asked once instead of once per
        capture. "Which of these thousands have a report" is a question about
        the report directory, not about the catalog: reading it costs one
        listing plus a check per report that actually EXISTS, where probing
        per capture costs one syscall per capture for an answer that is
        usually "no" — 15,000 of them for a single presets request on a
        5,000-capture store, measured (E-27).
        """
        try:
            entries = list((self._layout.report / pipeline).iterdir())
        except OSError:
            # No report directory yet is a complete answer: nothing has run.
            return set()
        return {
            entry.name
            for entry in entries
            if entry.is_dir() and (entry / "summary.json").is_file()
        }

    def present_terminal_ids(self) -> list[str]:
        """Ids of the validation targets: terminal captures present here."""
        return self._store.present_terminal_ids(
            sorted(TERMINAL_STATES), instance_id=self._instance_id
        )

    def list(
        self, limit: int, cursor: str | None = None, **filters: Any
    ) -> tuple[list[Capture], str | None]:
        """One page of captures plus the opaque next cursor."""
        parsed = _parse_cursor(cursor)
        items, next_seq = self._store.list_captures(
            limit, parsed, instance_id=self._instance_id, **filters
        )
        return items, (str(next_seq) if next_seq is not None else None)

    # ---- manifest reconciliation (§3, §8) ----------------------------------

    def adopt_manifest_facts(self, capture_id: str) -> bool:
        """Copy a terminal manifest's recording facts onto the row. ``True`` = changed.

        ``object_manifest.json`` is authoritative for what was recorded (§3);
        the row is a queryable cache of it. The stop path normally keeps the two
        in step, but it is not the only way a capture reaches a terminal state —
        a recorder killed mid-recording writes its own recovery manifest with
        RE-MEASURED counters, and nothing in the orchestrator was reading them.
        The row then kept the live session's ``bytes: 0`` while 10 MB of robot
        data sat on disk, and every UI surface called it empty. An operator who
        believes that discards it.

        Only a TERMINAL manifest is adopted: until finalise the recorder is
        still sole writer (§3.3), and its in-progress counters are less accurate
        than the ones the live session is reporting to us.

        Deliberately writes only the fields that differ, so a pass over an
        agreeing catalog costs nothing and the return value means "the catalog
        was wrong and is now right" rather than "I ran".

        **An unreadable manifest changes nothing here, and DOES decide the
        state in** :meth:`RecordService._final_state` **— neither is a bug.**
        This is optional work that can decline: leaving the row as it was costs
        nothing, and §8 rule 4 says an unreadable manifest is reported rather
        than guessed from. The stop path cannot decline — it must commit to a
        terminal state right then — so it treats a corrupt manifest as
        not-sealed and returns ``interrupted``, which is the better way to be
        wrong there. That method's docstring carries the full trade; read it
        before concluding this side is the one with the bug.
        """
        read = read_object_manifest(self._layout.capture_dir(capture_id))
        if read.status is not SidecarStatus.ok or read.manifest is None:
            # Unreadable: reported by the scan that found it, never adopted
            # from. See the divergence note above — the stop path decides
            # differently on this same file, on purpose.
            return False
        manifest = read.manifest
        if manifest.state not in TERMINAL_STATES:
            return False
        capture = self._store.get_capture(capture_id)
        if capture is None:
            return False

        changes = _manifest_divergence(capture, manifest)
        if not changes:
            return False
        self._store.update_capture(capture_id, **changes)
        logger.info(
            "adopted the manifest's recording facts onto the catalog row",
            extra={"capture_id": capture_id, "fields": sorted(changes)},
        )
        return True

    # ---- retention (§10) ---------------------------------------------------

    def retention_candidates(
        self, retention_days: int, *, now: datetime | None = None
    ) -> tuple[list[RetentionCandidate], int]:
        """Captures the operator may want to reclaim. Advisory only.

        The v1 definition ("a row exists, therefore it was never exported") is
        gone: §6 keeps the row forever, so it would now match everything. A
        candidate is instead a capture that **no dataset cites**, whose review
        left it ``pending`` or ``excluded``, and which is older than
        ``RETENTION_DAYS``. Nothing here deletes; deletion goes through the
        confirmed ``POST /captures/{id}/delete``.
        """
        if retention_days <= 0:
            return [], 0
        cutoff = (now or datetime.now(UTC)) - timedelta(days=retention_days)
        captures = self._store.list_by_states(
            sorted(TERMINAL_STATES), instance_id=self._instance_id
        )
        candidates: list[RetentionCandidate] = []
        total = 0
        for capture in captures:
            if capture.review_status not in ("pending", "excluded"):
                continue
            if self._store.dataset_memberships_for(capture.capture_id):
                continue
            started = parse_iso8601(capture.started_at)
            if started is None or started >= cutoff:
                continue
            size = layout_mod.dir_bytes(self._layout.capture_dir(capture.capture_id))
            if size is not None:
                total += size
            candidates.append(
                RetentionCandidate(
                    capture_id=capture.capture_id,
                    run_id=capture.run_id,
                    started_at=capture.started_at,
                    bytes=size,
                    state=capture.state,
                    review_status=capture.review_status,
                )
            )
        return candidates, total

    # ---- guards ------------------------------------------------------------

    def ensure_ledger_slack(self) -> bool:
        """Re-reserve the 1 MB ENOSPC slack if it has been spent (§5).

        The slack is a one-shot: ``append_with_slack_release`` deletes it to buy
        the few hundred bytes a tombstone needs on a full disk. Without this the
        FIRST discard on a full disk works and every one after it fails — which
        is precisely backwards, because an operator freeing space discards
        several captures in a row.

        Called after each successful delete and from the reconciler. Returns
        whether the reservation now exists; a failure is logged, not raised, so
        it can never turn a completed deletion into an error.
        """
        try:
            ledger_v2.ensure_slack(self._layout.data_dir)
        except OSError as exc:
            logger.warning(
                "could not re-reserve the ledger slack; the next discard on a "
                "full disk may fail to append: %s",
                exc,
            )
            return False
        return True

    def _membership_blocks(self, dataset_id: str) -> bool:
        """Whether this membership pins the capture's local bytes (§6.1)."""
        dataset = self._store.get_dataset(dataset_id)
        if dataset is None:
            return True  # an unknown dataset is not a licence to delete
        return not (
            dataset["status"] == "archived" and dataset.get("archive_mode") == "copy"
        )

    def _reject_overlapping_destination(self, target: Path, source: Path) -> None:
        reject_overlapping_destination(target, source, self._layout.data_dir)

    def _require_delete_available(self) -> None:
        require_delete_available(
            self._health, "Deleting is not available on this deployment"
        )

    @staticmethod
    def _reject_active(capture: Capture) -> None:
        if capture.state in (CaptureState.recording, CaptureState.stopping):
            raise ApiError(
                status_code=409,
                code="capture_recording",
                message=(
                    f"{capture.capture_id} is still {capture.state}; "
                    "stop the recording first."
                ),
                details={
                    "capture_id": capture.capture_id,
                    "state": str(capture.state),
                },
            )

    def _reject_leased(self, capture: Capture) -> None:
        """§7.1: refuse while ANY reader still holds the capture.

        The guard is unchanged by the shared rewrite — one live holder is
        enough — but the refusal now names all of them. With N encoders running
        on one recording, "a job is working on this" is true and useless; an
        operator deciding whether to wait needs the count and the last expiry.
        """
        holders = self._store.lease_holders(capture.capture_id)
        if not holders:
            return
        raise ApiError(
            status_code=409,
            code="capture_busy",
            message=_busy_message(capture.capture_id, holders),
            details=_busy_details(capture.capture_id, holders),
        )

    def _reject_dataset_member(
        self, capture: Capture, *, except_dataset: str | None = None
    ) -> None:
        """Refuse while any dataset cites this capture (§7).

        ``except_dataset`` is the one scoped relaxation: a dataset archive run
        (§6.x) may remove its OWN members' bytes — that dataset is leaving
        ``views/`` as a whole — but membership of any other dataset still
        refuses. Every HTTP route passes ``None``; only the runner's
        :meth:`archive_member` names its dataset.

        A membership in a COPY-SEALED dataset (archived, mode ``copy``) does
        not block: that dataset is a historical record whose export is already
        complete and verified elsewhere, and letting it pin the local bytes
        forever would make "seal a combined set, keep working" a trap — the
        member set is frozen, so the membership could never be removed to
        unblock the delete.
        """
        memberships = [
            m
            for m in self._store.dataset_memberships_for(capture.capture_id)
            if m.dataset_id != except_dataset and self._membership_blocks(m.dataset_id)
        ]
        if not memberships:
            return
        raise ApiError(
            status_code=400,
            code="capture_in_dataset",
            message=(
                f"{capture.capture_id} belongs to "
                f"{len(memberships)} dataset(s); remove it from them first."
            ),
            details={
                "capture_id": capture.capture_id,
                "dataset_ids": [m.dataset_id for m in memberships],
            },
        )


class _CaptureGoneError(RuntimeError):
    """``objects/<capture_id>`` is absent and must not be recreated."""


class _SidecarRaceError(RuntimeError):
    """``record.json`` no longer holds the revision this save was built on."""

    def __init__(self, on_disk_revision: int) -> None:
        super().__init__(f"record.json is at revision {on_disk_revision}")
        self.on_disk_revision = on_disk_revision


def _manifest_divergence(
    capture: Capture, manifest: ObjectManifestV2
) -> dict[str, Any]:
    """The recording facts where the row disagrees with a terminal manifest.

    A ``None`` on the manifest is treated as "not measured", never as "zero":
    an older recorder that did not record a message count must not blank a
    count the live session did observe. The exception is ``error``, where the
    manifest saying nothing IS the statement that the recording ended cleanly —
    so a stale sync error on the row is cleared.
    """
    changes: dict[str, Any] = {}
    if str(capture.state) != manifest.state:
        changes["state"] = CaptureState(manifest.state)
    for field, value in (
        ("ended_at", manifest.ended_at),
        ("bytes", manifest.bytes),
        ("message_count", manifest.message_count),
        ("started_at", manifest.started_at),
        ("operator", manifest.operator),
        ("task", manifest.task),
        ("robot", manifest.robot),
    ):
        if value is not None and getattr(capture, field) != value:
            changes[field] = value

    manifest_error = coerce_error(manifest.error)
    if capture.error != manifest_error:
        # Whatever the recorder wrote wins, including nothing at all. The
        # generic "No active recorder session found." the status-poll path
        # leaves behind is exactly the message that should lose to the
        # recorder's own "recorder restarted while the capture was recording".
        #
        # This deliberately also clears a row-side ``manifest_corrupt``: we can
        # only be here because the file on disk read back as a valid TERMINAL
        # manifest (a corrupt one adopts nothing), so the on-disk file is the
        # truth and the HTTP-side complaint was transient. Keeping the stale
        # complaint once the file verifiably reads clean would be the lie.
        changes["error"] = manifest_error

    manifest_topics = [CaptureTopic.model_validate(t) for t in manifest.topics]
    if manifest_topics and capture.topics != manifest_topics:
        changes["topics"] = manifest_topics
    if manifest.compression and str(capture.compression) != manifest.compression:
        changes["compression"] = Compression(manifest.compression)
    if manifest.split and (
        capture.split is None or capture.split.model_dump() != manifest.split
    ):
        changes["split"] = Split.model_validate(manifest.split)
    return changes


def _write_record_sidecar(
    capture_dir: Path, record: RecordV2, *, allow_create: bool, base_revision: int
) -> None:
    """Write ``record.json`` if it still holds *base_revision*, else refuse.

    A split deployment reviews a capture on the recording PC *before* the bytes
    arrive from the robot — the auto-pull is triggered BY the first review save
    — so "no local copy yet" is a normal state, and for those captures the
    directory is created and later merged by ``transfer.adopt_incoming``.

    ``allow_create=False`` is the delete path's guard. Recreating the directory
    for a capture that is being removed would resurrect a tree the reaper has
    already walked past, and the next rebuild would then report a capture with
    no manifest. The caller decides under the per-capture mutex; this function
    only refuses to be the thing that silently recreates it.

    The revision check is the same compare-and-swap the database does, applied
    to the authoritative copy. The mutex upstream only covers one process, and
    ``record.json`` is the file §8 rebuilds the whole catalog from — so a second
    orchestrator's accepted review must not be overwritten by a save that was
    composed before it landed. A file that is missing or unreadable holds no
    decision to protect and is written over as before.
    """
    if not capture_dir.is_dir():
        if not allow_create:
            raise _CaptureGoneError(f"{capture_dir} does not exist")
        capture_dir.mkdir(parents=True, exist_ok=True)
    on_disk = read_record(capture_dir).record
    if on_disk is not None and on_disk.revision != base_revision:
        raise _SidecarRaceError(on_disk.revision)
    write_record(capture_dir, record)


def _restore_record_from_row(
    capture_dir: Path, capture: Capture, *, wrote_revision: int
) -> None:
    """Put the winning row's review back into ``record.json`` after a lost CAS.

    Only touches the file if it is still the one this request wrote
    (*wrote_revision*): a third save that has since landed is newer than the row
    we are holding, and restamping over it would undo a decision for the second
    time in one code path.

    A row at revision 0 means the winner is not a review at all — the capture
    was removed underneath us — and there is nothing to restore, so the file is
    left for the reaper and the rebuild rather than invented.
    """
    if capture.review_revision < 1:
        return
    on_disk = read_record(capture_dir).record
    if on_disk is None or on_disk.revision != wrote_revision:
        return
    try:
        write_record(
            capture_dir,
            RecordV2(
                capture_id=capture.capture_id,
                revision=capture.review_revision,
                review_status=str(capture.review_status or "pending"),
                task_result=capture.task_result,
                failure_reason=capture.failure_reason,
                quality=capture.quality,
                quality_source=capture.quality_source,
                batch_id=capture.batch_id,
                index_in_batch=capture.index_in_batch,
                labels=_row_label_overrides(capture_dir, capture, on_disk),
                updated_at=utc_now_iso8601(),
            ),
        )
    except OSError as exc:
        # The caller is already raising 409; a failed repair must not turn that
        # into a 500. The disagreement is logged so it is visible, and the next
        # successful save on this capture overwrites the file anyway.
        logger.error(
            "could not restore record.json from the winning row",
            extra={"capture_id": capture.capture_id, "error": str(exc)},
        )


def _busy_message(capture_id: str, holders: list[dict[str, str]]) -> str:
    """One sentence for a capture held by one reader or by several."""
    last = holders[-1]["expires_at"]
    if len(holders) == 1:
        return (
            f"{holders[0]['owner']} is working on {capture_id} until {last}; "
            "try again after that."
        )
    return (
        f"{len(holders)} jobs are working on {capture_id}; the last finishes "
        f"by {last}. Try again after that."
    )


def _busy_details(capture_id: str, holders: list[dict[str, str]]) -> dict[str, Any]:
    """The 409 body. ``holders`` is the truth; the two scalars are the summary.

    ``lease_owner``/``lease_expires_at`` name the holder whose lease expires
    LAST, which is the honest scalar answer to "who am I waiting on and until
    when" — it is the moment the capture becomes deletable. They are kept
    because a client that only knows the single-owner shape still reads them,
    and they stay correct rather than naming an arbitrary one of N.
    """
    last = holders[-1]
    return {
        "capture_id": capture_id,
        "holders": holders,
        "lease_owner": last["owner"],
        "lease_expires_at": last["expires_at"],
    }


def _row_label_overrides(
    capture_dir: Path, capture: Capture, on_disk: RecordV2
) -> dict[str, str]:
    """Which of the winning row's labels are §4.3 overrides rather than recorded.

    The row carries the EFFECTIVE label, so it cannot say on its own whether a
    value was edited or came off the manifest. Writing all three back as
    overrides would freeze the recorder's own values into the sidecar, and a
    later correction to the manifest would then be shadowed by a "decision"
    nobody made. So the manifest is consulted and only a genuine difference is
    recorded.

    Dropping the block instead is not an option: this file is what §8 rebuilds
    from, so a restore that omitted a real edit would undo it the next time
    somebody deleted ``kairos.db`` — silently, and long after the request that
    caused it. If the manifest cannot be read, the overrides already on disk are
    kept for exactly that reason; this is a repair path and must not raise.
    """
    manifest = read_object_manifest(capture_dir).manifest
    if manifest is None:
        return dict(on_disk.labels)
    return {
        name: value
        for name in LABEL_FIELDS
        if isinstance(value := getattr(capture, name, None), str)
        and value != getattr(manifest, name, None)
    }


def _require_capture_id(capture_id: str) -> None:
    """Reject anything that is not a UUIDv7 before it becomes a path segment."""
    if not is_uuid7(capture_id):
        raise ApiError(
            status_code=404,
            code="capture_not_found",
            message=f"Not a capture id: {capture_id}",
            details={"capture_id": capture_id},
        )


def _parse_cursor(cursor: str | None) -> int | None:
    if cursor is None:
        return None
    try:
        return int(cursor)
    except ValueError as exc:
        raise ApiError(
            status_code=400,
            code="invalid_cursor",
            message="cursor must be an opaque token from a prior page.",
        ) from exc


__all__ = [
    "MAX_REAP_ATTEMPTS",
    "CaptureService",
    "UNFINALIZED_STATES",
    "reject_overlapping_destination",
]
