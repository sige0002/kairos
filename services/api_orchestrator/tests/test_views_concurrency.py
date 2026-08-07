"""Two regenerations of ``views/`` must never be in the tree at once.

Nothing used to serialize :func:`views.regenerate`. Two callers reach it from
two different threads — a dataset edit schedules one through
``asyncio.to_thread``, and ``POST /api/v1/views/refresh`` runs one from a
request handler — so they interleave: each builds a generation, each flips the
symlink, and each prunes what it reads as the other's debris. ``_prune`` sorts
by ``stat().st_mtime`` on paths it listed a moment earlier, so the loser of
that race raises ``FileNotFoundError`` out of the endpoint.

Both tests here are deterministic rather than repeated: a race reproduced one
run in five is evidence, not a test. The first holds one regeneration open at a
known point and asks whether a second can get in; the second reproduces the
exact interleaving ``_prune`` dies on, without threads at all.
"""

from __future__ import annotations

import shutil
import threading
from pathlib import Path
from typing import Any

import pytest
from api_orchestrator import views as views_mod
from api_orchestrator.layout import DataLayout
from kairos_common.ids import new_capture_id


def _entries(layout: DataLayout, *, count: int) -> list[dict[str, Any]]:
    """Committed membership rows, with the capture directories to link to."""
    entries: list[dict[str, Any]] = []
    for index in range(1, count + 1):
        capture_id = new_capture_id()
        layout.capture_dir(capture_id).mkdir(parents=True)
        entries.append(
            {
                "capture_id": capture_id,
                "display_index": index,
                "dataset_name": "ds",
                "operator": "alice",
                "task": "pick",
                "dataset_id": "0192dead-beef-7000-8000-000000000001",
            }
        )
    return entries


def _generation(layout: DataLayout, digit: str) -> Path:
    return layout.data_dir / f"{views_mod.GENERATION_PREFIX}{digit * 16}"


class TestRegenerationIsSerialized:
    def test_two_regenerations_cannot_be_in_the_tree_at_once(
        self, layout: DataLayout, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Hold one regeneration open and see whether a second can walk in.

        The verdict is what ``peak`` observed, never how long anything waited:
        serialized, the second caller cannot reach the instrumented point at
        all and the first simply waits out its timeout; unserialized, the
        second arrives immediately because nothing is in its way.
        """
        entries = _entries(layout, count=2)
        real_flip = views_mod._flip
        book = threading.Lock()
        depth = 0
        peak = 0
        first_inside = threading.Event()
        second_arrived = threading.Event()
        failures: list[BaseException] = []

        def instrumented_flip(target: DataLayout, staging: Path) -> None:
            nonlocal depth, peak
            with book:
                depth += 1
                peak = max(peak, depth)
                is_first = not first_inside.is_set()
            if is_first:
                first_inside.set()
                second_arrived.wait(timeout=2.0)
            else:
                second_arrived.set()
            real_flip(target, staging)
            with book:
                depth -= 1

        monkeypatch.setattr(views_mod, "_flip", instrumented_flip)

        def background() -> None:
            # The dataset edit's regeneration: a worker thread, which is why an
            # asyncio.Lock could never have covered this caller.
            try:
                views_mod.regenerate(layout, entries)
            except BaseException as exc:  # noqa: BLE001 - reported, not swallowed
                failures.append(exc)

        worker = threading.Thread(target=background, name="views-refresher")
        worker.start()
        assert first_inside.wait(timeout=10.0), "the first regeneration never started"

        # The manual refresh, arriving while the first is provably mid-flight.
        views_mod.regenerate(layout, entries)
        worker.join(timeout=15.0)
        assert not worker.is_alive(), "the background regeneration never finished"

        assert peak == 1, f"{peak} regenerations were inside the tree at once"
        assert failures == [], f"the background regeneration raised: {failures!r}"
        # Whichever went second owns the tree, and it resolves either way.
        assert layout.views.is_symlink()
        assert (layout.views / "alice" / "pick" / "ds" / "001").is_symlink()


class TestPruneTolerance:
    def test_a_generation_that_vanishes_mid_scan_is_not_a_crash(
        self, layout: DataLayout, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A directory that passes the filter and is gone before its mtime.

        The lock above closes the case where another regeneration is doing the
        deleting, but an operator with ``rm -rf`` is not holding it — and a
        sort key is no place to discover that the disk moved. Constructed
        rather than raced: the vanishing happens inside the ``is_dir()`` call
        that ``_prune`` itself makes, which is precisely where the window is.
        """
        current, doomed, other = (_generation(layout, d) for d in ("0", "1", "2"))
        for path in (current, doomed, other):
            path.mkdir(parents=True)
        real_is_dir = Path.is_dir

        def is_dir_then_vanish(self: Path, *args: Any, **kwargs: Any) -> bool:
            result = real_is_dir(self, *args, **kwargs)
            if result and self.name == doomed.name:
                shutil.rmtree(self, ignore_errors=True)
            return result

        monkeypatch.setattr(Path, "is_dir", is_dir_then_vanish)

        views_mod._prune(layout, keep="0" * 16)

        # The generation just flipped onto is never a candidate, the one that
        # vanished needed no help, and the newest survivor is the reader
        # hand-off KEEP_GENERATIONS exists for.
        assert current.is_dir()
        assert not doomed.exists()
        assert other.is_dir()
