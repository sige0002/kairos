"""The export queue: one FIFO, N execution slots, one subprocess per export.

Shape and discipline follow dora_runner's job worker, with one difference that
drives most of this file: the work is not a thread we can only ask to stop, it
is a CHILD PROCESS GROUP we can actually kill. So cancel here is real —
SIGTERM to the group, a grace window, then SIGKILL — but the terminal state is
still written by the worker, at the moment the process is confirmed dead, never
by the endpoint that requested the stop. A status that says ``canceled`` while
ffmpeg is still writing into the output tree is the failure mode that rule
exists to prevent.

Nothing is persisted. A restart forgets every export, which is honest: the
subprocess died with the process, so there is nothing to resume.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import shutil
import signal
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from lerobot_exporter.models import (
    TERMINAL_STATES,
    ExportEpisode,
    ExportStatus,
)
from lerobot_exporter.paths import (
    MANIFEST_EXTRA_FILENAME,
    export_staging_dir,
    output_dir,
    relative_output_path,
)
from lerobot_exporter.progress import read_episode_counts, read_heartbeat
from lerobot_exporter.settings import ExporterConfig
from lerobot_exporter.staging import StagingError, build_staging, write_manifest_extra

logger = logging.getLogger("kairos")

# How much of the converter's output is kept for the failure message. A ring
# buffer rather than the whole stream: a converter that fails 400 episodes in a
# row would otherwise hold its entire stderr in the status of a dead export.
_TAIL_BYTES = 8192
# What actually reaches the operator through `message`.
_MESSAGE_TAIL_CHARS = 2000
# How often the death of a signalled process is re-checked, and how long a
# SIGKILLed one is given (it cannot be caught, so this only covers the kernel
# tearing the process down).
_EXIT_POLL_S = 0.02
_KILL_WAIT_S = 5.0


class _Tail:
    """The last ``_TAIL_BYTES`` of a stream, decoded on demand.

    Byte-oriented on purpose: ``StreamReader.readline`` raises once a single
    line exceeds its 64 KiB limit, and a progress bar that never emits a
    newline is exactly the kind of line a converter produces.
    """

    def __init__(self) -> None:
        self._buffer = bytearray()

    def feed(self, chunk: bytes) -> None:
        self._buffer.extend(chunk)
        if len(self._buffer) > _TAIL_BYTES:
            del self._buffer[:-_TAIL_BYTES]

    def text(self) -> str:
        return self._buffer.decode("utf-8", errors="replace").strip()


@dataclass
class ExportRecord:
    """One export's whole in-memory life."""

    export_id: str
    output_name: str
    profile_path: str
    task_fallback: str | None
    episodes: list[ExportEpisode]
    state: str = "queued"
    done: int = 0
    failed: int = 0
    current_episode_pct: float | None = None
    stalled: bool = False
    message: str | None = None
    output_path: str | None = None
    cancel_requested: bool = False
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None

    @property
    def total(self) -> int:
        """Episodes asked for — known at submit, unlike the converter's counts."""
        return len(self.episodes)

    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL_STATES

    def status(self, queue_position: int | None = None) -> ExportStatus:
        return ExportStatus(
            export_id=self.export_id,
            state=self.state,  # type: ignore[arg-type]
            queue_position=queue_position if self.state == "queued" else None,
            done=self.done,
            failed=self.failed,
            total=self.total,
            current_episode_pct=self.current_episode_pct,
            stalled=self.stalled,
            message=self.message,
            output_path=self.output_path,
        )


class ExportRegistry:
    """Accepts exports without bound, runs ``max_concurrency`` of them at a time."""

    def __init__(self, data_dir: str | Path, config: ExporterConfig) -> None:
        self._data_dir = Path(data_dir)
        self._config = config
        self._records: dict[str, ExportRecord] = {}
        # Strict FIFO. A semaphore would admit waiters in wake order, which is
        # not something to rely on when the UI is showing a queue position.
        self._queue: deque[str] = deque()
        self._condition = asyncio.Condition()
        self._running = 0

    # ---- lookup -----------------------------------------------------------

    def get(self, export_id: str) -> ExportRecord | None:
        return self._records.get(export_id)

    def queue_position(self, export_id: str) -> int | None:
        """1-based position in the queue; ``None`` once it is no longer queued."""
        try:
            return self._queue.index(export_id) + 1
        except ValueError:
            return None

    def status(self, record: ExportRecord) -> ExportStatus:
        return record.status(self.queue_position(record.export_id))

    def active_output_name(self, output_name: str) -> bool:
        """Whether a queued/running export already claims *output_name*."""
        return any(
            record.output_name == output_name and not record.terminal
            for record in self._records.values()
        )

    # ---- submission -------------------------------------------------------

    def submit(self, record: ExportRecord) -> ExportRecord:
        """Register *record* and start its worker; it may sit in the queue first."""
        self._records[record.export_id] = record
        self._queue.append(record.export_id)
        record.task = asyncio.create_task(self._run(record))
        return record

    async def cancel(self, record: ExportRecord) -> None:
        """Stop *record*, wherever it is.

        Queued: dequeued and terminal immediately — nothing has happened yet, so
        nothing has to be undone. Running: the request is recorded and the
        worker performs the kill/cleanup, so ``canceled`` appears only once the
        conversion is actually dead.
        """
        record.cancel_requested = True
        dequeued = False
        async with self._condition:
            if record.export_id in self._queue:
                self._queue.remove(record.export_id)
                dequeued = True
                record.state = "canceled"
                record.message = "Canceled before the conversion started."
            # Wake the other waiters: the head of the queue may have changed.
            self._condition.notify_all()
        record.cancel_event.set()
        if dequeued and record.task is not None:
            record.task.cancel()

    async def shutdown(self) -> None:
        """Cancel every live export (process teardown; tests)."""
        for record in list(self._records.values()):
            if not record.terminal:
                await self.cancel(record)
        for record in list(self._records.values()):
            if record.task is not None:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await record.task

    # ---- scheduling -------------------------------------------------------

    async def _acquire_slot(self, record: ExportRecord) -> None:
        """Wait until a slot is free AND this export is at the head of the queue."""
        async with self._condition:
            await self._condition.wait_for(
                lambda: (
                    self._running < self._config.max_concurrency
                    and bool(self._queue)
                    and self._queue[0] == record.export_id
                )
            )
            self._queue.popleft()
            self._running += 1

    async def _release_slot(self) -> None:
        async with self._condition:
            self._running -= 1
            self._condition.notify_all()

    async def _run(self, record: ExportRecord) -> None:
        """Worker: queue -> execute -> terminal, for one export."""
        try:
            await self._acquire_slot(record)
        except asyncio.CancelledError:
            # Cancelled while queued: cancel() already wrote the terminal state.
            return
        try:
            await self._execute(record)
        except asyncio.CancelledError:
            record.state = "canceled"
            record.message = "Canceled."
            raise
        except Exception as exc:  # noqa: BLE001 - an export failing is status.
            logger.exception("export failed", extra={"export_id": record.export_id})
            record.state = "failed"
            record.message = str(exc)
            self._remove_partial_output(record)
        finally:
            await self._release_slot()

    # ---- execution --------------------------------------------------------

    async def _execute(self, record: ExportRecord) -> None:
        staging = export_staging_dir(self._data_dir, record.export_id)
        destination = output_dir(self._data_dir, record.output_name)
        record.state = "running"
        try:
            if record.cancel_event.is_set():
                record.state = "canceled"
                record.message = "Canceled before the conversion started."
                return
            try:
                await asyncio.to_thread(
                    build_staging, self._data_dir, record.export_id, record.episodes
                )
                await asyncio.to_thread(
                    write_manifest_extra, staging, record.export_id, record.episodes
                )
            except (StagingError, OSError) as exc:
                record.state = "failed"
                record.message = str(exc)
                return
            # Claim the destination before spawning: the removal on failure and
            # on cancel then has one tree to reason about, whether or not the
            # converter got far enough to create anything.
            destination.mkdir(parents=True, exist_ok=True)
            await self._convert(record, staging, destination)
        finally:
            # Staging is transient by contract — removed on every terminal path,
            # including the ones that failed before the converter ever ran.
            await asyncio.to_thread(_rmtree, staging)

    def _argv(
        self, record: ExportRecord, staging: Path, destination: Path
    ) -> list[str]:
        """The converter command line.

        ``--task`` is passed only when some episode lacks its own label: the
        profile YAML carries a placeholder task, and passing the fallback
        unconditionally would let it override per-episode ``task.json`` files
        for a dataset where every episode is already labelled.
        """
        argv = [
            self._config.bin,
            "convert",
            "--config",
            record.profile_path,
            "--bags",
            str(staging),
            "--output",
            str(destination),
            "--json",
            "--manifest-extra",
            str(staging / MANIFEST_EXTRA_FILENAME),
            "--workers",
            str(self._config.workers),
        ]
        # CPU encoding unless the deployment explicitly opted in: the
        # converter's NVENC auto-detection trusts `ffmpeg -encoders`, which in
        # a GPU-less container still lists the encoder and then fails to load
        # libcuda at runtime. --no-gpu makes the choice deterministic.
        if not self._config.gpu:
            argv.append("--no-gpu")
        if record.task_fallback is not None:
            argv += ["--task", record.task_fallback]
        return argv

    async def _convert(
        self, record: ExportRecord, staging: Path, destination: Path
    ) -> None:
        """Run the converter to completion (or to its death), and record which."""
        argv = self._argv(record, staging, destination)
        logger.info(
            "starting conversion",
            extra={"export_id": record.export_id, "output": record.output_name},
        )
        # start_new_session: the converter forks ffmpeg per camera, and a cancel
        # has to reach those children too. Its own session makes the process
        # group ours to signal, with no risk of signalling this service.
        process = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        # Capture the process-group id NOW, while the leader is alive.
        # start_new_session makes the converter its own group leader (pgid ==
        # pid), and a cancel must reach the whole group. Read once here because
        # once the leader is reaped its pgid can no longer be looked up — and a
        # child that outlives the leader is exactly the case cancel must cover.
        try:
            pgid = os.getpgid(process.pid)
        except ProcessLookupError:
            pgid = process.pid
        stdout_tail, stderr_tail = _Tail(), _Tail()
        drains = [
            asyncio.ensure_future(_drain(process.stdout, stdout_tail)),
            asyncio.ensure_future(_drain(process.stderr, stderr_tail)),
        ]
        try:
            returncode, stopped = await self._watch(record, process, pgid, destination)
        finally:
            await self._finish_drains(process, drains)
        self._settle(
            record,
            returncode,
            stopped=stopped,
            stdout_tail=stdout_tail,
            stderr_tail=stderr_tail,
        )

    async def _finish_drains(
        self, process: asyncio.subprocess.Process, drains: list[asyncio.Task[None]]
    ) -> None:
        """Collect the converter's last output — but never wait on it forever.

        The pipes are INHERITED by whatever the converter spawned, so they stay
        open while an orphaned ffmpeg holds its end, long after the process we
        are waiting on has exited. Awaiting EOF unconditionally would hang the
        export on a process nothing is tracking any more; the tail we already
        have is worth more than a complete one that never arrives.
        """
        _, pending = await asyncio.wait(drains, timeout=self._config.drain_s)
        for task in pending:
            task.cancel()
        await asyncio.gather(*drains, return_exceptions=True)
        if pending:
            logger.warning(
                "converter output still open after exit; something it spawned "
                "outlived it",
                extra={"streams": len(pending)},
            )
            _release_pipes(process)

    def _settle(
        self,
        record: ExportRecord,
        returncode: int,
        *,
        stopped: bool,
        stdout_tail: _Tail,
        stderr_tail: _Tail,
    ) -> None:
        """Write the terminal state now that the converter is gone.

        *stopped* — this export was signalled — is what distinguishes a cancel
        from a conversion that finished on its own while the cancel was in
        flight. A finished dataset is not deleted because the request lost that
        race: the work is done, and ``complete`` is what happened.
        """
        record.stalled = False
        if stopped:
            record.state = "canceled"
            record.message = "Canceled; the conversion was stopped."
            self._remove_partial_output(record)
            return
        if returncode == 0:
            record.state = "complete"
            record.output_path = relative_output_path(record.output_name)
            record.current_episode_pct = None
            record.message = None
            return
        record.state = "failed"
        tail = stderr_tail.text() or stdout_tail.text()
        detail = f" {tail[-_MESSAGE_TAIL_CHARS:]}" if tail else ""
        record.message = f"Conversion exited with code {returncode}.{detail}"
        self._remove_partial_output(record)

    def _remove_partial_output(self, record: ExportRecord) -> None:
        """Delete a half-written output tree.

        An export is DERIVED data, so there is nothing to preserve — and the
        debris is worse than nothing: the destination check refuses a non-empty
        directory, so a partial tree left behind would make the obvious retry
        (same dataset, same profile, same name) fail with a conflict that names
        no cause.
        """
        record.output_path = None
        shutil.rmtree(
            output_dir(self._data_dir, record.output_name), ignore_errors=True
        )

    async def _watch(
        self,
        record: ExportRecord,
        process: asyncio.subprocess.Process,
        pgid: int,
        destination: Path,
    ) -> tuple[int, bool]:
        """Poll progress until the converter exits; ``(exit code, stopped)``.

        Two exit signals, not one. ``process.wait()`` is the fast path, but
        asyncio only resolves it once the process has exited AND every pipe has
        been closed — and the pipes are inherited by whatever the converter
        spawned, so an orphaned ffmpeg holds them open indefinitely. Checking
        ``returncode`` alongside it is what keeps such an export from sitting in
        ``running`` for as long as the orphan lives. Waiting on the cancel event
        in the same call keeps a cancel immediate rather than up to ``poll_s``
        late.
        """
        exited = asyncio.ensure_future(process.wait())
        canceled = asyncio.ensure_future(record.cancel_event.wait())
        stopped = False
        try:
            while process.returncode is None:
                await asyncio.wait(
                    {exited, canceled},
                    timeout=self._config.poll_s,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if process.returncode is not None:
                    break
                if canceled.done():
                    stopped = await self._terminate(process, pgid)
                    break
                self._refresh(record, destination, alive=True)
            returncode = process.returncode
        finally:
            canceled.cancel()
            exited.cancel()
        self._refresh(record, destination, alive=False)
        # Only reachable if the child watcher never reported an exit, which
        # would mean the process is still alive; report it as a failure rather
        # than inventing a success.
        return (returncode if returncode is not None else -1), stopped

    async def _terminate(self, process: asyncio.subprocess.Process, pgid: int) -> bool:
        """SIGTERM the converter's process group, then SIGKILL what survives.

        ``False`` means there was nothing left to stop — the group was already
        empty, and whatever the converter produced stands on its own merits.

        The exit condition is the whole GROUP, not just the parent. The parent
        can hand its work to a forked ffmpeg and exit while that child keeps
        running (and keeps writing the output we are about to delete); waiting
        only on the parent would then report ``stopped`` with a live writer
        still going. So the grace window watches the group, and if anything is
        still there when it lapses the group is SIGKILLed — after which no
        member can execute, whether or not init has reaped it yet, which is the
        guarantee cleanup needs.
        """
        if not _killpg(pgid, signal.SIGTERM):
            return False
        if await _await_group_exit(pgid, self._config.term_grace_s):
            return True
        logger.warning(
            "converter process group ignored SIGTERM within the grace window; killing",
            extra={"pgid": pgid},
        )
        _killpg(pgid, signal.SIGKILL)
        await _await_group_exit(pgid, _KILL_WAIT_S)
        return True

    def _refresh(self, record: ExportRecord, destination: Path, *, alive: bool) -> None:
        """Re-read the converter's two progress files into the record."""
        counts = read_episode_counts(destination)
        if counts is not None:
            record.done = counts.done
            record.failed = counts.failed
        heartbeat = read_heartbeat(destination)
        if heartbeat is not None:
            record.current_episode_pct = heartbeat.episode_pct
        # A stall is only ever claimed from a heartbeat that STOPPED advancing.
        # A converter that writes none at all is not evidence of a stall — it is
        # evidence of a converter that does not report progress.
        record.stalled = (
            alive
            and heartbeat is not None
            and (_now() - heartbeat.updated_at) > self._config.stall_s
        )


def _now() -> float:
    """Wall clock, matching the converter's own ``updated_at`` reference."""
    return time.time()


def _release_pipes(process: asyncio.subprocess.Process) -> None:
    """Drop our ends of a dead converter's pipes.

    Only called once the process is gone but its pipes are not: an orphan holds
    the write end, so nothing will ever close them for us, and leaving that to
    garbage collection means holding two file descriptors per abandoned export
    for as long as the orphan lives. asyncio publishes no close for a subprocess
    transport, so the private handle is the only one there is — guarded by the
    exit check, since closing a transport whose process is still alive would
    kill it.
    """
    if process.returncode is None:
        return
    transport = getattr(process, "_transport", None)
    if transport is None:
        return
    with contextlib.suppress(Exception):
        transport.close()


def _rmtree(path: Path) -> None:
    """Best-effort recursive removal (symlinks are unlinked, never followed)."""
    shutil.rmtree(path, ignore_errors=True)


def _killpg(pgid: int, sig: int) -> bool:
    """Signal a process group; ``False`` when the group is already gone.

    *pgid* is captured once while the leader is alive, so it does not depend on
    the leader's pid still being resolvable — which is the whole point, since a
    surviving child can outlive the leader. The pgid-reuse window (leader
    reaped, number recycled, all before we signal) is negligible and no worse
    than the previous pid-based version; the payoff is that a child left behind
    is reached rather than missed.
    """
    try:
        os.killpg(pgid, sig)
    except (ProcessLookupError, PermissionError):
        return False
    return True


def _group_alive(pgid: int) -> bool:
    """Whether the process group still has any member.

    Signal 0 tests existence without delivering anything. A zombie member still
    "exists" for this test until it is reaped, which is harmless: a zombie runs
    no code, so treating it as alive only costs a little extra wait, never a
    premature "it's gone" while a real process could still be writing.
    """
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # The group exists but is not ours to signal — still alive.
        return True
    return True


async def _await_group_exit(pgid: int, timeout: float) -> bool:
    """Wait until the whole process group is gone, or *timeout* lapses."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while _group_alive(pgid):
        if loop.time() >= deadline:
            return False
        await asyncio.sleep(_EXIT_POLL_S)
    return True


async def _drain(stream: asyncio.StreamReader | None, tail: _Tail) -> None:
    """Consume *stream* into *tail* until EOF.

    Draining is not optional: a converter that fills the 64 KiB pipe buffer and
    is never read blocks forever inside its own write, and the export hangs with
    no sign of why.
    """
    if stream is None:
        return
    while True:
        chunk = await stream.read(4096)
        if not chunk:
            return
        tail.feed(chunk)
