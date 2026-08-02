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

# 4 MiB: large enough that the syscall overhead disappears against a multi-GB
# bag, small enough to stay off the large-object heap and out of the way of a
# machine that is also recording.
COPY_CHUNK = 4 * 1024 * 1024


class VerificationError(RuntimeError):
    """A copied file did not match its source. The source is untouched."""


@dataclass
class CopyResult:
    """What one verified tree copy produced."""

    bytes: int = 0
    files: int = 0
    # relative path -> sha256 hex, so the caller can record what it moved.
    digests: dict[str, str] = field(default_factory=dict)


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
    progress: Callable[[int], None] | None = None,
) -> CopyResult:
    """Copy every file under *source* into *target*, verifying each one.

    Symlinks are skipped rather than followed: a link inside a capture would
    make the archive copy pull in bytes from outside the capture, and the
    delete that follows would then not be deleting what was archived.
    """
    result = CopyResult()
    target.mkdir(parents=True, exist_ok=True)
    for child in sorted(source.rglob("*")):
        if child.is_symlink() or not child.is_file():
            continue
        relative = child.relative_to(source)
        digest, size = copy_file_verified(child, target / relative)
        result.digests[str(relative)] = digest
        result.bytes += size
        result.files += 1
        if progress is not None:
            progress(result.bytes)
    return result
