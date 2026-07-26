"""Where a dataset may be archived to: the ``KAIROS_ARCHIVE_ROOTS`` allow-list.

Archiving takes an operator-supplied destination path and then DELETES the
source, so the destination is the most dangerous string in the system: an
unconstrained one turns "archive" into "copy anywhere on the host, then remove
the original". The allow-list is the boundary — the operator picks a subpath
*under* a root the deployment configured, and anything else is refused.

``KAIROS_ARCHIVE_ROOTS`` is colon-separated absolute paths (the ``PATH``
convention), e.g. ``/mnt/nas/datasets:/mnt/backup``. **Unset means the feature
is not offered at all**: the API advertises ``enabled: false`` and the UI shows
no archive control, rather than presenting a button that can only ever 400 —
the same honesty rule the validation gates follow.

Two escapes are closed here:

* ``..`` traversal — the destination is normalized before comparison, so
  ``/mnt/nas/../etc`` never passes as "under /mnt/nas";
* **symlink** escape — comparison uses ``realpath`` on both sides, so a symlink
  planted under a root cannot redirect the copy (and therefore the later
  delete) outside it. This resolves the deepest EXISTING ancestor, because the
  destination itself normally does not exist yet.

A root that does not exist is kept in the list rather than dropped: an
unmounted NAS is a mount problem to report at copy time, not a reason to
silently narrow the allow-list.
"""

from __future__ import annotations

import os
from pathlib import Path

from kairos_common.errors import ApiError

ARCHIVE_ROOTS_SEPARATOR = ":"


def parse_archive_roots(raw: str | None) -> list[Path]:
    """Parse ``KAIROS_ARCHIVE_ROOTS`` into absolute roots (``[]`` when unset).

    Relative entries are DROPPED rather than resolved against the process's cwd:
    a relative archive root in a container is always a misconfiguration, and
    resolving it would invent a boundary nobody intended.
    """
    if not raw:
        return []
    roots: list[Path] = []
    for chunk in raw.split(ARCHIVE_ROOTS_SEPARATOR):
        text = chunk.strip()
        if not text:
            continue
        path = Path(text)
        if not path.is_absolute():
            continue
        normalized = Path(os.path.normpath(str(path)))
        if normalized not in roots:
            roots.append(normalized)
    return roots


def archive_enabled(roots: list[Path]) -> bool:
    """Whether archiving is offered at all (at least one configured root)."""
    return len(roots) > 0


def _real_of_nearest_existing(path: Path) -> Path:
    """``realpath`` of *path*, resolving symlinks in its existing ancestors.

    ``Path.resolve()`` would do this too, but this spells out the intent: the
    destination usually does not exist yet, and what must not be spoofable is
    the part that DOES exist (that is where a planted symlink would live).
    """
    existing = path
    while not existing.exists() and existing != existing.parent:
        existing = existing.parent
    real_existing = Path(os.path.realpath(str(existing)))
    try:
        tail = path.relative_to(existing)
    except ValueError:  # pragma: no cover - path is its own ancestor
        return real_existing
    return real_existing / tail if str(tail) != "." else real_existing


def resolve_archive_destination(destination: str, roots: list[Path]) -> Path:
    """Validate *destination* against the allow-list; return the normalized path.

    Raises :class:`ApiError` 400 with a distinguishable ``code``:

    * ``archive_not_configured`` — no roots at all (the feature is off);
    * ``invalid_destination`` — empty or not an absolute path;
    * ``destination_not_allowed`` — outside every configured root.

    The error deliberately lists the configured roots: an operator who typed the
    wrong path needs to see what the legal ones are, and the roots are already
    visible through the capability endpoint.
    """
    if not archive_enabled(roots):
        raise ApiError(
            status_code=400,
            code="archive_not_configured",
            message=(
                "Archiving is not configured on this deployment "
                "(KAIROS_ARCHIVE_ROOTS is unset)."
            ),
            details={"roots": []},
        )
    text = (destination or "").strip()
    if not text or not Path(text).is_absolute():
        raise ApiError(
            status_code=400,
            code="invalid_destination",
            message="The archive destination must be an absolute path.",
            details={"destination": destination},
        )

    candidate = Path(os.path.normpath(text))
    real_candidate = _real_of_nearest_existing(candidate)
    for root in roots:
        real_root = Path(os.path.realpath(str(root)))
        if real_candidate == real_root or real_candidate.is_relative_to(real_root):
            return candidate
    raise ApiError(
        status_code=400,
        code="destination_not_allowed",
        message=("The archive destination must be inside a configured archive root."),
        details={"destination": text, "roots": [str(r) for r in roots]},
    )
