"""Shared fixtures: the capture-keyed layout every pipeline test writes into.

Contract §2/§10.5. A job's source is ``objects/<capture_id>`` and its output is
``report/<pipeline>/<capture_id>/`` — there is no second layout to test against
any more, so the fixtures here only build that one.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest
from kairos_common.ids import new_capture_id


@pytest.fixture
def make_capture() -> Callable[[Path], tuple[str, Path]]:
    """Create ``objects/<capture_id>/`` under *data_dir*; return ``(id, dir)``.

    The id is a real UUIDv7 rather than a readable fake: ``validate_capture_id``
    is what keeps the joined path inside ``objects/``, so it refuses anything
    else and a test that used ``"run_x"`` would only ever exercise the rejection
    path.
    """

    def _make(data_dir: Path) -> tuple[str, Path]:
        capture_id = new_capture_id()
        directory = data_dir / "objects" / capture_id
        directory.mkdir(parents=True)
        return capture_id, directory

    return _make


@pytest.fixture
def sample_capture() -> tuple[str, Path] | None:
    """A real recording under the repo's ``data/objects/``, or ``None``.

    The integration tests that need actual MCAP bytes are gated on this: a
    developer checkout usually has one, CI does not, and inventing a bag would
    test the writer rather than the pipeline.
    """
    objects = Path(__file__).resolve().parents[3] / "data" / "objects"
    if not objects.is_dir():
        return None
    for candidate in sorted(objects.iterdir()):
        if candidate.is_dir() and any(candidate.glob("*.mcap")):
            return candidate.name, candidate
    return None
