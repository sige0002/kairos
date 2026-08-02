"""The one crash-safe write in the repo: temp file → fsync → replace → fsync dir.

Contract §3.1. Every sidecar the capture store keeps (object_manifest.json,
record.json, instance.json, the failed-start record) is written through here, and
the three pre-v2 implementations that wrote a temp file and renamed it *without*
fsync are replaced by it.

The missing fsync was not a theoretical gap. ``os.replace`` makes the swap atomic
against a concurrent **reader** — nobody ever sees half a file — but it says
nothing about power loss: the rename can reach the disk while the data behind it
is still in page cache, and the file that survives the crash is then a correct
name pointing at zero bytes. That is exactly the 0-byte manifest §8 rule 4 has to
classify as CORRUPT. Four steps close it:

1. write the temp file **in the destination's own directory** — a temp on another
   filesystem would make the rename an ``EXDEV`` copy, which is not atomic;
2. ``flush`` then ``fsync`` the temp file, so its bytes are durable *before* any
   name refers to them;
3. ``os.replace`` — atomic, and it overwrites in one step so the destination
   never blinks out of existence;
4. ``fsync`` the parent **directory**, because the file's own fsync does not
   persist the directory entry that the rename created.

Failure leaves the destination untouched: on any exception the temp file is
removed and the old content (or no file at all) is what a reader still sees.
There is no partial-write outcome to recover from.

This is also how a uid-1000 process updates a root-owned sidecar (§3.1): opening
the existing file for writing gives ``EACCES``, but creating a new file in a
host-writable directory and renaming it over the old one does not. The digest job
depends on that.
"""

from __future__ import annotations

import errno
import json
import logging
import os
import secrets
from pathlib import Path
from typing import Any

logger = logging.getLogger("kairos")

# Filesystems where ``os.link`` is refused rather than merely losing a race.
# Only :func:`create_exclusive_json` cares: it degrades to a plain atomic write.
_LINK_UNSUPPORTED = frozenset(
    {errno.EPERM, errno.ENOSYS, errno.EOPNOTSUPP, errno.EXDEV, errno.EMLINK}
)


def fsync_dir(path: str | Path) -> None:
    """``fsync`` a directory so entries created or replaced inside it persist.

    Separate from the write helpers because callers that create, rename or unlink
    a file themselves (trash moves, slack release) need the same durability step
    and must not reimplement it.
    """
    fd = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _temp_path(path: Path) -> Path:
    """A unique sibling temp name.

    The pid and a random suffix matter: two writers racing on the same target
    (recorder finalise vs. reconciler, or two orchestrator workers) must not
    share a temp file, or one would truncate the other's half-written bytes and
    then rename the result into place.
    """
    return path.parent / f".{path.name}.{os.getpid()}-{secrets.token_hex(4)}.tmp"


def atomic_write_text(path: str | Path, text: str, *, encoding: str = "utf-8") -> Path:
    """Write *text* to *path* durably and atomically. Returns the path written.

    Parent directories are created if needed. Raises ``OSError`` — a sidecar that
    cannot be persisted must be reported, never assumed.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = _temp_path(target)
    try:
        with tmp.open("w", encoding=encoding) as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, target)
    except BaseException:
        # Includes KeyboardInterrupt/SystemExit on purpose: an abandoned temp
        # file in objects/<capture_id>/ would be scanned as capture content.
        tmp.unlink(missing_ok=True)
        raise
    fsync_dir(target.parent)
    return target


def atomic_write_json(
    path: str | Path,
    obj: Any,
    *,
    indent: int | None = 2,
    sort_keys: bool = False,
) -> Path:
    """Serialise *obj* as JSON and write it through :func:`atomic_write_text`.

    Indented with a trailing newline, matching the sidecars already on disk:
    these files are read by humans during incident forensics as often as by
    code. ``ensure_ascii=False`` keeps operator and task names legible.
    """
    text = json.dumps(obj, ensure_ascii=False, indent=indent, sort_keys=sort_keys)
    return atomic_write_text(path, text + "\n")


def create_exclusive_json(path: str | Path, obj: Any) -> bool:
    """Write *obj* to *path* **only if it does not exist**. ``False`` = it did.

    Same durability as :func:`atomic_write_json` — the temp file is fsynced
    before any name refers to it — but the final step is ``os.link``, which
    fails with ``EEXIST`` instead of overwriting. That is the difference between
    "make this file say X" and "claim this name", and identity files
    (``instance.json``) need the second: two services starting at once must end
    up agreeing on one id, not overwriting each other in turn.

    On a filesystem that refuses hard links this falls back to an ``O_EXCL``
    create, which keeps the one property that matters — an existing file is
    never overwritten — at the cost of the temp file's crash safety, since the
    bytes now land under the final name. That trade is deliberate: a partially
    written identity file is detectable (it fails to parse, and the caller
    treats that as fatal), whereas a silently replaced one is not.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = _temp_path(target)
    try:
        with tmp.open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(tmp, target)
        except FileExistsError:
            return False
        except OSError as exc:
            if exc.errno not in _LINK_UNSUPPORTED:
                raise
            logger.warning(
                "hard links unsupported here; creating %s with O_EXCL instead "
                "(a crash mid-write can leave it truncated): %s",
                target,
                exc,
            )
            return _create_exclusive_in_place(target, obj)
    finally:
        tmp.unlink(missing_ok=True)
    fsync_dir(target.parent)
    return True


def _create_exclusive_in_place(target: Path, obj: Any) -> bool:
    """``O_CREAT|O_EXCL`` create, writing straight to the final name.

    The fallback for filesystems without hard links. ``False`` = it already
    existed, and its contents are left exactly as they were.
    """
    payload = (json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    try:
        fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        return False
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    fsync_dir(target.parent)
    return True
