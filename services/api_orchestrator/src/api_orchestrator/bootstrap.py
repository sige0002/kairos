"""Bringing the capture store up: identity, invariants, rebuild, resume.

Contract §8 (rebuild) and §7 (startup delete-resume). Startup is where the
store's promises are either established or discovered to be broken, so the order
matters and every step is deliberate about what it does when it fails:

**Identity first.** ``instance.json`` is what every replica row is keyed by, so
a corrupt one is fatal rather than a reason to mint a fresh id — a new id would
orphan every replica and every sidecar that names the old one.

**Then the invariants that make the design work at all.** If ``objects/``,
``.trash/`` and ``.incoming/`` are not one filesystem, deletion is withdrawn
(503) rather than degraded into a copy (§2). The 1 MB ledger slack is reserved
now, before the disk can fill, because the whole point of it is to be available
at the moment nothing else is (§5).

**Rebuild only when the index is untrustworthy.** Missing database, wrong schema
version, or an explicit request (§8) — not on every boot. An unreadable
*ledger* aborts startup outright: the ledger outranks the manifests, so
rebuilding without it would resurrect every capture an operator destroyed, and
starting with a catalog that quietly did that is worse than not starting.

**Delete-resume on every startup, rebuild or not.** A crash between the ledger
append and the rename leaves no ``delete_pending`` row to find, so the ledger is
scanned each time (§7). This is cheap and it is the only thing that finishes a
deletion the operator already believes happened.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

from kairos_common import ledger_v2
from kairos_common import rebuild as rebuild_mod
from kairos_common.instance import CorruptInstanceError, load_or_create_instance
from kairos_common.time import utc_now_iso8601

from api_orchestrator import layout as layout_mod
from api_orchestrator.captures import CaptureService
from api_orchestrator.health import RebuildReport, StoreHealth
from api_orchestrator.layout import DataLayout
from api_orchestrator.recorder_client import (
    LIVE_CAPTURE_IDS_FIELD,
    live_capture_ids,
)
from api_orchestrator.store import CaptureStore

logger = logging.getLogger("kairos")

# Set this to force a rebuild on the next start. The deployment equivalent of
# "delete kairos.db and restart", without asking an operator to remove a file
# from a running container.
REBUILD_ENV_VAR = "KAIROS_REBUILD"


class StoreStartupError(RuntimeError):
    """Startup cannot safely continue. The message is for an operator."""


@dataclass(frozen=True)
class PreparedStore:
    """What :func:`prepare_store` established before any service was built."""

    layout: DataLayout
    instance_id: str
    health: StoreHealth


def prepare_store(
    data_dir: str | os.PathLike[str], health: StoreHealth
) -> PreparedStore:
    """Create the directory layout and settle this installation's identity.

    Runs synchronously at app-construction time because everything downstream —
    the store's replica keys, the capture service, the digest job — needs
    ``instance_id`` before it can be built.
    """
    layout = DataLayout(data_dir=_as_path(data_dir))
    layout.ensure_dirs()
    try:
        info = load_or_create_instance(layout.data_dir)
    except CorruptInstanceError as exc:
        raise StoreStartupError(
            f"{exc}. instance.json names this installation and every replica "
            "row is keyed by it, so it cannot be regenerated. Restore it from "
            "a backup, or delete it deliberately to start a NEW installation "
            "(every existing replica row will then be orphaned)."
        ) from exc

    health.instance_id = info.instance_id

    reason = layout_mod.check_same_filesystem(layout)
    if reason is not None:
        logger.error("deletion APIs disabled: %s", reason)
        health.disable_deletes(reason)

    try:
        ledger_v2.ensure_slack(layout.data_dir)
    except OSError as exc:
        # Worth reporting, not worth refusing to start: the slack only matters
        # once the disk is full, and a disk already too full to reserve 1 MB is
        # a condition the operator needs to see rather than a boot failure.
        logger.error(
            "could not reserve the ledger slack file; a discard on a full disk "
            "may fail to append: %s",
            exc,
        )

    if layout_mod.ensure_volume_marker(layout) is None:
        logger.error(
            "no volume marker at %s; the reconciler will refuse to mark "
            "captures missing until one can be written",
            layout.data_dir,
        )

    return PreparedStore(layout=layout, instance_id=info.instance_id, health=health)


def should_rebuild(store: CaptureStore, *, force: bool = False) -> str | None:
    """Why a rebuild is required, or ``None`` if the index can be trusted (§8)."""
    if force or os.environ.get(REBUILD_ENV_VAR, "").strip().lower() in {
        "1",
        "true",
        "yes",
    }:
        return "requested"
    if store.was_discarded:
        return "schema_mismatch"
    if not store.existed_at_open:
        return "missing_database"
    return None


async def bootstrap_store(
    store: CaptureStore,
    prepared: PreparedStore,
    captures: CaptureService,
    *,
    recorder: Any | None = None,
    force_rebuild: bool = False,
) -> RebuildReport | None:
    """Rebuild if needed, then resume any interrupted deletion.

    Returns the rebuild report, or ``None`` if no rebuild was necessary. Raises
    :class:`StoreStartupError` when the ledger cannot be read — the one startup
    condition that must stop the process rather than degrade.
    """
    trigger = should_rebuild(store, force=force_rebuild)
    report: RebuildReport | None = None
    if trigger is not None:
        report = await _rebuild(store, prepared, recorder=recorder, trigger=trigger)

    # Always, rebuild or not (§7): a crash between the ledger append and the
    # rename leaves nothing in the database to find.
    #
    # And because it is always, this — not the rebuild above — is where an
    # ordinary installation MEETS a damaged ledger: database intact, nothing to
    # rebuild, one edited line. There is one startup story for an unreadable
    # ledger, and it does not depend on whether a rebuild happened to be
    # triggered on the way past.
    try:
        resumed = await captures.resume_delete_pending()
        resumed += await captures.resume_from_ledger()
    except ledger_v2.LedgerUnreadableError as exc:
        raise StoreStartupError(
            f"{exc}. lifecycle.jsonl is the only record of a deletion that was "
            "interrupted part-way, so starting without reading it would leave "
            "the bytes of a destroyed capture on disk with nothing left to "
            "finish the job. Restore or repair the file, then start again."
        ) from exc
    if resumed:
        logger.info("resumed %d interrupted deletion(s) at startup", resumed)
    return report


async def _rebuild(
    store: CaptureStore,
    prepared: PreparedStore,
    *,
    recorder: Any | None,
    trigger: str,
) -> RebuildReport:
    """Scan the sidecars and write the catalog they imply."""
    live, reachable = await _ask_recorder(recorder)
    logger.info(
        "rebuilding the capture catalog from sidecars (trigger=%s, "
        "recorder_reachable=%s, live=%d)",
        trigger,
        reachable,
        len(live),
    )

    known_revisions = {
        row["capture_id"]: row["review_revision"]
        for row in store.execute_read(
            "SELECT capture_id, review_revision FROM captures"
        )
    }
    try:
        result = rebuild_mod.rebuild(
            prepared.layout.data_dir,
            instance_id=prepared.instance_id,
            recorder_reachable=reachable,
            live_exclusions=live,
            known_revisions=known_revisions,
        )
    except ledger_v2.LedgerUnreadableError as exc:
        raise StoreStartupError(
            f"{exc}. lifecycle.jsonl records every capture that was discarded, "
            "deleted or archived, and it outranks the manifests still on disk. "
            "Rebuilding without it would bring back recordings an operator "
            "deliberately destroyed, so startup stops here. Restore or repair "
            "the file, then start again."
        ) from exc

    store.apply_rebuild(captures=result.captures, replicas=result.replicas)
    restored = store.restore_catalog_from_sidecars()

    for entry in result.corrupt:
        logger.error(
            "corrupt sidecar: %s (%s)",
            entry.path,
            entry.reason,
            extra={"capture_id": entry.capture_id},
        )
    for warning in result.warnings:
        logger.warning("rebuild: %s", warning)
    orphaned = store.orphaned_batch_ids()
    if orphaned:
        # The one part of the catalog a rebuild cannot restore: a batch's own
        # row has no sidecar and no ledger line, so it does not come back with
        # the recordings that name it. Saying so is the whole remedy — the
        # numbers and labels are not recoverable from anywhere — but an
        # operator whose Collect strip went empty deserves the reason in the
        # log rather than a silently shorter list.
        logger.warning(
            "rebuild: %d recording(s) name %d batch(es) that no longer exist "
            "(%s). A batch's own row lives only in kairos.db, so it does not "
            "survive a rebuild; the recordings themselves are intact.",
            sum(orphaned.values()),
            len(orphaned),
            ", ".join(f"{batch_id} x{n}" for batch_id, n in orphaned.items()),
        )
    if result.deferred:
        logger.warning(
            "rebuild deferred %d unfinalized capture(s) because the recorder "
            "could not be asked about them; they will be revisited",
            len(result.deferred),
        )

    report = RebuildReport(
        at=utc_now_iso8601(),
        captures=len(result.captures),
        replicas=len(result.replicas),
        deferred=result.deferred,
        corrupt=tuple(
            {"capture_id": c.capture_id, "path": c.path, "reason": c.reason}
            for c in result.corrupt
        ),
        warnings=result.warnings,
        trigger=trigger,
    )
    prepared.health.record_rebuild(report)
    logger.info(
        "rebuild complete: %d captures, %d replicas, %d corrupt, %s restored",
        report.captures,
        report.replicas,
        len(report.corrupt),
        restored,
    )
    return report


async def _ask_recorder(recorder: Any | None) -> tuple[set[str], bool]:
    """``(live capture ids, reachable)`` — §8 rule 1's first step.

    A missing recorder client counts as reachable-with-nothing-live: a split
    recording PC has no local recorder, and there is genuinely nothing on this
    host that could be mid-write.

    A recorder that answers but omits ``live_capture_ids`` counts as
    UNREACHABLE (§10 rev.2.4), not as idle. Reading a missing array as "nothing
    is live" is precisely how a rename turns into silent data loss: every
    in-flight recording would be normalized to ``interrupted`` while the
    recorder was still writing it.
    """
    if recorder is None:
        return set(), True
    try:
        status = await recorder.status()
    except Exception:  # noqa: BLE001 - unreachable is an expected answer
        logger.warning(
            "recorder unreachable during rebuild; unfinalized manifests will "
            "be left alone rather than normalized to interrupted"
        )
        return set(), False

    live = live_capture_ids(status)
    if live is None:
        logger.error(
            "the recorder answered /record/status without a %s array; treating "
            "it as unreachable so live recordings are not normalized away",
            LIVE_CAPTURE_IDS_FIELD,
        )
        return set(), False
    return live, True


def _as_path(value: str | os.PathLike[str]):  # noqa: ANN202 - trivial
    from pathlib import Path

    return Path(value)
