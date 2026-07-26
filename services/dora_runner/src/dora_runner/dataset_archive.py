"""``dataset_archive`` pipeline: COPY a dataset out, verify it, then remove it.

The counterpart to ``dataset_export``. Export MOVES a finished run into the
catalog with a same-filesystem rename; archive takes it OUT of the catalog to
somewhere the operator chose — normally a NAS, i.e. a **different filesystem**,
where ``rename`` cannot work. So this is a copy, and the moment a copy is
followed by a delete, the ordering becomes the whole design:

    copy -> fsync -> verify -> ONLY THEN remove the source

Never the other way around, and never "copy and assume". On 2026-07-26 a
recording on this machine vanished with no trace of where it went; the rule
here is that the source is destroyed only after the destination has been read
back and proven byte-identical.

Verification is a SHA-256 read-back, not a size check. Size catches a truncated
write — the common case — but the reason to archive at all is that these bytes
must still be trainable in a year, and a silent corruption over NFS would
otherwise be discovered only when someone tries to use the data and the source
is long gone. The cost is one extra read of the destination; the job is async
precisely so that cost is affordable.

What the read-back does NOT prove is that the bytes reached the media. The
destination is fsynced before it is re-read, but the re-read is an ordinary
open, so a filesystem is free to answer it from cache — and nothing here
defends against a third party rewriting the destination between the hash and
the source's removal. So this is "kairos wrote what it meant to write, and
could read it back", not an end-to-end integrity guarantee against the storage
itself. Claiming the stronger thing would be worse than claiming nothing,
because the operator's next decision is whether to keep a second copy.

Failure leaves the SOURCE intact, always. A partially-written destination is
left in place rather than cleaned up, because deleting files at a path that
just failed a safety check is the last thing this pipeline should do; the next
attempt refuses to write into a non-empty destination and says so.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path
from typing import Any

from kairos_common import (
    ApiError,
    lifecycle_ledger,
    parse_archive_roots,
    resolve_archive_destination,
    topic_signature,
    utc_now_iso8601,
)

PIPELINE_ID = "dataset_archive"
PIPELINE_VERSION = "1.0.0"

# Read size for the copy/hash stream. 4 MiB keeps the syscall count low on
# multi-GB bags without holding a meaningful amount of memory.
_CHUNK = 4 * 1024 * 1024

_RESERVED_TOP = {"recorded", "report", "datasets"}


def _sha256_and_copy(source: Path, target: Path) -> tuple[str, int]:
    """Copy *source* to *target*, hashing as we read; returns (sha256, bytes).

    The hash comes from the SAME read that feeds the write, so it describes the
    bytes actually copied rather than a second, possibly different, read of the
    source. ``fsync`` before close pushes the data out of the page cache: on a
    network filesystem a close alone can return before the server has the data,
    which would make the read-back verify a cache hit rather than a real check.
    """
    digest = hashlib.sha256()
    total = 0
    with source.open("rb") as src, target.open("wb") as dst:
        while True:
            chunk = src.read(_CHUNK)
            if not chunk:
                break
            digest.update(chunk)
            dst.write(chunk)
            total += len(chunk)
        dst.flush()
        os.fsync(dst.fileno())
    shutil.copystat(source, target)
    return digest.hexdigest(), total


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(_CHUNK)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _fsync_dir(path: Path) -> None:
    """Persist the directory ENTRIES (fsync on the files is not enough)."""
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _overlaps(a: Path, b: Path) -> bool:
    """Whether either path contains the other (or they are the same)."""
    return a == b or a.is_relative_to(b) or b.is_relative_to(a)


def _dataset_meta(source: Path) -> dict[str, Any]:
    """The dataset's own ``dataset.json`` (``{}`` when unreadable).

    Read for the ledger entry: run_id and the topic signature are what keep an
    archived episode identifiable once its bag is on another machine.
    """
    try:
        data = json.loads((source / "dataset.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _resolve_source(data_dir: Path, dataset_dir: str) -> Path:
    """The dataset directory to archive, constrained to the catalog tree.

    ``dataset_dir`` is a data-relative ``<operator>/<task>/<NNN>`` path (the
    same shape the loss/video jobs take). Anything that escapes ``data_dir``,
    names a reserved top-level dir, or is not an exported dataset (no
    ``dataset.json``) is refused before a single byte is read.
    """
    relative = Path((dataset_dir or "").strip())
    if relative.is_absolute():
        try:
            relative = relative.relative_to(data_dir)
        except ValueError:
            raise ApiError(
                status_code=400,
                code="invalid_dataset_dir",
                message="dataset_dir must be inside the data directory.",
                details={"dataset_dir": dataset_dir},
            ) from None
    parts = relative.parts
    if len(parts) != 3 or ".." in parts or parts[0] in _RESERVED_TOP:
        raise ApiError(
            status_code=400,
            code="invalid_dataset_dir",
            message="dataset_dir must be '<operator>/<task>/<NNN>'.",
            details={"dataset_dir": dataset_dir},
        )
    source = data_dir / relative
    if not source.is_dir() or not (source / "dataset.json").is_file():
        raise ApiError(
            status_code=404,
            code="dataset_not_found",
            message=f"No exported dataset at {relative}.",
            details={"dataset_dir": str(relative)},
        )
    return source


def _prepare_destination(destination: Path) -> None:
    """Create the destination dir, refusing to write into a non-empty one.

    Refusing is what keeps a retry after a failed archive from silently mixing
    two attempts' files — and what stops an archive from overwriting a
    previously archived episode that happens to share the path.
    """
    if destination.exists():
        if not destination.is_dir():
            raise ApiError(
                status_code=409,
                code="destination_exists",
                message="The archive destination exists and is not a directory.",
                details={"destination": str(destination)},
            )
        if any(destination.iterdir()):
            raise ApiError(
                status_code=409,
                code="destination_not_empty",
                message=(
                    "The archive destination already contains files — refusing "
                    "to write into it. Choose another path, or clear it if it "
                    "is the debris of a failed archive."
                ),
                details={"destination": str(destination)},
            )
        return
    try:
        destination.mkdir(parents=True)
    except OSError as exc:
        raise ApiError(
            status_code=400,
            code="destination_unwritable",
            message=f"Could not create the archive destination: {exc}",
            details={"destination": str(destination)},
        ) from exc


def run_dataset_archive(
    *,
    data_dir: Path,
    dataset_dir: str,
    destination: str,
    reason: str | None = None,
) -> dict[str, Any]:
    """Copy the dataset to *destination*, verify it, then delete the source.

    Returns the ``{summary, artifacts}`` JobResult shape. The summary carries a
    per-file ``sha256`` so the archived copy stays auditable from the ledger
    entry alone (the source is gone by then).

    The allow-list is re-checked HERE even though the orchestrator already
    checked it: this job takes a destination path as a parameter, and a
    path-taking, source-deleting operation should not depend on its caller
    having been careful.
    """
    # The allow-list is deployment configuration and is read from THIS
    # service's environment, from nowhere else. It is deliberately NOT a
    # parameter: a path-taking, source-deleting operation must not let its
    # caller widen its own boundary, and a parameter is something a caller can
    # eventually be wired to — which is exactly how this went wrong once
    # (a job param let any LAN caller pass "/" and archive anywhere writable,
    # then delete the original).
    #
    # Tests set the variable itself rather than injecting a value, so they
    # exercise the same branch a deployment does; a misspelling here would fail
    # them instead of silently shipping an unconfigured archive path.
    roots = parse_archive_roots(os.environ.get("KAIROS_ARCHIVE_ROOTS"))
    target = resolve_archive_destination(destination, roots)
    source = _resolve_source(data_dir, dataset_dir)
    # An archive root that happens to contain the data directory would otherwise
    # let the destination sit INSIDE the source: the copy succeeds, verifies,
    # and `rmtree(source)` then deletes the verified archive along with the
    # original. The job would report success with nothing left. The allow-list
    # cannot catch this — it is about where writing is permitted, not about the
    # two paths overlapping — so check the relationship directly.
    resolved_data = Path(data_dir).resolve()
    if _overlaps(target, source) or _overlaps(target, resolved_data):
        raise ApiError(
            status_code=400,
            code="destination_inside_data_dir",
            message=(
                "The archive destination overlaps kairos' own data directory. "
                "Archiving there would delete the copy along with the original."
            ),
            details={"destination": str(target), "data_dir": str(resolved_data)},
        )

    files = sorted(p for p in source.iterdir() if p.is_file())
    if not files:
        raise ApiError(
            status_code=409,
            code="dataset_empty",
            message="The dataset directory holds no files to archive.",
            details={"dataset_dir": dataset_dir},
        )

    _prepare_destination(target)

    # ---- copy (hashing the bytes we write) --------------------------------
    copied: list[dict[str, Any]] = []
    for path in files:
        try:
            digest, size = _sha256_and_copy(path, target / path.name)
        except OSError as exc:
            raise ApiError(
                status_code=500,
                code="archive_copy_failed",
                message=f"Copy failed for {path.name}: {exc}. The source is untouched.",
                details={"file": path.name, "destination": str(target)},
            ) from exc
        copied.append({"name": path.name, "bytes": size, "sha256": digest})
    _fsync_dir(target)

    # ---- verify (read the destination BACK) -------------------------------
    for record in copied:
        written = target / str(record["name"])
        if not written.is_file():
            raise ApiError(
                status_code=500,
                code="archive_verify_failed",
                message=(
                    f"{record['name']} is missing from the destination after the "
                    "copy. The source is untouched."
                ),
                details={"file": record["name"], "destination": str(target)},
            )
        actual_size = written.stat().st_size
        if actual_size != record["bytes"]:
            raise ApiError(
                status_code=500,
                code="archive_verify_failed",
                message=(
                    f"{record['name']} is {actual_size} bytes at the destination "
                    f"but {record['bytes']} at the source. The source is untouched."
                ),
                details={"file": record["name"], "destination": str(target)},
            )
        if _sha256(written) != record["sha256"]:
            raise ApiError(
                status_code=500,
                code="archive_verify_failed",
                message=(
                    f"{record['name']} does not match its source checksum at the "
                    "destination. The source is untouched."
                ),
                details={"file": record["name"], "destination": str(target)},
            )

    # ---- record the departure BEFORE removing the source ------------------
    # The ledger entry is written by the process that does the deleting, and
    # written first. Recording it afterwards — or from the caller once the job
    # reports success — leaves a window where the bytes are gone but the index
    # number is free again, which is precisely the state the ledger exists to
    # prevent, and a service restart lands in that window for real.
    #
    # Writing early trades that for the harmless inverse: if the removal then
    # fails, a number is retired while its data is still present. The allocator
    # counts the directory anyway, so nothing is issued twice; the ledger simply
    # says "left" a little early, and the failed job says so too.
    total_bytes = sum(int(r["bytes"]) for r in copied)
    meta = _dataset_meta(source)
    # Prefer the signature computed from the bag itself: dataset.json carries it
    # only for exports made since the signature landed, while metadata.yaml is
    # there for every bag — and this is the last moment the bag can be read.
    signature = topic_signature(source)
    operator, task, index = source.parent.parent.name, source.parent.name, source.name
    lifecycle_ledger.append(
        data_dir,
        lifecycle_ledger.LedgerEntry(
            event="archived",
            operator=operator,
            task=task,
            index=index,
            run_id=meta.get("run_id"),
            destination=str(target),
            reason=reason,
            topics_hash=signature.hash if signature else meta.get("topics_hash"),
            topic_count=signature.count if signature else meta.get("topic_count"),
            bytes=total_bytes,
            message_count=meta.get("message_count"),
        ),
    )
    shutil.rmtree(source)
    # Prune the husks the same way delete does, so an emptied task/operator dir
    # doesn't linger in the tree. rmdir refuses a non-empty dir, ending the walk.
    for parent in (source.parent, source.parent.parent):
        try:
            parent.rmdir()
        except OSError:
            break

    summary = {
        "pipeline": PIPELINE_ID,
        "version": PIPELINE_VERSION,
        "dataset_dir": str(Path(dataset_dir)),
        "destination": str(target),
        "files": copied,
        "file_count": len(copied),
        "bytes": total_bytes,
        # Named for what was actually done: a SHA-256 read-back of the
        # destination, which is not a media-level integrity proof.
        "verified": "sha256-readback",
        "source_removed": True,
        "archived_at": utc_now_iso8601(),
    }
    return {"summary": summary, "artifacts": [str(target)]}
