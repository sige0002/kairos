# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Shared SQLite connection management for the kairos stores.

Both stores in this repo — ``api_orchestrator.store.CaptureStore`` and
``dora_runner.store.RunnerStore`` — reached the same connection policy
independently, because it falls out of two facts they share:

**FastAPI runs sync handlers in a thread pool**, so a connection is touched from
whichever worker thread picked up the request. A reentrant lock serializes every
use (reentrant because write helpers nest reads), and the shared connection is
opened with ``check_same_thread=False`` since the lock, not sqlite3's own thread
check, is what makes it safe.

**An in-memory database vanishes with its connection**, so ``:memory:`` keeps one
connection open for the object's lifetime while a file database opens a fresh
connection per call and closes it afterwards.

What this module deliberately does NOT own is each store's *schema policy*. The
two differ, and the difference is meaningful rather than accidental: the
orchestrator deletes a whole ``kairos.db`` written by another schema generation
(§8 replaces migrations with a rebuild from the sidecars), while dora_runner
drops only its ``jobs`` table (jobs are volatile; its templates cache is not).
:func:`user_version` and :func:`set_user_version` are here because reading and
stamping the version is identical; deciding what to do about a mismatch stays
with the store that knows what its rows are worth.

Per-connection PRAGMAs are passed in (*connect_pragmas*) rather than fixed here,
so a store opts into what it needs and no store silently inherits another's
tuning.
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

#: The path that means "in-memory database" to sqlite3.
MEMORY_PATH = ":memory:"


class SqliteConnection:
    """Opens connections to one SQLite database under a serializing lock.

    Args:
        db_path: The database file, or ``":memory:"``. A file's parent
            directories are created; nothing is opened until the first
            :meth:`connect` (so a caller may still inspect or delete the file
            first). An in-memory database is opened immediately and held.
        connect_pragmas: Full ``PRAGMA`` statements applied to each freshly
            opened file connection, e.g. ``("PRAGMA busy_timeout = 5000",)``.
            Not applied to the shared in-memory connection, which is opened
            once and never reopened.
    """

    def __init__(
        self, db_path: str | Path, *, connect_pragmas: Sequence[str] = ()
    ) -> None:
        self.path = str(db_path)
        self._connect_pragmas = tuple(connect_pragmas)
        # Reentrant: a write helper that nests a read must not deadlock itself.
        self._lock = threading.RLock()
        self._shared: sqlite3.Connection | None = None
        if self.path != MEMORY_PATH:
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        else:
            # In-memory DBs vanish when their connection closes, so keep one.
            # check_same_thread=False: FastAPI runs sync work in a thread pool,
            # so this connection is touched from worker threads; the lock
            # serializes access.
            self._shared = sqlite3.connect(self.path, check_same_thread=False)
            self._shared.row_factory = sqlite3.Row

    @property
    def is_memory(self) -> bool:
        """Whether this is the in-memory database (one held connection)."""
        return self.path == MEMORY_PATH

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        """Yield a connection under the lock, committing on success.

        A file database gets a fresh connection that is closed afterwards; the
        in-memory database reuses its single shared connection (closing it would
        drop the data). Either way the lock is held for the whole block, so the
        thread pool cannot interleave two callers.
        """
        with self._lock:
            if self._shared is not None:
                yield self._shared
                self._shared.commit()
                return
            conn = sqlite3.connect(self.path)
            conn.row_factory = sqlite3.Row
            for pragma in self._connect_pragmas:
                conn.execute(pragma)
            try:
                yield conn
                conn.commit()
            finally:
                conn.close()

    def close(self) -> None:
        """Close the shared in-memory connection (no-op for file databases)."""
        if self._shared is not None:
            self._shared.close()
            self._shared = None


def user_version(conn: sqlite3.Connection) -> int:
    """Return the schema generation stamped in ``PRAGMA user_version`` (0 if unset)."""
    return int(conn.execute("PRAGMA user_version").fetchone()[0])


def set_user_version(conn: sqlite3.Connection, version: int) -> None:
    """Stamp *version* into ``PRAGMA user_version``.

    ``PRAGMA`` takes no bound parameters, so the value is formatted into the
    statement. It is an ``int`` by signature, which is what keeps that safe.
    """
    conn.execute(f"PRAGMA user_version = {int(version)}")
