"""The per-capture mutex the review, delete and archive paths share.

The per-capture mutex is deliberately *not* the store's connection lock. §4.1
requires one capture's read-modify-write to be atomic across a filesystem write,
and taking a global lock across an fsync would serialise every unrelated request
behind one slow disk.

One map serves all three responsibilities on purpose. A delete resuming at
startup and an in-flight review save have to contend for the *same* lock object,
or the review writes ``record.json`` into ``objects/<id>`` just after the resume
renamed that directory into ``.trash`` — recreating the tree the deletion was in
the middle of removing.
"""

from __future__ import annotations

import asyncio
import threading

# How many per-capture mutexes to keep before dropping the idle ones. A capture
# store holds thousands of captures over a deployment's life and a lock object
# is tiny, so this is about not growing without bound rather than about memory
# pressure.
MAX_TRACKED_MUTEXES = 512


class CaptureLocks:
    """One ``asyncio.Lock`` per capture id, created on first use."""

    def __init__(self) -> None:
        # Per-capture mutexes for §4.1. Created lazily and never evicted while
        # in use; the dict itself is guarded by a plain lock because it is
        # touched from the event loop and from worker threads.
        self._mutexes: dict[str, asyncio.Lock] = {}
        self._guard = threading.Lock()

    def get(self, capture_id: str) -> asyncio.Lock:
        """This capture's §4.1 mutex, created on first use.

        Idle entries are dropped once the map grows past
        :data:`MAX_TRACKED_MUTEXES`. Evicting only UNLOCKED locks is what makes
        that safe: a held lock stays in the map, so no two callers can ever be
        handed different lock objects for the same capture. The map is otherwise
        unbounded in a long-running process that reviews many captures, and this
        is cheaper than the weak-reference bookkeeping that would be needed to
        make eviction automatic.
        """
        with self._guard:
            lock = self._mutexes.get(capture_id)
            if lock is None:
                if len(self._mutexes) >= MAX_TRACKED_MUTEXES:
                    self._evict_idle()
                lock = asyncio.Lock()
                self._mutexes[capture_id] = lock
            return lock

    def _evict_idle(self) -> None:
        """Drop unlocked mutexes. Caller holds ``_guard``."""
        for capture_id in [
            key for key, lock in self._mutexes.items() if not lock.locked()
        ]:
            del self._mutexes[capture_id]


__all__ = ["MAX_TRACKED_MUTEXES", "CaptureLocks"]
