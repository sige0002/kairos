"""The dataset archive run (§6.x): freeze, copy out one member at a time, seal.

The terminal transition for a dataset. ``POST /datasets/{id}/archive`` runs the
synchronous half here — validate the destination, freeze the member set with a
CAS on ``datasets.status`` plus a ``dataset_archive_started`` ledger event —
and then an in-process runner copies each member out through the same
copy → verify → ledger → row → trash sequence as a per-capture archive
(:meth:`CaptureService.archive_member`). When every member is out, the run
writes the final ``dataset_manifest.json``, appends the ``dataset_archived``
seal carrying that manifest's hash, and flips the row to ``archived``.

**A halted run stays ``archiving``.** Any member that cannot proceed — a lease
appeared, the ledger refused an append, the destination grew unexpected files —
stops the run where it stands and reports why. Nothing rolls back: bytes that
were verified and recorded are not un-archived, and the next ``POST`` resumes
from the ledger's own record of which members are done. The one rollback in
this file is the start itself, and only when the ``started`` event could not be
appended — at which point no byte has moved.

**No auto-resume on startup.** A crashed run comes back from the ledger replay
as ``archiving`` with ``running: false``, and the UI offers Resume. This is a
write to storage the operator chose, possibly a NAS that has since been
unplugged; continuing it is their call, not a side effect of a restart.

**The manifest is written from the first member, not the last.** A run that
dies half-way leaves a destination folder someone will open years later; the
manifest is what lets that folder say "dataset X, members 001–002 sealed, the
rest never arrived" instead of being an anonymous pile of directories. The
final rewrite records ``status: complete``, and the seal event carries the
final manifest's sha256 — manifest first, then its hash into the ledger, a
one-way dependency that lets the ledger alone catch a manifest edited after
the seal.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from kairos_common import ApiError, ledger_v2
from kairos_common.archive_paths import resolve_archive_destination
from kairos_common.atomic_io import atomic_write_text
from kairos_common.capture_sidecars import CaptureState
from kairos_common.rebuild import ReplicaState
from kairos_common.time import utc_now_iso8601

from api_orchestrator import layout as layout_mod
from api_orchestrator.captures import CaptureService, reject_overlapping_destination
from api_orchestrator.health import StoreHealth, require_delete_available
from api_orchestrator.layout import DataLayout
from api_orchestrator.ledger_guard import append_or_503
from api_orchestrator.models import DatasetArchiveProgress, DatasetMember
from api_orchestrator.store import ArchiveDestinationTakenError, CaptureStore
from api_orchestrator.views import sanitize_component

logger = logging.getLogger("kairos")

MANIFEST_NAME = "dataset_manifest.json"
MANIFEST_SCHEMA_VERSION = 1

# The subset of ``views._UNSAFE`` that applies to an operator-supplied archive
# path: separators are meaningful here (the path is multi-component), a control
# character never is.
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


@dataclass
class _RunState:
    """The volatile half of one run's progress (the durable half is rows)."""

    running: bool = False
    current_capture_id: str | None = None
    current_bytes: int | None = None
    error: dict[str, Any] | None = None


class DatasetArchiver:
    """Owns the dataset archive run: the preflight, the runner, the progress.

    Modeled on ``DigestJob`` rather than a dora_runner pipeline — moving files
    is no longer dora_runner's job (its registry retired ``dataset_export``
    for exactly this reason), and an in-process task can hold the §9-1
    ordering per member without a second service's failure modes.
    """

    def __init__(
        self,
        store: CaptureStore,
        layout: DataLayout,
        health: StoreHealth,
        captures: CaptureService,
        *,
        instance_id: str,
        on_views_change: Callable[[], None] | None = None,
    ) -> None:
        self._store = store
        self._layout = layout
        self._health = health
        self._captures = captures
        self._instance_id = instance_id
        self._on_views_change = on_views_change
        # Strong refs, like DigestJob: a garbage-collected run would stop
        # copying with no record of why.
        self._tasks: set[asyncio.Task[Any]] = set()
        self._locks: dict[str, asyncio.Lock] = {}
        self._runs: dict[str, _RunState] = {}

    # ---- the synchronous half (request-time) --------------------------------

    async def start(
        self,
        dataset_id: str,
        *,
        destination: str | None,
        path: str | None,
        mode: str | None,
        reason: str | None,
        roots: list[Path],
    ) -> DatasetArchiveProgress:
        """Start a new run, or resume a halted one. Returns initial progress.

        ``mode`` picks what the run does to the sources: ``move`` (the
        default) removes each verified member from this machine and demands
        exclusive members; ``copy`` seals the set and touches nothing — the
        legal mode for a combined dataset that shares recordings with its
        sources. Everything here happens before the 202: by the time the
        response leaves, the member set (and the mode) is frozen in the
        ledger and the runner owns the rest. A failure to append the
        ``started`` event rolls the CAS back — the only rollback in the
        archive, legal because no byte has moved yet.
        """
        dataset = self._store.get_dataset(dataset_id)
        if dataset is None:
            raise ApiError(
                status_code=404,
                code="dataset_not_found",
                message=f"Dataset not found: {dataset_id}",
                details={"dataset_id": dataset_id},
            )
        if dataset["status"] == "archived":
            raise ApiError(
                status_code=409,
                code="dataset_archived",
                message=(
                    "This dataset was already archived to "
                    f"{dataset.get('archive_destination')}."
                ),
                details={"dataset_id": dataset_id},
            )
        if dataset["status"] == "archiving":
            self._resume(dataset_id, dataset, destination, path, mode, roots)
            return self.progress_for(dataset_id)

        run_mode = mode or "move"
        if run_mode == "move":
            # Only the move run deletes sources; a copy run must stay possible
            # even where deleting is withdrawn (§7's cross-device 503).
            self._require_delete_available()
        members = self._store.list_dataset_members(dataset_id)
        if not members:
            raise ApiError(
                status_code=409,
                code="dataset_empty",
                message=(
                    "This dataset has no members; there is nothing to archive. "
                    "If the dataset itself is finished with, delete it."
                ),
                details={"dataset_id": dataset_id},
            )
        dataset_dir = self._dataset_dir(dataset, destination, path, roots)
        # The allow-list said writing there is permitted; this says the target
        # is not our own bytes. Two different questions (§6).
        reject_overlapping_destination(
            dataset_dir, self._layout.data_dir, self._layout.data_dir
        )
        self._preflight_members(dataset_id, members, mode=run_mode)
        if dataset_dir.exists() and any(dataset_dir.iterdir()):
            raise ApiError(
                status_code=409,
                code="destination_not_empty",
                message=(
                    f"{dataset_dir} already contains files — refusing to "
                    "archive into it. Choose another path, or clear it if it "
                    "is the debris of an abandoned run."
                ),
                details={"dataset_id": dataset_id, "destination": str(dataset_dir)},
            )

        try:
            claimed = self._store.begin_dataset_archive(
                dataset_id, destination=str(dataset_dir), mode=run_mode
            )
        except ArchiveDestinationTakenError as exc:
            # The folder looked empty a moment ago, but a run that has not
            # copied anything yet leaves it empty, and so does an operator who
            # cleared an abandoned run's debris. Emptiness was never the
            # question: the destination is one dataset's, and the other one is
            # still entitled to it.
            other = self._store.get_dataset(exc.held_by)
            raise ApiError(
                status_code=409,
                code="destination_claimed",
                message=(
                    f"{dataset_dir} belongs to dataset "
                    f"{(other or {}).get('name') or exc.held_by}, which is "
                    f"{(other or {}).get('status') or 'archiving'} there. Two "
                    "datasets in one folder would interleave their numbers "
                    "under a single manifest; choose another path."
                ),
                details={
                    "dataset_id": dataset_id,
                    "destination": str(dataset_dir),
                    "held_by": exc.held_by,
                },
            ) from exc
        if not claimed:
            # Lost the CAS: someone else moved the status between our read and
            # this write. Whatever they did, this request's premise is stale.
            raise ApiError(
                status_code=409,
                code="dataset_not_active",
                message="The dataset's status changed underneath this request.",
                details={"dataset_id": dataset_id},
            )
        try:
            self._append_started(
                dataset_id, dataset, members, dataset_dir, run_mode, reason
            )
        except ApiError:
            self._store.abort_dataset_archive(dataset_id)
            raise
        # The status filter just removed this dataset from the views input;
        # regenerate so the tree stops citing bytes that are about to leave.
        self._views_changed()
        self._launch(dataset_id)
        return self.progress_for(dataset_id)

    def progress_for(self, dataset_id: str) -> DatasetArchiveProgress:
        """One dataset's archive progress: durable rows + volatile run state."""
        dataset = self._store.get_dataset(dataset_id)
        if dataset is None:
            raise ApiError(
                status_code=404,
                code="dataset_not_found",
                message=f"Dataset not found: {dataset_id}",
                details={"dataset_id": dataset_id},
            )
        done, total = self._member_progress(dataset_id, dataset)
        run = self._runs.get(dataset_id)
        return DatasetArchiveProgress(
            dataset_id=dataset_id,
            status=dataset["status"],
            destination=dataset.get("archive_destination"),
            mode=dataset.get("archive_mode"),
            member_total=total,
            members_done=done,
            running=self.is_running(dataset_id),
            current_capture_id=run.current_capture_id if run else None,
            current_bytes=run.current_bytes if run else None,
            error=run.error if run else None,
            archive_started_at=dataset.get("archive_started_at"),
            archived_at=dataset.get("archived_at"),
        )

    def is_running(self, dataset_id: str) -> bool:
        run = self._runs.get(dataset_id)
        return run is not None and run.running

    async def drain(self) -> None:
        """Await in-flight runs (shutdown, and test determinism)."""
        tasks = list(self._tasks)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    # ---- start/resume internals ---------------------------------------------

    def _resume(
        self,
        dataset_id: str,
        dataset: dict[str, Any],
        destination: str | None,
        path: str | None,
        mode: str | None,
        roots: list[Path],
    ) -> None:
        if self.is_running(dataset_id):
            raise ApiError(
                status_code=409,
                code="archive_in_progress",
                message="This dataset's archive run is already executing.",
                details={"dataset_id": dataset_id},
            )
        recorded_mode = dataset.get("archive_mode") or "move"
        if mode is not None and mode != recorded_mode:
            # A resume continues the run the ledger froze; switching what it
            # DOES to the sources mid-run would make the seal describe a run
            # that never happened.
            raise ApiError(
                status_code=409,
                code="archive_mode_mismatch",
                message=(
                    f"This run was started as '{recorded_mode}'; resume sends "
                    "no mode (or the same one)."
                ),
                details={
                    "dataset_id": dataset_id,
                    "recorded": recorded_mode,
                    "requested": mode,
                },
            )
        if recorded_mode == "move":
            self._require_delete_available()
        recorded = dataset.get("archive_destination")
        if destination:
            requested = str(self._dataset_dir(dataset, destination, path, roots))
            if requested != recorded:
                # A resume may only continue the run the ledger froze. A new
                # destination is a different archive, and this dataset already
                # has bytes at the first one.
                raise ApiError(
                    status_code=409,
                    code="archive_destination_mismatch",
                    message=(
                        f"This run is already archiving to {recorded}; resume "
                        "sends no destination (or the same one)."
                    ),
                    details={
                        "dataset_id": dataset_id,
                        "recorded": recorded,
                        "requested": requested,
                    },
                )
        self._launch(dataset_id)

    def _dataset_dir(
        self,
        dataset: dict[str, Any],
        destination: str | None,
        path: str | None,
        roots: list[Path],
    ) -> Path:
        """Resolve where the dataset lands under the allow-listed destination.

        The folder is the operator's to name: ``path`` is a free relative
        path, prefilled by the UI with the views shape
        (``<operator>/<task>/<name>``) and applied verbatim here. Omitted =
        that same default, sanitized exactly as ``views.py`` sanitizes it. A
        ``..`` (or any other escape) cannot leave the allow-list — the final
        directory is re-validated against the same roots as the destination,
        realpath and all.
        """
        base = resolve_archive_destination(destination or "", roots)
        if path is not None:
            # Absoluteness is judged BEFORE any stripping: stripping a leading
            # slash first would quietly relabel "/absolute" as relative.
            raw = path.strip()
            # Control characters go, separators and dots stay. The operator
            # names this folder freely and the slashes are meaningful here, but
            # "no newline in a generated path component" is the tree's rule
            # (views ``_UNSAFE``) and it cannot be a client's job to keep: this
            # path is otherwise applied verbatim, so a prefill carrying one
            # would spell the archive differently from views/ for one dataset.
            rel = _CONTROL_CHARS.sub("_", raw).rstrip("/")
            if not rel or raw.startswith("/") or Path(rel).is_absolute():
                raise ApiError(
                    status_code=400,
                    code="invalid_destination",
                    message="The archive path must be a non-empty relative path.",
                    details={"path": path},
                )
            final = Path(os.path.normpath(str(base / rel)))
            resolve_archive_destination(str(final), roots)
            return final
        return (
            base
            / sanitize_component(dataset.get("operator"), "unknown_operator")
            / sanitize_component(dataset.get("task"), "unknown_task")
            / sanitize_component(dataset.get("name"), "unnamed")
        )

    def _preflight_members(
        self, dataset_id: str, members: list[DatasetMember], *, mode: str
    ) -> None:
        """Walk every member once and report every problem at once.

        A deliberate departure from the one-error-one-code house style: the
        operation is N captures, and refusing it one capture per request would
        send the operator around this loop N times. ``conflicts`` (shared
        members — unsupported, the member must leave the other dataset first)
        and ``blockers`` (busy or missing captures) are separate codes because
        the operator fixes them in different places.
        """
        conflicts: list[dict[str, Any]] = []
        blockers: list[dict[str, Any]] = []
        for member in members:
            # Shared members block a MOVE only — a copy takes nothing away, so
            # sharing is exactly the situation it exists for (a combined set).
            # Memberships in copy-sealed datasets never count: those are
            # historical records, not claims on the local bytes.
            others = (
                [
                    m.dataset_id
                    for m in self._store.dataset_memberships_for(member.capture_id)
                    if m.dataset_id != dataset_id
                    and self._membership_pins_bytes(m.dataset_id)
                ]
                if mode == "move"
                else []
            )
            if others:
                conflicts.append(
                    {"capture_id": member.capture_id, "dataset_ids": others}
                )
                continue
            capture = self._store.get_capture(member.capture_id)
            if capture is None:
                blockers.append(
                    {
                        "capture_id": member.capture_id,
                        "code": "capture_not_found",
                        "message": "No catalog row for this member.",
                    }
                )
                continue
            if capture.state in (CaptureState.recording, CaptureState.stopping):
                blockers.append(
                    {
                        "capture_id": member.capture_id,
                        "code": "capture_recording",
                        "message": f"Still {capture.state}; stop it first.",
                    }
                )
                continue
            if self._store.has_live_lease(member.capture_id):
                blockers.append(
                    {
                        "capture_id": member.capture_id,
                        "code": "capture_busy",
                        "message": "A job holds this capture's lease.",
                    }
                )
                continue
            if (
                not self._layout.capture_dir(member.capture_id).is_dir()
                and capture.archived_at is None
            ):
                blockers.append(
                    {
                        "capture_id": member.capture_id,
                        "code": "capture_not_present",
                        "message": "No local copy to archive.",
                    }
                )
        if conflicts:
            raise ApiError(
                status_code=409,
                code="dataset_member_shared",
                message=(
                    f"{len(conflicts)} member(s) also belong to other datasets. "
                    "Archiving moves their bytes away, which would break those "
                    "datasets; remove the shared memberships first."
                ),
                details={"dataset_id": dataset_id, "conflicts": conflicts},
            )
        if blockers:
            raise ApiError(
                status_code=409,
                code="dataset_not_archivable",
                message=(
                    f"{len(blockers)} member(s) cannot be archived right now; "
                    "each is listed with its own reason."
                ),
                details={"dataset_id": dataset_id, "blockers": blockers},
            )

    def _membership_pins_bytes(self, dataset_id: str) -> bool:
        """Whether a membership claims the capture's LOCAL bytes (§6.1).

        Mirrors ``CaptureService._membership_blocks``: a copy-sealed dataset
        (archived, mode copy) is a record of an export, not a claim on the
        recordings still here.
        """
        dataset = self._store.get_dataset(dataset_id)
        if dataset is None:
            return True
        return not (
            dataset["status"] == "archived" and dataset.get("archive_mode") == "copy"
        )

    def _append_started(
        self,
        dataset_id: str,
        dataset: dict[str, Any],
        members: list[DatasetMember],
        dataset_dir: Path,
        mode: str,
        reason: str | None,
    ) -> None:
        payload: dict[str, Any] = {
            "dataset_id": dataset_id,
            "destination": str(dataset_dir),
            "dataset_name": dataset.get("name") or dataset_id,
            "mode": mode,
            "members": [
                {
                    "membership_id": m.membership_id,
                    "capture_id": m.capture_id,
                    "display_index": m.display_index,
                }
                for m in members
            ],
        }
        for key, value in (
            ("operator", dataset.get("operator")),
            ("task", dataset.get("task")),
            ("reason", reason),
        ):
            if value:
                payload[key] = value
        append_or_503(
            self._layout.data_dir,
            "dataset_archive_started",
            instance_id=self._instance_id,
            payload=payload,
            failure=lambda exc: (
                f"The lifecycle ledger could not be written ({exc}), so "
                "the archive was not started. The frozen member set lives "
                "only in this file; without it a crashed run could not "
                "say what it was doing."
            ),
            details={"dataset_id": dataset_id},
        )

    def _launch(self, dataset_id: str) -> None:
        run = self._runs.setdefault(dataset_id, _RunState())
        run.running = True
        run.error = None
        task = asyncio.get_running_loop().create_task(self.run(dataset_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    # ---- the runner ---------------------------------------------------------

    async def run(self, dataset_id: str) -> None:
        """Execute one run to its end or its first halt. Never raises."""
        lock = self._locks.setdefault(dataset_id, asyncio.Lock())
        if lock.locked():
            return
        async with lock:
            run = self._runs.setdefault(dataset_id, _RunState())
            run.running = True
            try:
                await self._run(dataset_id, run)
            except ledger_v2.LedgerUnreadableError as exc:
                # Every durable question this run asks goes to the ledger: has
                # it sealed already, which members are out, what the frozen set
                # was. Unreadable, none of them can be answered — and the
                # dangerous answer is not an error but a plausible wrong one.
                # Hence no ``strict=False`` here either: it returns the lines
                # that parsed, and if the dropped one is this dataset's seal
                # the run reads "never sealed" and archives a second time —
                # in move mode deleting the sources of a dataset that already
                # left. So the run halts, which is a state resume was built for.
                logger.error(
                    "dataset archive run halted: the ledger could not be read",
                    extra={"dataset_id": dataset_id, "error": str(exc)},
                )
                run.error = {
                    "code": "ledger_unreadable",
                    "message": (
                        f"The lifecycle ledger could not be read: {exc}. The run "
                        "stopped where it stands rather than act on a history it "
                        "cannot see. Repair or restore the file and resume."
                    ),
                }
            except Exception:  # noqa: BLE001 - a run must never crash the app
                logger.exception(
                    "dataset archive run failed", extra={"dataset_id": dataset_id}
                )
                run.error = {
                    "code": "internal_error",
                    "message": "The archive run hit an unexpected error; "
                    "it can be resumed.",
                }
            finally:
                run.running = False
                run.current_capture_id = None
                run.current_bytes = None

    async def _run(self, dataset_id: str, run: _RunState) -> None:
        dataset = self._store.get_dataset(dataset_id)
        if dataset is None or dataset["status"] != "archiving":
            return
        destination = dataset.get("archive_destination")
        if not destination:
            run.error = {
                "code": "archive_destination_missing",
                "message": "The row records no destination; the ledger replay "
                "should have restored it.",
            }
            return
        dataset_dir = Path(destination)
        mode = dataset.get("archive_mode") or "move"
        members = self._store.list_dataset_members(dataset_id)

        sealed = self._seal_event(dataset_id)
        if sealed is None:
            # Copy mode's durable record of which members are done is the
            # manifest itself (no capture row changes, no per-member events),
            # so a resume seeds from what the last run wrote.
            results = (
                self._seed_copy_results(dataset_dir, members) if mode == "copy" else {}
            )
            # From the very first write the folder describes itself: a run
            # that dies mid-copy leaves "dataset X, these members pending",
            # not an anonymous pile of numbered directories.
            self._write_manifest(
                dataset,
                members,
                dataset_dir,
                mode=mode,
                results=results,
                complete=False,
            )
            for member in sorted(members, key=lambda m: m.display_index):
                run.current_capture_id = member.capture_id
                run.current_bytes = None
                target = dataset_dir / f"{member.display_index:03d}"
                done = (
                    await self._copy_member_out(member, target, run, results)
                    if mode == "copy"
                    else await self._member_out(dataset_id, member, target, run)
                )
                if not done:
                    return  # halted; the error is in run.error
                self._write_manifest(
                    dataset,
                    members,
                    dataset_dir,
                    mode=mode,
                    results=results,
                    complete=False,
                )
            manifest_bytes = self._write_manifest(
                dataset, members, dataset_dir, mode=mode, results=results, complete=True
            )
            if not self._append_seal(
                dataset_id, dataset, members, manifest_bytes, mode, results, run
            ):
                return
        # Sealed (now, or by a run that crashed before the flip): finish.
        self._store.finish_dataset_archive(dataset_id)
        self._views_changed()
        logger.info(
            "dataset archived",
            extra={
                "dataset_id": dataset_id,
                "destination": str(dataset_dir),
                "mode": mode,
            },
        )

    async def _member_out(
        self,
        dataset_id: str,
        member: DatasetMember,
        target: Path,
        run: _RunState,
    ) -> bool:
        """Bring one member to "archived at *target*". True = done, False = halt.

        Three resume shapes come first, all decided from durable state:

        * the row already says archived at *target* — a finished member; only
          re-assert that the source is in the trash;
        * the ledger says archived at *target* but the row does not — a crash
          between the append and the row update; finish those steps, copy
          nothing;
        * *target* exists but the ledger never recorded it — a copy this run
          started and died inside. With the source still present the debris is
          safely rebuilt from scratch; with the source gone this is the one
          state the runner must not touch: bytes exist only as an unverified,
          unrecorded copy, and a human gets to decide.
        """
        capture = self._store.get_capture(member.capture_id)
        if capture is None:
            run.error = {
                "capture_id": member.capture_id,
                "code": "capture_not_found",
                "message": "No catalog row for this member.",
            }
            return False
        source_present = self._layout.capture_dir(member.capture_id).is_dir()

        if capture.archived_at is not None and capture.archive_destination == str(
            target
        ):
            await self._tidy_source(member.capture_id, source_present)
            return True

        event = ledger_v2.archive_events(self._layout.data_dir).get(member.capture_id)
        if event is not None and event.get("destination") == str(target):
            self._captures.finish_archived_member(
                member.capture_id, destination=str(target)
            )
            await self._tidy_source(member.capture_id, source_present)
            return True

        if target.exists():
            if not source_present:
                run.error = {
                    "capture_id": member.capture_id,
                    "code": "bytes_unaccounted",
                    "message": (
                        f"{target} exists but was never recorded, and the "
                        "source is gone. Not touching either copy — verify "
                        "by hand which one is real."
                    ),
                }
                return False
            # Our own dead copy, and the original is intact: clear and redo.
            await asyncio.to_thread(shutil.rmtree, target)

        try:
            await self._captures.archive_member(
                member.capture_id,
                dataset_id=dataset_id,
                membership_id=member.membership_id,
                display_index=member.display_index,
                target=target,
                progress=lambda done: setattr(run, "current_bytes", done),
            )
        except ApiError as exc:
            run.error = {
                "capture_id": member.capture_id,
                "code": exc.code,
                "message": exc.message,
            }
            return False
        await asyncio.to_thread(self._captures.reap, member.capture_id)
        return True

    async def _copy_member_out(
        self,
        member: DatasetMember,
        target: Path,
        run: _RunState,
        results: dict[str, dict[str, Any]],
    ) -> bool:
        """Bring one member to "copied to *target*" — sources untouched.

        Far simpler resume than the move: the manifest is the only durable
        record, so "done" is "the manifest lists its files and the directory
        exists". Debris is always rebuilt — in copy mode the source is by
        definition still here, so there is no bytes-lost state to halt on.
        """
        if member.capture_id in results and target.is_dir():
            return True
        results.pop(member.capture_id, None)
        if target.exists():
            await asyncio.to_thread(shutil.rmtree, target)
        try:
            result = await self._captures.copy_out(
                member.capture_id,
                target=target,
                progress=lambda done: setattr(run, "current_bytes", done),
            )
        except ApiError as exc:
            run.error = {
                "capture_id": member.capture_id,
                "code": exc.code,
                "message": exc.message,
            }
            return False
        capture = self._store.get_capture(member.capture_id)
        results[member.capture_id] = {
            "files": result.entries,
            "bytes": result.bytes,
            "run_id": capture.run_id if capture else None,
        }
        return True

    def _seed_copy_results(
        self, dataset_dir: Path, members: list[DatasetMember]
    ) -> dict[str, dict[str, Any]]:
        """What a previous copy run already finished, read from its manifest."""
        manifest = self._read_manifest(dataset_dir)
        if manifest is None:
            return {}
        results: dict[str, dict[str, Any]] = {}
        wanted = {m.capture_id for m in members}
        for entry in manifest.get("members", []):
            if not isinstance(entry, dict):
                continue
            capture_id = entry.get("capture_id")
            files = entry.get("files")
            if (
                isinstance(capture_id, str)
                and capture_id in wanted
                and isinstance(files, list)
                and files
                and (dataset_dir / str(entry.get("dir"))).is_dir()
            ):
                results[capture_id] = {
                    "files": files,
                    "bytes": entry.get("bytes"),
                    "run_id": entry.get("run_id"),
                }
        return results

    def _read_manifest(self, dataset_dir: Path) -> dict[str, Any] | None:
        try:
            return json.loads((dataset_dir / MANIFEST_NAME).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _member_progress(
        self, dataset_id: str, dataset: dict[str, Any]
    ) -> tuple[int, int]:
        """(done, total): rows answer for a move; the manifest for a copy."""
        done, total = self._store.count_archived_members(dataset_id)
        if dataset.get("archive_mode") != "copy":
            return done, total
        destination = dataset.get("archive_destination")
        manifest = self._read_manifest(Path(destination)) if destination else None
        if manifest is None:
            return (total if dataset["status"] == "archived" else 0), total
        copied = sum(
            1
            for entry in manifest.get("members", [])
            if isinstance(entry, dict) and entry.get("files")
        )
        return copied, total

    async def _tidy_source(self, capture_id: str, source_present: bool) -> None:
        """Re-assert the end state of a member that already archived."""
        if source_present:
            await asyncio.to_thread(layout_mod.move_to_trash, self._layout, capture_id)
            self._store.upsert_replica(
                capture_id, self._instance_id, ReplicaState.trashed
            )
            await asyncio.to_thread(self._captures.reap, capture_id)

    # ---- the manifest and the seal ------------------------------------------

    def _write_manifest(
        self,
        dataset: dict[str, Any],
        members: list[DatasetMember],
        dataset_dir: Path,
        *,
        mode: str,
        results: dict[str, dict[str, Any]] | None = None,
        complete: bool,
    ) -> bytes:
        """Rewrite ``dataset_manifest.json`` atomically; return its bytes.

        Every member appears from the first write — the pending ones with
        ``files: null`` — so a half-finished folder describes itself. Where a
        finished member's entry comes from depends on the mode: a move's from
        its ``capture_archived`` event (the ledger is the record), a copy's
        from the run's own verified results (there is no event — nothing
        happened to the capture), which the next run re-reads from this very
        file.
        """
        events = (
            ledger_v2.archive_events(self._layout.data_dir) if mode == "move" else {}
        )
        results = results or {}
        started = self._started_event(dataset["dataset_id"])
        entries: list[dict[str, Any]] = []
        bytes_total = 0
        for member in sorted(members, key=lambda m: m.display_index):
            entry: dict[str, Any] = {
                "dir": f"{member.display_index:03d}",
                "display_index": member.display_index,
                "membership_id": member.membership_id,
                "capture_id": member.capture_id,
                "files": None,
                "bytes": None,
                "capture_archived_event_id": None,
            }
            if mode == "copy":
                result = results.get(member.capture_id)
                if result is not None:
                    entry["files"] = result.get("files")
                    entry["bytes"] = result.get("bytes")
                    if isinstance(result.get("run_id"), str):
                        entry["run_id"] = result["run_id"]
                    if isinstance(entry["bytes"], int):
                        bytes_total += entry["bytes"]
            else:
                event = events.get(member.capture_id)
                if event is not None and event.get("destination") == str(
                    dataset_dir / entry["dir"]
                ):
                    entry["files"] = event.get("files")
                    entry["bytes"] = event.get("bytes")
                    entry["capture_archived_event_id"] = event.get("event_id")
                    if isinstance(event.get("run_id"), str):
                        entry["run_id"] = event["run_id"]
                    if isinstance(entry["bytes"], int):
                        bytes_total += entry["bytes"]
            entries.append(entry)

        manifest = {
            "schema_version": MANIFEST_SCHEMA_VERSION,
            "kind": "kairos_dataset_archive",
            "dataset_id": dataset["dataset_id"],
            "name": dataset.get("name"),
            "operator": dataset.get("operator"),
            "task": dataset.get("task"),
            "mode": mode,
            "status": "complete" if complete else "archiving",
            "source_instance_id": self._instance_id,
            "started_event_id": started.get("event_id") if started else None,
            "started_at": dataset.get("archive_started_at"),
            "completed_at": utc_now_iso8601() if complete else None,
            "members": entries,
            "totals": {"members": len(entries), "bytes": bytes_total},
        }
        text = (
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
        )
        # §3.1's one atomic write, same as every other sidecar: the temp file is
        # fsynced before any name refers to it and the rename is same-directory,
        # so it stays atomic on whatever filesystem the destination turns out to
        # be. The bytes are returned because the seal event hashes them.
        atomic_write_text(dataset_dir / MANIFEST_NAME, text)
        return text.encode("utf-8")

    def _append_seal(
        self,
        dataset_id: str,
        dataset: dict[str, Any],
        members: list[DatasetMember],
        manifest_bytes: bytes,
        mode: str,
        results: dict[str, dict[str, Any]],
        run: _RunState,
    ) -> bool:
        if mode == "copy":
            bytes_total = sum(
                r["bytes"] for r in results.values() if isinstance(r.get("bytes"), int)
            )
        else:
            events = ledger_v2.archive_events(self._layout.data_dir)
            bytes_total = sum(
                e.get("bytes", 0)
                for e in (events.get(m.capture_id) for m in members)
                if e is not None and isinstance(e.get("bytes"), int)
            )
        try:
            ledger_v2.append_with_slack_release(
                self._layout.data_dir,
                "dataset_archived",
                instance_id=self._instance_id,
                payload={
                    "dataset_id": dataset_id,
                    "destination": dataset.get("archive_destination"),
                    "dataset_name": dataset.get("name") or dataset_id,
                    "mode": mode,
                    "member_total": len(members),
                    "bytes_total": bytes_total,
                    "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
                },
            )
        except OSError as exc:
            # Every member is out and recorded; only the seal is missing. The
            # run halts as archiving and the next resume re-seals.
            run.error = {
                "code": "ledger_unwritable",
                "message": f"Every member is archived but the seal could not "
                f"be written: {exc}. Resume to retry the seal.",
            }
            return False
        return True

    # ---- ledger reads -------------------------------------------------------

    def _dataset_events(self, dataset_id: str) -> list[dict[str, Any]]:
        return [
            event
            for event in ledger_v2.dataset_events(self._layout.data_dir)
            if event.get("dataset_id") == dataset_id
        ]

    def _started_event(self, dataset_id: str) -> dict[str, Any] | None:
        for event in self._dataset_events(dataset_id):
            if event.get("kind") == "dataset_archive_started":
                return event
        return None

    def _seal_event(self, dataset_id: str) -> dict[str, Any] | None:
        for event in self._dataset_events(dataset_id):
            if event.get("kind") == "dataset_archived":
                return event
        return None

    # ---- guards -------------------------------------------------------------

    def _require_delete_available(self) -> None:
        """Same withdrawal as delete/archive (§7): the run removes sources."""
        require_delete_available(
            self._health,
            "Archiving removes the source and deleting is not available "
            "on this deployment",
        )

    def _views_changed(self) -> None:
        if self._on_views_change is None:
            return
        try:
            self._on_views_change()
        except Exception:  # noqa: BLE001 - a stale views tree is not a failure
            logger.warning("could not schedule a views refresh", exc_info=True)
