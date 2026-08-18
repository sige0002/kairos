# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Copying and hashing bytes we are about to become responsible for.

Both callers here are irreversible in the same way: :func:`copy_tree_verified`
backs the archive path (§6), which deletes the source afterwards, and the
per-file hashing backs the digest job (§11), whose output is what later proves a
replica is intact. An unverified copy followed by a delete is how both copies of
a recording are lost, so the read-back is not optional and the source is never
touched here — deletion is the caller's separate, explicit step.
"""

from __future__ import annotations

import hashlib
import os
import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from kairos_common.atomic_io import fsync_dir

# 4 MiB: large enough that the syscall overhead disappears against a multi-GB
# bag, small enough to stay off the large-object heap and out of the way of a
# machine that is also recording.
COPY_CHUNK = 4 * 1024 * 1024


class VerificationError(RuntimeError):
    """A copied file did not match its source. The source is untouched."""


class DestinationNotEmptyError(RuntimeError):
    """The copy target already holds something, so it is not a clean landing.

    Refusing beats merging. The caller deletes the source once the copy
    verifies, and verification only ever inspects the files this copy wrote —
    so debris from an earlier failed attempt would sit alongside them,
    unexamined, and be counted as part of a successful archive. Worse, a
    same-named leftover would be overwritten, which is a silent data loss on a
    path the operator believes is an archive.
    """


@dataclass
class CopyResult:
    """What one verified tree copy produced.

    ``entries`` uses the same ``{path, size, sha256}`` shape as
    ``object_manifest.json``'s file list (§3.2) so a caller can hand it
    straight to the ledger or a manifest without re-keying it — an archived
    capture and a local one then describe their bytes identically.
    """

    bytes: int = 0
    entries: list[dict[str, Any]] = field(default_factory=list)

    @property
    def files(self) -> int:
        """How many files were copied."""
        return len(self.entries)


def sha256_file(path: Path, *, chunk: int = COPY_CHUNK) -> tuple[str, int]:
    """``(sha256 hex, size)`` for one file, read once."""
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while block := handle.read(chunk):
            digest.update(block)
            size += len(block)
    return digest.hexdigest(), size


def copy_file_verified(source: Path, target: Path) -> tuple[str, int]:
    """Copy one file, fsync it, then read it back and compare.

    The hash is computed from the same read that feeds the write, so the
    comparison is against what was actually read from the source rather than a
    second read that could differ. Returns ``(sha256, size)``.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    written = 0
    with source.open("rb") as src, target.open("wb") as dst:
        while block := src.read(COPY_CHUNK):
            digest.update(block)
            dst.write(block)
            written += len(block)
        dst.flush()
        os.fsync(dst.fileno())
    shutil.copystat(source, target)

    expected = digest.hexdigest()
    actual, size = sha256_file(target)
    if size != written or actual != expected:
        raise VerificationError(
            f"{target.name} does not match its source after copying "
            f"({size} bytes vs {written}); the source is untouched"
        )
    return expected, written


def copy_tree_verified(
    source: Path,
    target: Path,
    *,
    require_empty: bool = True,
    progress: Callable[[int], None] | None = None,
) -> CopyResult:
    """Copy every file under *source* into *target*, verifying each one.

    Symlinks are skipped rather than followed: a link inside a capture would
    make the archive copy pull in bytes from outside the capture, and the
    delete that follows would then not be deleting what was archived.

    *target* must not already exist as a non-empty directory (or as a file).
    The guard lives here rather than only at the caller because every user of
    this function is about to delete its source on the strength of the result —
    see :class:`DestinationNotEmptyError`. Pass ``require_empty=False`` only for
    a caller that genuinely means "merge into whatever is there".
    """
    if require_empty and target.exists():
        if not target.is_dir():
            raise DestinationNotEmptyError(f"{target} exists and is not a directory")
        if any(target.iterdir()):
            raise DestinationNotEmptyError(f"{target} already contains files")
    result = CopyResult()
    target.mkdir(parents=True, exist_ok=True)
    for child in sorted(source.rglob("*")):
        if child.is_symlink() or not child.is_file():
            continue
        relative = child.relative_to(source)
        digest, size = copy_file_verified(child, target / relative)
        result.entries.append({"path": str(relative), "size": size, "sha256": digest})
        result.bytes += size
        if progress is not None:
            progress(result.bytes)
    result.entries.sort(key=lambda entry: entry["path"])
    # Durability of the ENTRIES, not just the bytes (atomic_io's rule 4).
    # Every file above was fsynced, but a directory entry that is not fsynced
    # can vanish in a crash — and this function's `move`-mode caller deletes
    # the SOURCE on the strength of this result, which made this the one write
    # path in the tree that skipped the rule while destroying its fallback
    # (timing sweep S4/D4).
    directories = {target}
    for entry in result.entries:
        parent = (target / entry["path"]).parent
        while parent != target and target in parent.parents:
            directories.add(parent)
            parent = parent.parent
    for directory in sorted(directories):
        try:
            fsync_dir(directory)
        except OSError:
            # Some network filesystems refuse directory fsync; the file bytes
            # are already synced and nothing can be made MORE durable from
            # here, so the copy stands rather than failing an archive that a
            # local disk would have passed.
            continue
    return result
