"""The periodic pass that keeps the catalog and the disk agreeing.

Contract §8 (adoption, digest re-enqueue), §7 (delete resume, the reaper) and
§9-3 (the threshold guard). One pass does five things, in an order chosen so
that the destructive ones are the last to happen and the easiest to abort:

1. read the volume marker;
2. scan ``objects/`` and work out what a fresh rebuild would conclude;
3. **re-read the volume marker** — and throw the whole pass away if it changed;
4. apply the threshold guard to the proposed missing-transitions;
5. only then: adopt orphans, mark missing, resume deletions, reap, re-enqueue
   digests.

Steps 1 and 3 are the same read for a reason. A bind mount that came unmounted
during the scan presents an empty directory, and every capture then looks
deleted. Comparing the marker *after* the scan is what distinguishes "the files
are gone" from "the volume is gone", and the second must never be written into
the catalog — recording ``missing_unmanaged`` across a whole store because a
mount flapped is not a recovery, it is the incident.

The threshold in step 4 is the second line of the same defence, for the case
where the marker survives but the data does not: past ``max(5, 10%)`` missing
copies the pass refuses to apply anything and latches SUSPECT, which also stops
the reaper and every digest until an operator looks (§9-3). Recording, review
saves and browsing the catalog are deliberately *not* stopped — SUSPECT means
"do not destroy anything", not "stop working".
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from kairos_common import ledger_v2
from kairos_common import rebuild as rebuild_mod
from kairos_common.capture_sidecars import (
    TERMINAL_STATES,
    CaptureState,
    SidecarStatus,
    read_object_manifest,
)
from kairos_common.ids import is_uuid7
from kairos_common.rebuild import ReplicaState

from api_orchestrator import layout as layout_mod
from api_orchestrator import transfer
from api_orchestrator import views as views_mod
from api_orchestrator.captures import CaptureService
from api_orchestrator.digest import DigestJob
from api_orchestrator.health import StoreHealth, missing_threshold
from api_orchestrator.layout import DataLayout
from api_orchestrator.recorder_client import live_capture_ids
from api_orchestrator.store import PRESENT_REPLICA_STATES, CaptureStore

logger = logging.getLogger("kairos")

# How often the background pass runs. Long enough that a busy recording host is
# not scanning constantly, short enough that an orphaned import shows up in the
# UI while the operator is still looking for it.
DEFAULT_INTERVAL_S = 120.0

# Capture states whose local copy is *supposed* to be gone. A replica of one of
# these that is absent from disk is the deletion working, not a loss.
_EXPECTED_ABSENT: frozenset[str] = frozenset(
    {
        CaptureState.delete_pending.value,
        CaptureState.discarded.value,
        CaptureState.deleted.value,
    }
)


@dataclass
class ReconcileResult:
    """What one pass concluded and applied."""

    applied: bool = True
    skipped_reason: str | None = None
    adopted: int = 0
    # Existing rows brought back into agreement with their terminal manifest.
    settled: int = 0
    # Captures published out of .incoming/ into objects/ this pass (§10.6).
    arrived: tuple[str, ...] = ()
    missing: int = 0
    missing_candidates: tuple[str, ...] = ()
    resumed_deletes: int = 0
    reaped: int = 0
    digests_queued: int = 0
    corrupt: tuple[dict[str, Any], ...] = ()
    warnings: tuple[str, ...] = field(default_factory=tuple)
    threshold: int = 0
    denominator: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "applied": self.applied,
            "skipped_reason": self.skipped_reason,
            "adopted": self.adopted,
            "settled": self.settled,
            "arrived": list(self.arrived),
            "missing": self.missing,
            "resumed_deletes": self.resumed_deletes,
            "reaped": self.reaped,
            "digests_queued": self.digests_queued,
            "corrupt_count": len(self.corrupt),
            "warnings": list(self.warnings),
            "threshold": self.threshold,
            "denominator": self.denominator,
        }


def _facts_diverge(existing: Any, row: Any) -> bool:
    """Whether a terminal manifest's facts disagree with the catalog row.

    Only TERMINAL manifests are compared: until finalise the recorder is still
    writing, and its in-progress counters are less accurate than what the live
    session reports to us (§3.3).

    A ``None`` on the manifest side is "not measured", never "zero", so an older
    recorder that recorded no message count cannot blank one the row already
    holds. The cheap columns are compared here so a pass over an agreeing
    catalog does no file I/O at all; the authoritative re-read and the actual
    write happen once, in ``adopt_manifest_facts``.
    """
    if str(row.state) not in TERMINAL_STATES:
        return False
    if existing["state"] != str(row.state):
        return True
    return any(
        value is not None and existing[column] != value
        for column, value in (
            ("bytes", row.bytes),
            ("message_count", row.message_count),
            ("ended_at", row.ended_at),
        )
    )


class Reconciler:
    """The background pass. One instance per process; safe to run manually."""

    def __init__(
        self,
        store: CaptureStore,
        layout: DataLayout,
        health: StoreHealth,
        captures: CaptureService,
        digest: DigestJob,
        *,
        instance_id: str,
        recorder: Any | None = None,
        interval_s: float = DEFAULT_INTERVAL_S,
    ) -> None:
        self._store = store
        self._layout = layout
        self._health = health
        self._captures = captures
        self._digest = digest
        self._instance_id = instance_id
        self._recorder = recorder
        self._interval_s = interval_s
        self._task: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()

    # ---- background loop ---------------------------------------------------

    async def start(self) -> None:
        """Begin the periodic pass (no-op if already running)."""
        if self._task is not None:
            return
        self._stopping.clear()
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        """Stop the periodic pass and wait for the current one to finish."""
        self._stopping.set()
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def _loop(self) -> None:
        while not self._stopping.is_set():
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=self._interval_s)
                return  # stop() was called
            except TimeoutError:
                pass
            try:
                result = await self.run_once()
                if result.applied and result.digests_queued:
                    # Re-queueing without running would leave a digest that a
                    # crash interrupted pending forever: the stop path is the
                    # only other trigger, and that recording is already over.
                    await self.run_digests()
            except Exception:  # noqa: BLE001 - the loop must outlive one bad pass
                logger.exception("reconciler pass failed")

    # ---- one pass ----------------------------------------------------------

    async def run_once(self, *, approved: bool = False) -> ReconcileResult:
        """Run a full reconciliation pass and return what it did.

        *approved* is the operator's Repair (§9-3): it bypasses the threshold
        guard, because the guard's whole purpose is to withhold a decision until
        a human confirms the copies really are gone. The volume-marker checks
        are NOT bypassed — an approval that cannot name the volume it is
        approving is meaningless, so those still discard the pass.
        """
        marker_before = layout_mod.read_volume_marker(self._layout)
        if marker_before is None:
            result = ReconcileResult(
                applied=False,
                skipped_reason=(
                    "no readable volume marker; refusing to decide what is "
                    "missing on a volume that cannot identify itself"
                ),
            )
            # No corrupt observation: this pass never scanned, and "we did not
            # look" must not be recorded as "nothing is corrupt".
            self._health.record_reconcile(result.to_dict())
            return result

        # Publish staged arrivals BEFORE the scan, so a capture pulled from the
        # robot gets its row in THIS pass rather than the next one. Ordering it
        # here is safe: the move is between two directories on the volume whose
        # marker we just confirmed, and it destroys nothing — the post-scan
        # marker re-check below still guards every catalog write.
        arrived = await asyncio.to_thread(self._adopt_incoming)

        # Asked on the event loop, before the scan moves to a worker thread: a
        # rebuild's every decision about an unfinalized manifest depends on
        # whether the recorder was reachable, and a thread cannot make an async
        # call without owning a second loop.
        live = await self._live_capture_ids()
        scan = await asyncio.to_thread(self._scan, live)

        marker_after = layout_mod.read_volume_marker(self._layout)
        if marker_after != marker_before:
            result = ReconcileResult(
                applied=False,
                skipped_reason=(
                    f"the volume marker changed during the scan "
                    f"({marker_before} -> {marker_after}); discarding the pass"
                ),
            )
            logger.warning("reconciler: %s", result.skipped_reason)
            # The scan happened but was discarded — it described a volume we
            # cannot confirm, so its corrupt list is not evidence either.
            self._health.record_reconcile(result.to_dict())
            return result

        result = await self._apply(scan, approved=approved)
        result.arrived = arrived
        # A completed scan is a COMPLETE observation of what is corrupt, so it
        # supersedes the startup rebuild's list — including when the threshold
        # guard blocked the pass's writes, since corruption is something the
        # scan SAW rather than something it decided to apply. A scan that
        # aborted on an unreadable ledger saw nothing and is excluded.
        self._health.record_reconcile(
            result.to_dict(),
            corrupt=None if scan.ledger_unreadable is not None else result.corrupt,
        )
        return result

    def _adopt_incoming(self) -> tuple[str, ...]:
        """Move completed ``.incoming/<id>`` staging dirs into ``objects/``.

        §10.6's landing step, and the reason it lives here rather than only in
        the importer: an importer killed between its rsync and its rename would
        otherwise leave a fully-transferred capture in staging forever, visible
        to nothing. The reconciler is the process that always comes back.

        Only a staging dir whose manifest is present and terminal is published —
        anything else is a transfer still in flight (or one that died mid-copy),
        and moving it into ``objects/`` would break §2's invariant that an
        incomplete directory there can only be a live recording.
        """
        published: list[str] = []
        try:
            entries = sorted(self._layout.incoming.iterdir())
        except OSError:
            return ()
        for entry in entries:
            if not entry.is_dir() or entry.is_symlink():
                continue
            capture_id = entry.name
            if not is_uuid7(capture_id):
                continue
            read = read_object_manifest(entry)
            if read.status is not SidecarStatus.ok or read.manifest is None:
                continue
            if read.manifest.state not in TERMINAL_STATES:
                continue
            try:
                transfer.adopt_incoming(self._layout, capture_id)
            except transfer.ArrivalConflictError as exc:
                # objects/<id> already holds a real capture. Two copies claim
                # one id; keeping the published one and reporting is the only
                # safe answer — we have not compared their bytes.
                logger.warning(
                    "staged capture could not be published: %s",
                    exc,
                    extra={"capture_id": capture_id},
                )
            except OSError as exc:
                logger.warning(
                    "staged capture could not be published",
                    extra={"capture_id": capture_id, "error": str(exc)},
                )
            else:
                published.append(capture_id)
                logger.info(
                    "published a transferred capture",
                    extra={"capture_id": capture_id},
                )
        return tuple(published)

    @dataclass
    class _Scan:
        """Everything the filesystem pass observed, with nothing applied."""

        adoptable: list[Any] = field(default_factory=list)
        adoptable_replicas: list[Any] = field(default_factory=list)
        # Existing rows whose terminal manifest disagrees with the catalog.
        settleable: list[str] = field(default_factory=list)
        missing: list[str] = field(default_factory=list)
        trashed: list[str] = field(default_factory=list)
        corrupt: list[dict[str, Any]] = field(default_factory=list)
        warnings: list[str] = field(default_factory=list)
        ledger_unreadable: str | None = None

    def _scan(self, live: set[str] | None) -> _Scan:
        """Read the disk. Pure observation — nothing here writes anything.

        *live* is the recorder's in-flight capture ids, or ``None`` when the
        recorder could not be asked — which is passed through as
        ``recorder_reachable=False`` so the rebuild DEFERS unfinalized
        manifests instead of normalizing a live recording to ``interrupted``.
        """
        scan = self._Scan()
        try:
            result = rebuild_mod.rebuild(
                self._layout.data_dir,
                instance_id=self._instance_id,
                recorder_reachable=live is not None,
                live_exclusions=live or (),
            )
        except ledger_v2.LedgerUnreadableError as exc:
            # Without the ledger a scan cannot tell a discarded capture from a
            # live one, so adopting anything would risk resurrecting data an
            # operator destroyed. Report and apply nothing.
            scan.ledger_unreadable = str(exc)
            return scan

        # One query for every row's recording facts, not one per capture: this
        # is also the divergence check below, so the whole comparison costs a
        # single SELECT rather than a read per terminal capture per pass.
        known = {
            row["capture_id"]: row
            for row in self._store.execute_read(
                "SELECT capture_id, state, bytes, message_count, ended_at FROM captures"
            )
        }
        adoptable_ids: set[str] = set()
        for row in result.captures:
            existing = known.get(row.capture_id)
            if existing is None:
                scan.adoptable.append(row)
                adoptable_ids.add(row.capture_id)
            elif _facts_diverge(existing, row):
                # §8: a terminal manifest beats whatever the row says. The row
                # is only a cache of it, and the paths that can settle a capture
                # WITHOUT the stop path (a recorder restart writing its own
                # recovery manifest) leave the cache stale by construction.
                scan.settleable.append(row.capture_id)
        # Corrupt replicas are kept regardless of the adoptable filter. By
        # design they have NO capture row (§8 rule 4 forbids inventing one from
        # an unreadable manifest), so filtering replicas down to adoptable
        # captures would drop them entirely and the catalog would show no trace
        # of bytes that are sitting right there needing repair.
        scan.adoptable_replicas = [
            r
            for r in result.replicas
            if r.capture_id in adoptable_ids
            or str(r.state) == ReplicaState.corrupt.value
        ]
        scan.corrupt = [
            {"capture_id": c.capture_id, "path": c.path, "reason": c.reason}
            for c in result.corrupt
        ]
        scan.warnings = list(result.warnings)

        # Missing detection, from the catalog's side: a copy this instance
        # claims to hold whose directory is no longer there.
        for capture_id, _replica in self._store.list_replicas_by_state(
            self._instance_id, sorted(PRESENT_REPLICA_STATES)
        ):
            capture = self._store.get_capture(capture_id)
            if capture is not None and str(capture.state) in _EXPECTED_ABSENT:
                continue
            if not self._layout.capture_dir(capture_id).exists():
                scan.missing.append(capture_id)

        scan.trashed = [
            capture_id
            for capture_id, _ in self._store.list_replicas_by_state(
                self._instance_id, [ReplicaState.trashed.value]
            )
        ]
        return scan

    async def _apply(self, scan: _Scan, *, approved: bool = False) -> ReconcileResult:
        """Write the scan's conclusions, subject to the §9-3 threshold guard.

        Async only because the delete-resume it drives takes each capture's
        mutex (§4.1's, shared with review saves) — the catalog writes here are
        all synchronous SQLite.
        """
        denominator = self._store.count_present_replicas(self._instance_id)
        threshold = missing_threshold(denominator)
        result = ReconcileResult(
            corrupt=tuple(scan.corrupt),
            warnings=tuple(scan.warnings),
            threshold=threshold,
            denominator=denominator,
            missing_candidates=tuple(scan.missing),
        )

        if scan.ledger_unreadable is not None:
            result.applied = False
            result.skipped_reason = (
                f"the lifecycle ledger is unreadable ({scan.ledger_unreadable}); "
                "no capture was adopted or marked missing"
            )
            logger.error("reconciler: %s", result.skipped_reason)
            return result

        if len(scan.missing) > threshold and not approved:
            # Not "mark them and warn": §9-3 says apply NOTHING from this pass.
            # A storage fault that ate 200 captures must not also rewrite 200
            # rows on the way past.
            reason = (
                f"{len(scan.missing)} local copies vanished at once "
                f"(threshold {threshold} of {denominator} present replicas); "
                "no automatic missing-transition, reaping or digest will run "
                "until this is repaired"
            )
            result.applied = False
            result.skipped_reason = reason
            if self._health.latch_suspect(reason):
                logger.error("store entered SUSPECT: %s", reason)
            return result

        for row in scan.adoptable:
            logger.info(
                "adopting an orphaned capture directory",
                extra={"capture_id": row.capture_id, "state": str(row.state)},
            )
        result.adopted = self._store.apply_rebuild(
            captures=scan.adoptable, replicas=scan.adoptable_replicas
        )

        for capture_id in scan.settleable:
            if self._captures.adopt_manifest_facts(capture_id):
                result.settled += 1

        for capture_id in scan.missing:
            # §9-2: bytes removed behind kairos's back are NOT a deletion. The
            # capture row is untouched and the replica says the copy vanished
            # without anyone asking, so it surfaces as a warning rather than
            # looking like a completed cleanup.
            self._store.upsert_replica(
                capture_id, self._instance_id, ReplicaState.missing_unmanaged
            )
            logger.warning(
                "a capture's local copy disappeared without being deleted",
                extra={"capture_id": capture_id},
            )
        result.missing = len(scan.missing)

        result.resumed_deletes = await self._captures.resume_delete_pending()
        result.resumed_deletes += await self._captures.resume_from_ledger()
        # The slack is consumed by a discard on a full disk (§5). Re-reserving
        # it here means a store that has since freed space is ready for the NEXT
        # emergency rather than one discard away from being stuck again.
        self._captures.ensure_ledger_slack()

        if not self._health.suspect:
            for capture_id in scan.trashed:
                if self._captures.reap(capture_id):
                    result.reaped += 1

        result.digests_queued = len(
            self._store.captures_needing_digest(self._instance_id)
        )
        # Sweep superseded views generations past their grace (§6). The
        # count-based prune only runs on regeneration, so the last tree before
        # a quiet period — say, the one from before a dataset archived — would
        # otherwise sit beside ``views`` indefinitely as dangling-symlink
        # debris. Derived state only; nothing the catalog answers from.
        await asyncio.to_thread(views_mod.prune_stale, self._layout)
        return result

    async def run_digests(self) -> int:
        """Run every queued digest. Split from :meth:`run_once` so a pass can
        return promptly and the hashing can proceed at its own pace."""
        return await self._digest.run_pending()

    async def _live_capture_ids(self) -> set[str] | None:
        """Capture ids the recorder reports in flight, or ``None`` if unreachable.

        The two answers are deliberately different values, not both "empty":
        "the recorder says none" licenses normalizing an abandoned ``recording``
        manifest to ``interrupted``, and "we could not ask" does not. A status
        body with no ``live_capture_ids`` array is the second kind — an old or
        broken recorder — so it propagates as ``None`` rather than being read
        as an idle recorder (§10 rev.2.4).
        """
        if self._recorder is None:
            # No recorder in this deployment (a split recording PC) — nothing
            # local can be mid-write, which is a real answer, not an unknown.
            return set()
        try:
            status = await self._recorder.status()
        except Exception:  # noqa: BLE001 - unreachable is a valid answer
            return None
        return live_capture_ids(status)
