"""The digest job: hashing a finished capture and sealing the result.

Contract §11, gated by §9-4. Once the recorder has finalised a capture, nothing
about its bytes will change again — so exactly one process hashes every file,
writes the list plus the capture digest into ``object_manifest.json`` in a
single atomic write, and promotes the replica to ``present_verified``. That
promotion is the only claim in the system that a copy is intact, which is why
§9-4 forbids reaching it any other way.

Four guards, each closing a specific way this job could destroy a recording:

**Terminal state, and the recorder confirmed not holding it.** The recorder is
sole writer until finalise (§3.3). Hashing a bag it is still appending to would
seal hashes of a file that is about to grow. An *unreachable* recorder is not a
confirmation, so the job defers rather than assuming.

**A lease for the whole run.** Discard and delete refuse while the lease is live
(§7.1), so the capture cannot be renamed into ``.trash`` between the hash and
the write.

**A re-check under the lease immediately before the write.** The lease can be
lost — expiry, an operator's Repair, a reconciler that decided the volume is
suspect. §7.1 requires a job that lost its lease to abandon quietly and write
nothing, so the state is read once more at the last possible moment.

**The directory must already exist.** ``atomic_write_json`` would happily create
``objects/<capture_id>/`` on the way to writing the manifest, and §7.1 forbids a
job from doing that — a capture deleted mid-hash would otherwise come back as a
directory containing only a manifest, which the next rebuild adopts as real.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from kairos_common.capture_sidecars import (
    TERMINAL_STATES,
    DigestState,
    ManifestFile,
    SidecarStatus,
    manifest_digest,
    read_object_manifest,
    write_object_manifest,
)
from kairos_common.rebuild import ReplicaState

from api_orchestrator import fileops
from api_orchestrator import layout as layout_mod
from api_orchestrator.health import StoreHealth
from api_orchestrator.layout import DataLayout
from api_orchestrator.recorder_client import live_capture_ids
from api_orchestrator.store import CaptureStore

logger = logging.getLogger("kairos")

LEASE_OWNER = "digest"
# Long enough that hashing a multi-GB bag on a busy disk does not lose the
# lease mid-run, short enough that a crashed job stops blocking deletion within
# one operator's patience.
LEASE_TTL_S = 15 * 60


@dataclass(frozen=True)
class DigestOutcome:
    """Why one digest attempt ended the way it did."""

    capture_id: str
    completed: bool
    reason: str = ""

    @property
    def skipped(self) -> bool:
        return not self.completed


class DigestJob:
    """Computes and seals per-file hashes for finished captures.

    Args:
        store: The catalog (state, lease and replica writes).
        layout: Data directory paths.
        health: SUSPECT stops digests for this storage (§9-3).
        instance_id: Whose replica gets promoted.
        recorder: Client used to confirm the recorder is not holding a capture.
            ``None`` means "no recorder in this deployment", which is treated as
            confirmation — a split recording PC has no local recorder to ask.
        captures: Capture service, for adopting a sealed manifest's facts.
    """

    def __init__(
        self,
        store: CaptureStore,
        layout: DataLayout,
        health: StoreHealth,
        *,
        instance_id: str,
        recorder: Any | None = None,
        captures: Any | None = None,
    ) -> None:
        self._store = store
        self._layout = layout
        self._health = health
        self._instance_id = instance_id
        self._recorder = recorder
        # Used only to adopt a terminal manifest's facts after sealing. Injected
        # rather than imported: the capture service already depends on nothing
        # here, and a cycle would be the price of the convenience.
        self._captures = captures
        # Strong refs to in-flight background digests: asyncio keeps only weak
        # ones, and a garbage-collected job would leave its lease held until it
        # expired.
        self._tasks: set[asyncio.Task[Any]] = set()

    def schedule(self, capture_id: str) -> None:
        """Run a digest in the background, if a loop is running.

        Called from the stop path. A missing loop (a synchronous caller, or a
        test) is a no-op rather than an error: the reconciler re-enqueues every
        pending digest anyway, so the work is never lost, only deferred.
        """
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        task = loop.create_task(self.run(capture_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def drain(self) -> None:
        """Await in-flight digests (shutdown, and test determinism)."""
        tasks = list(self._tasks)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def run_pending(self) -> int:
        """Digest every terminal capture whose local copy is unverified.

        The reconciler's re-enqueue (§8, §11): a crash between the hash and the
        write leaves the manifest as it was, so the work simply runs again from
        the start. Partial results are never persisted, so there is nothing to
        resume — only to redo.
        """
        if self._health.suspect:
            return 0
        completed = 0
        for capture_id in self._store.captures_needing_digest(self._instance_id):
            outcome = await self.run(capture_id)
            if outcome.completed:
                completed += 1
        return completed

    async def run(self, capture_id: str) -> DigestOutcome:
        """Hash one capture and seal the result. Never raises."""
        try:
            return await self._run(capture_id)
        except Exception:  # noqa: BLE001 - a digest must never crash the app
            logger.exception("digest failed", extra={"capture_id": capture_id})
            self._store.release_lease(capture_id, LEASE_OWNER)
            return DigestOutcome(capture_id, completed=False, reason="error")

    async def _run(self, capture_id: str) -> DigestOutcome:
        if self._health.suspect:
            return DigestOutcome(capture_id, False, "store is SUSPECT")

        capture = self._store.get_capture(capture_id)
        if capture is None:
            return DigestOutcome(capture_id, False, "no capture row")
        if str(capture.state) not in TERMINAL_STATES:
            return DigestOutcome(capture_id, False, f"state is {capture.state}")

        held = await self._recorder_holds(capture_id)
        if held is not False:
            # True = the recorder is writing it; None = we could not ask. §9-4
            # requires a positive confirmation, so both defer.
            return DigestOutcome(
                capture_id,
                False,
                "recorder still holds it" if held else "recorder unreachable",
            )

        capture_dir = self._layout.capture_dir(capture_id)
        if not capture_dir.is_dir():
            return DigestOutcome(capture_id, False, "no local copy")

        if not self._store.acquire_lease(capture_id, LEASE_OWNER, ttl_s=LEASE_TTL_S):
            return DigestOutcome(capture_id, False, "leased by another job")
        try:
            read = read_object_manifest(capture_dir)
            if read.status is not SidecarStatus.ok or read.manifest is None:
                # A corrupt manifest is reported by the reconciler, never
                # overwritten (§3.3): the manifest is the only description of
                # what this capture is, and replacing it would discard it.
                return DigestOutcome(
                    capture_id, False, f"manifest unusable: {read.error}"
                )
            manifest = read.manifest
            if manifest.digest_state == DigestState.complete:
                # Already sealed. Promote the replica in case a previous run
                # died between the manifest write and the row update.
                self._promote(capture_id, capture_dir, manifest.manifest_digest)
                return DigestOutcome(capture_id, True, "already complete")

            files = await asyncio.to_thread(self._hash_files, capture_dir)

            # Last possible moment: the state and the lease are both re-read
            # under the lock the write is about to happen under (§7.1).
            fresh = self._store.get_capture(capture_id)
            if fresh is None or str(fresh.state) not in TERMINAL_STATES:
                return DigestOutcome(capture_id, False, "state changed during hashing")
            if not self._store.holds_lease(capture_id, LEASE_OWNER):
                return DigestOutcome(capture_id, False, "lease lost during hashing")
            if not capture_dir.is_dir():
                return DigestOutcome(capture_id, False, "copy removed during hashing")

            digest = manifest_digest(files)
            sealed = replace(
                manifest,
                files=tuple(files),
                manifest_digest=digest,
                digest_state=DigestState.complete.value,
            )
            # One atomic write, once, for the whole manifest (§3.3). tmp+replace
            # is also what lets this uid-1000 process update a root-owned file.
            await asyncio.to_thread(write_object_manifest, capture_dir, sealed)
            self._promote(capture_id, capture_dir, digest)
            # The digest is often the FIRST thing to touch a capture that
            # reached a terminal state without the stop path (a recorder
            # restart writes its own recovery manifest). Sealing bytes whose
            # counters the catalog never learned would verify data the UI still
            # calls empty, so the facts are adopted at the same moment (§3).
            #
            # **This is NOT a settling route, and it relies on the state guard
            # above to stay that way.** Every other place that adopts a terminal
            # manifest also schedules the quick check (E-38: a capture adopted
            # without one is never settled by anything later). This one does not
            # need to, because the guard at the top of ``_run`` refuses a
            # capture whose row is not already terminal — so by the time
            # execution reaches here, one of the routes that DOES settle has
            # already been through this capture. Relax that guard and a sixth
            # unsettled route opens silently, with no test failing to say so.
            if self._captures is not None:
                self._captures.adopt_manifest_facts(capture_id)
            logger.info(
                "digest complete",
                extra={
                    "capture_id": capture_id,
                    "files": len(files),
                    "manifest_digest": digest,
                },
            )
            return DigestOutcome(capture_id, True, "sealed")
        finally:
            self._store.release_lease(capture_id, LEASE_OWNER)

    def _hash_files(self, capture_dir: Path) -> list[ManifestFile]:
        """Per-file sha256 for everything the digest covers, sorted by path."""
        entries: list[ManifestFile] = []
        for path in layout_mod.digest_input_files(capture_dir):
            digest, size = fileops.sha256_file(path)
            entries.append(
                ManifestFile(
                    path=str(path.relative_to(capture_dir)), size=size, sha256=digest
                )
            )
        return sorted(entries, key=lambda f: f.path)

    def _promote(self, capture_id: str, capture_dir: Path, digest: str | None) -> None:
        """Record the verified replica — the one place this state is reachable."""
        self._store.upsert_replica(
            capture_id,
            self._instance_id,
            ReplicaState.present_verified,
            path=str(capture_dir),
            manifest_digest=digest,
        )

    async def _recorder_holds(self, capture_id: str) -> bool | None:
        """Whether the recorder is currently writing this capture.

        ``None`` means the question could not be answered — an unreachable
        recorder, or a status body carrying no ``live_capture_ids`` array (§10
        rev.2.4). §9-4 needs a positive "not holding it", so the caller treats
        ``None`` as a reason to defer rather than a licence to proceed.
        """
        if self._recorder is None:
            return False
        try:
            status = await self._recorder.status()
        except Exception:  # noqa: BLE001 - any client failure is "unknown"
            return None
        # ``None`` here means the recorder did not report its live set at all,
        # which is indistinguishable from not having asked — and §9-4 needs a
        # positive "not holding it" before any hashing starts.
        return _holds(live_capture_ids(status), capture_id)


def _holds(live: set[str] | None, capture_id: str) -> bool | None:
    """``capture_id in live``, propagating "the recorder did not say" as ``None``."""
    if live is None:
        return None
    return capture_id in live
