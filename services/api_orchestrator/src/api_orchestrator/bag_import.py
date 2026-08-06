"""Import an externally recorded rosbag into Review (2026-07-27).

WHY: recordings made outside kairos — a plain ``ros2 bag record -s mcap`` on a
robot, a colleague's bag, an archived experiment — had no way in. The only
producer of a ``runs`` row was kairos's own recorder, so an operator with an
existing bag could not validate it, label it, or export it, even though every
downstream stage reads nothing but the bag directory and its sidecars.

Shape of the import, and why each part is the way it is:

* **The input is a server-side path**, never a browser upload: these are
  multi-GB directories and the file already sits on a disk the service can see.
* **Copy by default; MOVE only on an explicit flag.** The source belongs to the
  operator, not to us. Even with ``move=true`` the source is deleted only after
  the import is fully finalised — so a failure at any point leaves the original
  exactly where it was.
* **Staged under ``.incoming/<capture_id>`` and atomic-renamed into place**, the
  same contract the robot-pull importer follows. §2's invariant is that an
  incomplete directory under ``objects/`` can only ever be a live recording, so
  a partially-copied import must never be visible there. The rename is the
  single instant at which the capture becomes real.
* **The capture row is created only AFTER the rename succeeds.** A row written
  up-front would be a capture with no bytes behind it, which every other path
  (the reconciler, retention, the digest queue) would then have to learn to
  ignore. In-flight progress lives in :class:`ImportRegistry` instead, and a
  failed import leaves nothing to clean up.

``metadata.yaml`` is REQUIRED, and that is a deliberate rejection rather than a
warning — see :func:`inspect_source`.
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import uuid
from collections.abc import Container
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from kairos_common.bag_metadata import METADATA_FILENAME, read_bag_metadata
from kairos_common.capture_sidecars import (
    ObjectManifestV2,
    write_object_manifest,
)
from kairos_common.errors import ApiError
from kairos_common.ids import new_capture_id
from kairos_common.time import utc_now_iso8601

from api_orchestrator.layout import DataLayout, is_reserved_name

logger = logging.getLogger(__name__)

# Read size for the verified copy (matches the archive pipeline).
_COPY_CHUNK = 4 * 1024 * 1024

# Prefix for the display name a bag import gets. capture_id is the identity
# (§1); this only marks provenance at a glance in the capture list.
RUN_ID_PREFIX = "imported"


@dataclass
class SourceBag:
    """A validated import source: the bag directory and what it declares.

    Every field is read from the bag's OWN ``metadata.yaml`` (or the files on
    disk), never assumed — an import must not invent numbers any more than a
    recording may.
    """

    path: Path
    mcap_files: list[Path]
    metadata: dict[str, Any]
    topics: list[tuple[str, str]]  # (name, type), message-carrying topics only
    message_count: int | None
    duration_s: float | None
    started_at: str | None
    ended_at: str | None
    bytes: int
    # Filled in by copy_into_staging: the exact file names that were imported
    # and verified. `move` deletes THIS set — not whatever a second listing of
    # the source finds minutes later, which would sweep up a file dropped in
    # during the copy that was never imported at all.
    copied_names: list[str] = field(default_factory=list)

    @property
    def file_count(self) -> int:
        """Every file copied for this bag (MCAP + metadata + any sidecars)."""
        return len([p for p in self.path.iterdir() if p.is_file()])


def _bag_info(metadata: dict[str, Any]) -> dict[str, Any]:
    """The ``rosbag2_bagfile_information`` block, or the mapping itself.

    rosbag2 nests everything under that one key; some tools hand back the inner
    mapping already unwrapped, so accept both rather than fail on a shape
    difference that carries the same information.
    """
    info = metadata.get("rosbag2_bagfile_information")
    return info if isinstance(info, dict) else metadata


def _coerce_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _ns_to_iso(ns: int | None) -> str | None:
    """Format a rosbag2 nanosecond wall-clock stamp as ISO-8601 UTC."""
    if ns is None or ns <= 0:
        return None
    try:
        return (
            datetime.fromtimestamp(ns / 1e9, tz=UTC).isoformat().replace("+00:00", "Z")
        )
    except (OverflowError, OSError, ValueError):
        return None


def _starting_time_ns(info: dict[str, Any]) -> int | None:
    """rosbag2's ``starting_time.nanoseconds_since_epoch`` (tolerant of shapes)."""
    starting = info.get("starting_time")
    if isinstance(starting, dict):
        return _coerce_int(starting.get("nanoseconds_since_epoch"))
    return _coerce_int(starting)


def _duration_s(info: dict[str, Any]) -> float | None:
    """rosbag2's ``duration.nanoseconds`` in seconds (``None`` when absent)."""
    duration = info.get("duration")
    ns = (
        _coerce_int(duration.get("nanoseconds"))
        if isinstance(duration, dict)
        else _coerce_int(duration)
    )
    if ns is None or ns < 0:
        return None
    return ns / 1e9


def _topics_from_metadata(info: dict[str, Any]) -> list[tuple[str, str]]:
    """(name, type) for every topic that actually carries messages.

    A subscribed topic that recorded nothing is an absent modality, not a
    present one — the same rule ``kairos_common.bag_metadata`` applies when it
    builds the topic signature, so the run row and the signature agree about
    what the bag contains.
    """
    entries = info.get("topics_with_message_count")
    if not isinstance(entries, list):
        return []
    topics: list[tuple[str, str]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if (_coerce_int(entry.get("message_count")) or 0) <= 0:
            continue
        meta = entry.get("topic_metadata")
        if not isinstance(meta, dict):
            continue
        name = meta.get("name")
        if not isinstance(name, str) or not name:
            continue
        type_ = meta.get("type")
        topics.append((name, type_ if isinstance(type_, str) else ""))
    topics.sort()
    return topics


def _dir_bytes(path: Path) -> int:
    """Total size of the files directly inside *path* (best-effort)."""
    total = 0
    for child in path.iterdir():
        if child.is_file():
            try:
                total += child.stat().st_size
            except OSError:  # pragma: no cover - racing deletion
                continue
    return total


def _mcap_summary(path: Path) -> tuple[str | None, int | None]:
    """``(unreadable reason, message count)`` for one shard.

    Only the summary/footer section is read — the same Layer-1 trick the
    stop-time quick check uses (``quick_check.read_mcap_summary``), so this
    stays milliseconds even on a multi-GB bag. A file that cannot be opened at
    all is the interesting case: it means the import would land something no
    validator could ever read.

    The count comes from the same read, which is why comparing it against what
    ``metadata.yaml`` declares costs nothing extra. ``None`` means the file
    carries no statistics section (an unindexed MCAP) — unknown, not zero, and
    a caller must not treat it as a shortfall.
    """
    from mcap.reader import make_reader

    try:
        with path.open("rb") as fh:
            summary = make_reader(fh).get_summary()
    except Exception as exc:  # noqa: BLE001 - mcap raises assorted parse errors
        return (str(exc) or exc.__class__.__name__), None
    if summary is None or summary.statistics is None:
        return None, None
    return None, int(summary.statistics.message_count)


def _declared_mcaps(info: dict[str, Any]) -> tuple[list[str], str | None]:
    """``(shard names, damage)`` from ``metadata.yaml``'s own file inventory.

    rosbag2 writes ``relative_file_paths``; older versions carry the same list
    as ``files[].path``. Both being ABSENT is not a complaint — there is simply
    nothing to check against, and inventing a failure from it would reject bags
    that are perfectly whole.

    A field that is present but the wrong shape is the opposite, and the
    distinction is the same one the lifecycle ledger draws one directory over:
    damage is not absence. ``relative_file_paths: bag_0.mcap`` — a string where
    a list belongs — used to fall through to the absent branch and produce an
    empty inventory, so a bag whose own manifest is malformed imported as
    though it had declared nothing. That reads the damage as a clean bill of
    health, which is the one interpretation it cannot bear.

    Only ``.mcap`` entries are returned: a ``.db3`` sibling listed here is a
    different storage plugin's business, and is rejected earlier if it is all
    the bag has.
    """
    raw: Any = info.get("relative_file_paths")
    if raw is None:
        entries: Any = info.get("files")
        if entries is None:
            return [], None  # no inventory at all: nothing to check
        if not isinstance(entries, list):
            return [], "files is not a list"
        raw = []
        for entry in entries:
            if not isinstance(entry, dict):
                return [], "files contains an entry that is not a mapping"
            raw.append(entry.get("path"))
    elif not isinstance(raw, list):
        return [], "relative_file_paths is not a list"

    names: list[str] = []
    for entry in raw:
        if entry is None:
            continue  # a files[] entry with no path key: nothing declared
        if not isinstance(entry, str):
            return [], "the file inventory contains a non-string path"
        if not entry.endswith(".mcap"):
            continue
        # Only the BASENAME is used. The paths are relative to the bag
        # directory, so a metadata.yaml naming ``../../outside.mcap`` must not
        # send this looking outside it — collapsed, it is simply looked for
        # here and reported missing, and the file it named is never touched.
        #
        # The price, stated rather than hidden: a bag that genuinely keeps a
        # shard in a subdirectory (``sub/bag_1.mcap``) is refused as missing
        # even though the file exists. rosbag2 writes flat paths, so this is
        # theoretical — but it is a real trade, not a free guard.
        names.append(Path(entry).name)
    return names, None


def inspect_source(source: Path, *, layout: DataLayout) -> SourceBag:
    """Validate an import source and read what it declares, or raise ApiError.

    Every rejection names the offending path and says what to do about it —
    "unreadable MCAP" with no path is not an error message, it is a shrug.

    ``metadata.yaml`` is REQUIRED, and the choice to reject rather than warn is
    deliberate:

    * §8's rebuild uses ``metadata.yaml`` (or an ``.mcap``) to tell an
      ``interrupted`` capture from a ``failed`` one, so a bag imported without
      it would be reclassified as a failed recording on the next rebuild — the
      catalog would quietly contradict the import that succeeded.
    * ``kairos_common.bag_metadata.topic_signature`` returns ``None`` without
      it, so the episode would enter the catalog with an UNKNOWN topic set —
      precisely the silent-schema-mismatch failure the signature exists to stop.
    * ``bagflow-topic-presence`` builds its topic inventory from that file, so
      ``fast_validation`` could not run: an unvalidatable run, in the tool whose
      job is validation.
    * ``ros2 bag record`` always writes it on a clean shutdown. Its absence
      means an aborted recording or a half-copied directory — exactly what the
      ``.incoming`` staging exists to keep out of ``recorded/``.

    And it is cheap to fix: ``ros2 bag reindex`` regenerates it. Rejecting costs
    the operator one command; accepting would hand them a run that is degraded
    in four places at once, none of them visible at import time.
    """
    if not source.exists():
        raise ApiError(
            status_code=400,
            code="import_source_missing",
            message=(
                f"Nothing exists at {source}. Give the path to a rosbag2 "
                "directory as the SERVER sees it (not your laptop's path)."
            ),
            details={"source_path": str(source)},
        )
    if not source.is_dir():
        raise ApiError(
            status_code=400,
            code="import_source_not_a_directory",
            message=(
                f"{source} is a file, not a directory. Import the bag DIRECTORY "
                "— the one holding the .mcap file(s) and metadata.yaml."
            ),
            details={"source_path": str(source)},
        )

    # Importing out of the STORE's own subtrees would copy a capture onto
    # itself (and, under .incoming/, race the copy still writing it). Only
    # those are refused — not all of data_dir: `data/<bags>/` is where AGENTS.md
    # tells operators to drop sample and incoming recordings, and refusing the
    # documented drop spot made the import unusable without a second mount.
    data_root = layout.data_dir.resolve()
    try:
        relative = source.relative_to(data_root)
    except ValueError:
        pass
    else:
        head = relative.parts[0] if relative.parts else ""
        if not relative.parts or is_reserved_name(head):
            raise ApiError(
                status_code=400,
                code="import_source_inside_data_dir",
                message=(
                    f"{source} is inside kairos's own store ({data_root / head}). "
                    "Those directories hold captures kairos already manages — "
                    "importing from one would copy a capture onto itself. Point "
                    "at the folder the bags were recorded into instead."
                ),
                details={
                    "source_path": str(source),
                    "data_dir": str(layout.data_dir),
                    "reserved": head,
                },
            )

    mcap_files = sorted(source.glob("*.mcap"))
    if not mcap_files:
        raise ApiError(
            status_code=400,
            code="import_no_mcap",
            message=(
                f"No .mcap file in {source}. kairos imports rosbag2 recordings "
                "in MCAP form — re-record with `ros2 bag record -s mcap`, or "
                "convert an existing .db3 bag with `ros2 bag convert`."
            ),
            details={"source_path": str(source)},
        )

    if not (source / METADATA_FILENAME).is_file():
        raise ApiError(
            status_code=400,
            code="import_no_metadata",
            message=(
                f"No {METADATA_FILENAME} in {source}. Without it the bag has no "
                "topic inventory, so it could be neither validated nor compared "
                "against other episodes, and Review would keep reporting it as "
                f"not yet transferred. Run `ros2 bag reindex {source}` to "
                "regenerate it, then import again."
            ),
            details={
                "source_path": str(source),
                "remedy": f"ros2 bag reindex {source}",
            },
        )

    metadata = read_bag_metadata(source)
    if metadata is None:
        raise ApiError(
            status_code=400,
            code="import_unreadable_metadata",
            message=(
                f"{source / METADATA_FILENAME} could not be parsed as YAML. The "
                "recording is likely truncated or was copied while still being "
                f"written. `ros2 bag reindex {source}` rewrites it from the "
                "MCAP itself."
            ),
            details={"source_path": str(source)},
        )

    info = _bag_info(metadata)
    topics = _topics_from_metadata(info)
    if not topics:
        raise ApiError(
            status_code=400,
            code="import_no_topics",
            message=(
                f"{source / METADATA_FILENAME} lists no topic that recorded any "
                "message, so there is nothing in this bag to validate or "
                "convert. Check that the recording actually captured data."
            ),
            details={"source_path": str(source)},
        )

    # The bag's own inventory, against the directory. A split recording is only
    # whole if every shard it declares is here: an interrupted copy leaves the
    # rest readable and metadata.yaml still counting the messages of the one
    # that never arrived, so the capture lands looking complete and short.
    declared, inventory_damage = _declared_mcaps(info)
    if inventory_damage is not None:
        raise ApiError(
            status_code=400,
            code="import_damaged_inventory",
            message=(
                f"{source / METADATA_FILENAME} declares its own files in a shape "
                f"this cannot read ({inventory_damage}). That is damage, not an "
                "older format — and read as 'nothing declared' it would let a "
                "bag missing half its shards import as whole. "
                f"`ros2 bag reindex {source}` rewrites the file from the MCAPs."
            ),
            details={
                "source_path": str(source),
                "remedy": f"ros2 bag reindex {source}",
            },
        )
    missing = [name for name in declared if not (source / name).is_file()]
    if missing:
        raise ApiError(
            status_code=400,
            code="import_missing_shard",
            message=(
                f"{METADATA_FILENAME} lists {len(missing)} file(s) that are not "
                f"in {source}: {', '.join(missing)}. The copy is incomplete — "
                "the messages they hold would be counted by the catalog and "
                "absent from the bag. Copy the whole directory again."
            ),
            details={"source_path": str(source), "missing": missing},
        )

    # EVERY shard, not just the first. A recording still being written has a
    # complete shard 0 and a growing tail, so checking only the first is the
    # one arrangement guaranteed to miss it.
    #
    # Cost, decided deliberately: this is O(shards) per bag and the scan
    # endpoint runs it over a whole folder, so a directory of hundreds of
    # multi-shard bags scans proportionally slower. It stays footer-only — a
    # seek per shard, not a read — and the alternative of checking only the
    # first and last would let a truncated MIDDLE shard through, which is this
    # same bug wearing a different hat. If the scan ever turns out to be slow,
    # measure it and bound it on evidence; do not trade the hole back.
    counted = 0
    every_shard_counted = True
    for mcap in mcap_files:
        unreadable, count = _mcap_summary(mcap)
        if unreadable is None:
            if count is None:
                every_shard_counted = False
            else:
                counted += count
            continue
        raise ApiError(
            status_code=400,
            code="import_unreadable_mcap",
            message=(
                f"{mcap.name} could not be read as an MCAP file "
                f"({unreadable}). The recording is likely truncated or still "
                "being written — copy it again once the recorder has stopped."
            ),
            details={"source_path": str(source), "file": mcap.name},
        )

    # What the bag SAYS it holds, against what its own summaries count. The
    # missing-shard check above catches a file that never arrived; this catches
    # the same harm with every file present — metadata declaring 999,999
    # messages over a bag holding three, which imports a capture whose
    # message_count counts messages that are not there.
    #
    # Only a SHORTFALL is refused. An unindexed shard reports no statistics at
    # all, and "unknown" must not be read as "zero", so a single uncounted
    # shard abandons the comparison rather than inventing a deficit.
    declared_count = _coerce_int(info.get("message_count"))
    if every_shard_counted and declared_count is not None and counted < declared_count:
        raise ApiError(
            status_code=400,
            code="import_message_count_short",
            message=(
                f"{METADATA_FILENAME} declares {declared_count} messages but the "
                f"MCAP files hold {counted}. The bag and its own description "
                "disagree, so importing it would put a count in the catalog "
                "that nothing on disk supports. "
                f"`ros2 bag reindex {source}` rewrites the file from the MCAPs."
            ),
            details={
                "source_path": str(source),
                "declared": declared_count,
                "counted": counted,
                "remedy": f"ros2 bag reindex {source}",
            },
        )

    started_ns = _starting_time_ns(info)
    duration = _duration_s(info)
    started_at = _ns_to_iso(started_ns)
    ended_at = (
        _ns_to_iso(started_ns + int(duration * 1e9))
        if started_ns is not None and duration is not None
        else None
    )
    return SourceBag(
        path=source,
        mcap_files=mcap_files,
        metadata=metadata,
        topics=topics,
        message_count=_coerce_int(info.get("message_count")),
        duration_s=duration,
        started_at=started_at,
        ended_at=ended_at,
        bytes=_dir_bytes(source),
    )


def import_manifest(
    bag: SourceBag, capture_id: str, run_id: str, *, instance_id: str
) -> ObjectManifestV2:
    """The synthesized ``object_manifest.json`` for an imported bag (§3.3).

    ``operator`` and ``task`` are deliberately NULL. They are the two things no
    external bag can answer, and guessing them — from a directory name, say —
    would put a fabricated attribution onto data destined for a training set.
    The operator fills them in from Review, where the same fields are editable
    for any capture.

    ``digest_state`` stays ``pending``: the bytes were copied and verified, but
    the per-file hashes that the manifest records are the digest job's single
    atomic write to make (§3.3), not this one's.
    """
    return ObjectManifestV2(
        capture_id=capture_id,
        source_instance_id=instance_id,
        run_id=run_id,
        state="completed",
        started_at=bag.started_at or utc_now_iso8601(),
        ended_at=bag.ended_at,
        operator=None,
        task=None,
        topics=tuple(
            {"name": name, "type": type_, "qos": None} for name, type_ in bag.topics
        ),
        message_count=bag.message_count,
        bytes=bag.bytes,
        integrity="unknown",
        imported_from=str(bag.path),
        imported_at=utc_now_iso8601(),
    )


# Bound on suffix retries when a same-second import run_id is taken, mirroring
# ``_MAX_BATCH_ID_ATTEMPTS``. A bulk run of 40 needs 39 of them.
MAX_RUN_ID_ATTEMPTS = 200


def allocate_import_run_id(
    now: datetime | None = None, *, taken: Container[str] = frozenset()
) -> str:
    """``imported_YYYYmmdd_HHMMSS`` (+ ``_N`` if taken) — the display name (§1).

    Second resolution is not unique enough on its own. A bulk import POSTs
    every bag up front — the copies are what ``_COPY_SLOTS`` throttles, not the
    requests — so forty bags are claimed inside one second and would all be
    handed the same name. ``captures.run_id`` is UNIQUE, so those are not forty
    display names, they are thirty-nine rows that cannot be inserted.

    The ``_N`` suffix is the shape AGENTS.md already documents for a run id
    (``run_YYYYMMDD_HHMMSS(_N)``), and the same answer ``_allocate_batch_id``
    gives to the same same-second problem.
    """
    moment = now or datetime.now(UTC)
    base = moment.strftime(f"{RUN_ID_PREFIX}_%Y%m%d_%H%M%S")
    if base not in taken:
        return base
    for attempt in range(2, MAX_RUN_ID_ATTEMPTS + 2):
        candidate = f"{base}_{attempt}"
        if candidate not in taken:
            return candidate
    raise ApiError(
        status_code=503,
        code="import_run_id_unavailable",
        message=(
            f"Could not allocate a display name for this import: {base} and "
            f"{MAX_RUN_ID_ATTEMPTS} suffixed variants are all taken. Retry in "
            "a second."
        ),
    )


def taken_run_ids(store: Any, prefix: str) -> set[str]:
    """Every run_id already in the catalog that starts with *prefix*.

    Scoped by prefix so this stays a small read on a store holding thousands of
    captures: only same-second import names can collide with the one about to
    be allocated.
    """
    rows = store.execute_read(
        "SELECT run_id FROM captures WHERE run_id LIKE ?", (f"{prefix}%",)
    )
    return {row["run_id"] for row in rows if row["run_id"]}


def claim_capture_id(layout: DataLayout) -> str:
    """Mint a capture_id and RESERVE its staging directory.

    §1 puts id minting for an imported bag on the orchestrator rather than the
    recorder, and the claim happens here — at the start of the import — so every
    later step (staging path, manifest, run row) names one identity. The
    directory is created with ``exist_ok=False`` rather than merely checked:
    reserving the name is what makes two concurrent imports impossible to
    interleave into one staging directory.
    """
    capture_id = new_capture_id()
    layout.incoming.mkdir(parents=True, exist_ok=True)
    layout.incoming_dir(capture_id).mkdir(exist_ok=False)
    return capture_id


def write_manifest(staging: Path, manifest: ObjectManifestV2) -> None:
    """Write the manifest INSIDE staging, so it arrives with the rename."""
    write_object_manifest(staging, manifest)


def copy_into_staging(bag: SourceBag, staging: Path) -> int:
    """Copy every file of *bag* into *staging*; return the bytes written.

    Files only, one level deep: a rosbag2 directory is flat, and refusing to
    recurse means a stray nested directory can never smuggle unrelated data in.
    ``copy2`` preserves mtimes, so the imported bag keeps the timestamps the
    recording actually had.
    """
    # The directory was already reserved by claim_capture_id; creating it
    # here would paper over a lost reservation.
    staging.mkdir(parents=True, exist_ok=True)
    written = 0
    copied: list[str] = []
    for child in sorted(bag.path.iterdir()):
        if not child.is_file():
            continue
        digest, size = _sha256_and_copy(child, staging / child.name)
        _verify(staging / child.name, digest, size)
        written += size
        copied.append(child.name)
    _fsync_dir(staging)
    # The exact set that arrived. `move` deletes THIS, not whatever a second
    # `iterdir()` finds minutes later: a file dropped into the source during a
    # long copy would otherwise be deleted having never been imported.
    bag.copied_names = copied
    return written


def _sha256_and_copy(source: Path, target: Path) -> tuple[str, int]:
    """Copy, hashing the same read that feeds the write; fsync before close.

    Same contract as the archive pipeline's copy. `move` deletes the operator's
    only remaining copy, so it has to be held to the standard archive already
    is: an unverified copy followed by a delete is how both copies are lost.
    """
    digest = hashlib.sha256()
    total = 0
    with source.open("rb") as src, target.open("wb") as dst:
        while chunk := src.read(_COPY_CHUNK):
            digest.update(chunk)
            dst.write(chunk)
            total += len(chunk)
        dst.flush()
        os.fsync(dst.fileno())
    shutil.copystat(source, target)
    return digest.hexdigest(), total


def _verify(written: Path, digest: str, size: int) -> None:
    """Read the staged file back and compare. Raises ``ApiError`` on mismatch."""
    actual = hashlib.sha256()
    with written.open("rb") as handle:
        while chunk := handle.read(_COPY_CHUNK):
            actual.update(chunk)
    if written.stat().st_size != size or actual.hexdigest() != digest:
        raise ApiError(
            status_code=500,
            code="import_verify_failed",
            message=(
                f"{written.name} does not match its source after copying. "
                "The source is untouched."
            ),
            details={"file": written.name},
        )


def _fsync_dir(path: Path) -> None:
    """Persist the directory entries (fsync on the files is not enough)."""
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


def remove_moved_source(bag: SourceBag) -> list[str]:
    """Delete exactly the files ``copy_into_staging`` took; leave the rest.

    ``move`` means "this bag now lives in kairos", not "erase this directory".
    The copy is deliberately top-level files only, so anything else in there —
    a ``notes/`` folder, a raw video, a second bag — was never imported and
    would exist nowhere afterwards. Remove what was imported, then ``rmdir``,
    which refuses a directory that still holds something; what survives is
    named in the return value rather than destroyed.
    """
    for name in bag.copied_names or []:
        (bag.path / name).unlink(missing_ok=True)
    remaining = sorted(p.name for p in bag.path.iterdir())
    if not remaining:
        bag.path.rmdir()
    return remaining


def finalize(layout: DataLayout, capture_id: str) -> Path:
    """Atomically move the staged capture into ``objects/``.

    This single call is the instant the capture becomes real: before it, no
    manifest exists at the final path, so nothing — not the reconciler, not a
    rebuild, not the UI — can see a half-copied import as a capture.
    """
    from api_orchestrator.transfer import adopt_incoming

    return adopt_incoming(layout, capture_id)


# ---- in-flight import tracking -------------------------------------------


@dataclass
class ImportRecord:
    """One import's observable state.

    Held in memory only: this is job status, not a source of truth. The run row
    and the bag on disk are the durable outcome, and both appear only once the
    import has finalised — so losing this registry to a restart costs a progress
    readout, never data.
    """

    import_id: str
    source_path: str
    capture_id: str
    run_id: str
    move: bool
    state: str = "running"  # running | succeeded | failed
    bytes_total: int = 0
    bytes_copied: int = 0
    error_code: str | None = None
    error_message: str | None = None
    started_at: str = field(default_factory=utc_now_iso8601)
    finished_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "import_id": self.import_id,
            "source_path": self.source_path,
            "capture_id": self.capture_id,
            "run_id": self.run_id,
            "move": self.move,
            "state": self.state,
            "bytes_total": self.bytes_total,
            "bytes_copied": self.bytes_copied,
            "error": (
                {"code": self.error_code, "message": self.error_message}
                if self.error_code
                else None
            ),
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


class ImportRegistry:
    """The in-memory set of imports this process has run, newest last."""

    def __init__(self, limit: int = 50) -> None:
        self._records: dict[str, ImportRecord] = {}
        self._limit = limit

    def create(
        self,
        *,
        source_path: str,
        capture_id: str,
        run_id: str,
        move: bool,
        bytes_total: int,
    ) -> ImportRecord:
        record = ImportRecord(
            import_id=uuid.uuid4().hex[:12],
            source_path=source_path,
            capture_id=capture_id,
            run_id=run_id,
            move=move,
            bytes_total=bytes_total,
        )
        self._records[record.import_id] = record
        self._evict()
        return record

    def get(self, import_id: str) -> ImportRecord:
        record = self._records.get(import_id)
        if record is None:
            raise ApiError(
                status_code=404,
                code="import_not_found",
                message=(
                    f"No import with id {import_id} "
                    "(imports are not kept across restarts)."
                ),
                details={"import_id": import_id},
            )
        return record

    def list(self) -> list[ImportRecord]:
        return list(self._records.values())

    def _evict(self) -> None:
        """Drop the oldest FINISHED records once the cap is exceeded."""
        while len(self._records) > self._limit:
            for key, rec in self._records.items():
                if rec.state != "running":
                    del self._records[key]
                    break
            else:  # pragma: no cover - all running; keep them all
                return
