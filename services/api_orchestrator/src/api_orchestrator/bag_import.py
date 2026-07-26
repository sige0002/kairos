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
* **Staged under ``.incoming/`` and atomic-renamed into place**, the same
  contract the robot-pull importer follows (e7c8c6a). ``RunService._bag_local``
  keys "a finalised local copy exists" on ``recorded/<run_id>/metadata.yaml``
  in the FINAL path, so a partially-copied import must never be visible there.
  The rename is the single instant at which the run becomes real.
* **The run row is created only AFTER the rename succeeds.** A row written
  up-front would be a run with no recording behind it, which every other
  lifecycle path (startup reconciliation, retention, the pending-validation
  scan) would then have to learn to ignore. In-flight progress lives in
  :class:`ImportRegistry` instead, and a failed import leaves nothing to clean.

``metadata.yaml`` is REQUIRED, and that is a deliberate rejection rather than a
warning — see :func:`inspect_source`.
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from kairos_common.bag_metadata import METADATA_FILENAME, read_bag_metadata
from kairos_common.errors import ApiError
from kairos_common.time import utc_now_iso8601

logger = logging.getLogger(__name__)

# Staging directory for in-flight imports, a sibling of the finalised runs.
# Dot-prefixed so it sorts and globs out of the way of real run directories.
INCOMING_DIRNAME = ".incoming"

# Prefix for a generated run_id. Satisfies ``^[A-Za-z0-9_-]+$`` (the charset
# mcap_utils.validate_run_id and the recorder both enforce) by construction,
# and marks the run's provenance at a glance in Review.
RUN_ID_PREFIX = "imported"

# Bound on suffix retries when a generated run_id collides (two imports started
# in the same second). Mirrors run/batch id allocation.
_MAX_RUN_ID_ATTEMPTS = 50


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


def _mcap_is_readable(path: Path) -> str | None:
    """``None`` when the MCAP parses, else a plain-language reason.

    Only the summary/footer section is read — the same Layer-1 trick the
    stop-time quick check uses (``quick_check.read_mcap_summary``), so this
    stays milliseconds even on a multi-GB bag. A file that cannot be opened at
    all is the interesting case: it means the import would land something no
    validator could ever read.
    """
    from mcap.reader import make_reader

    try:
        with path.open("rb") as fh:
            make_reader(fh).get_summary()
    except Exception as exc:  # noqa: BLE001 - mcap raises assorted parse errors
        return str(exc) or exc.__class__.__name__
    return None


def inspect_source(source: Path, *, recorded_dir: Path) -> SourceBag:
    """Validate an import source and read what it declares, or raise ApiError.

    Every rejection names the offending path and says what to do about it —
    "unreadable MCAP" with no path is not an error message, it is a shrug.

    ``metadata.yaml`` is REQUIRED, and the choice to reject rather than warn is
    deliberate:

    * ``RunService._bag_local`` decides "a finalised local copy exists on this
      host" purely by the presence of ``recorded/<run_id>/metadata.yaml``. A run
      imported without one would report ``bag_local=false`` forever, and the
      Review UI reads that as "still on the robot, not transferred yet" — so the
      run would be permanently, invisibly mislabelled.
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

    # Importing out of recorded/ would copy a run onto itself (and, for a source
    # under .incoming/, race the copy that is still writing it).
    try:
        source.relative_to(recorded_dir.resolve())
    except ValueError:
        pass
    else:
        raise ApiError(
            status_code=400,
            code="import_source_inside_recorded",
            message=(
                f"{source} is already inside kairos's own recordings directory "
                f"({recorded_dir}). That run is in Review already — importing it "
                "would only make a second copy of it."
            ),
            details={"source_path": str(source), "recorded_dir": str(recorded_dir)},
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

    unreadable = _mcap_is_readable(mcap_files[0])
    if unreadable is not None:
        raise ApiError(
            status_code=400,
            code="import_unreadable_mcap",
            message=(
                f"{mcap_files[0].name} could not be read as an MCAP file "
                f"({unreadable}). The recording is likely truncated or still "
                "being written — copy it again once the recorder has stopped."
            ),
            details={"source_path": str(source), "file": mcap_files[0].name},
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


def session_payload(bag: SourceBag, run_id: str, *, moved: bool) -> dict[str, Any]:
    """The synthesized ``session.json`` for an imported run.

    ``operator`` and ``task`` are deliberately NULL. They are the two fields no
    external bag can answer, and guessing them (from a directory name, say)
    would put a fabricated attribution onto data destined for a training set —
    the operator fills them in from Review, where the same fields are editable
    for any recording. Everything else comes from the bag's own metadata.

    ``imported_from`` keeps the provenance the run_id deliberately does not
    encode, so "where did this come from?" survives without forcing the source
    path through the run_id charset.
    """
    return {
        "run_id": run_id,
        "operator": None,
        "task": None,
        "state": "completed",
        "started_at": bag.started_at,
        "ended_at": bag.ended_at,
        "topics": [name for name, _type in bag.topics],
        "message_count": bag.message_count if bag.message_count is not None else 0,
        "bytes": bag.bytes,
        # Provenance of the import itself (kairos-specific, additive).
        "imported_from": str(bag.path),
        "imported_at": utc_now_iso8601(),
        "import_mode": "move" if moved else "copy",
    }


def allocate_import_run_id(now: datetime | None = None) -> str:
    """``imported_YYYYmmdd_HHMMSS`` — traversal-safe by construction."""
    moment = now or datetime.now(UTC)
    return moment.strftime(f"{RUN_ID_PREFIX}_%Y%m%d_%H%M%S")


def unique_run_id(recorded_dir: Path, taken: Any, now: datetime | None = None) -> str:
    """A run_id free both on disk and in the store.

    *taken* is a predicate ``(run_id) -> bool``; both are checked because the
    two can disagree (a directory left behind by a deleted row, or vice versa)
    and either collision would corrupt the import.
    """
    base = allocate_import_run_id(now)
    incoming = recorded_dir / INCOMING_DIRNAME
    incoming.mkdir(parents=True, exist_ok=True)
    for attempt in range(_MAX_RUN_ID_ATTEMPTS):
        candidate = base if attempt == 0 else f"{base}_{attempt}"
        if (recorded_dir / candidate).exists() or taken(candidate):
            continue
        # RESERVE the staging directory, don't just check for it. The id is
        # second-resolution, so two requests in the same second used to pass
        # the same checks, both `mkdir(exist_ok=True)` the same staging dir,
        # interleave their copies into it, and finalize one bag built from two
        # sources — after which `move` could delete a source whose data is not
        # what landed. `exist_ok=False` makes the winner unambiguous and sends
        # the loser to the next candidate.
        try:
            (incoming / candidate).mkdir(exist_ok=False)
        except FileExistsError:
            continue
        return candidate
    raise ApiError(
        status_code=409,
        code="run_id_unavailable",
        message="Could not allocate a unique run_id for the import; retry shortly.",
    )


def copy_into_staging(bag: SourceBag, staging: Path) -> int:
    """Copy every file of *bag* into *staging*; return the bytes written.

    Files only, one level deep: a rosbag2 directory is flat, and refusing to
    recurse means a stray nested directory can never smuggle unrelated data in.
    ``copy2`` preserves mtimes, so the imported bag keeps the timestamps the
    recording actually had.
    """
    # The directory was already reserved by unique_run_id; creating it here
    # would paper over a lost reservation.
    staging.mkdir(parents=True, exist_ok=True)
    written = 0
    for child in sorted(bag.path.iterdir()):
        if not child.is_file():
            continue
        shutil.copy2(child, staging / child.name)
        written += child.stat().st_size
    return written


def remove_moved_source(bag: SourceBag) -> list[str]:
    """Delete exactly the files ``copy_into_staging`` took; leave the rest.

    ``move`` means "this bag now lives in kairos", not "erase this directory".
    The copy is deliberately top-level files only, so anything else in there —
    a ``notes/`` folder, a raw video, a second bag — was never imported and
    would exist nowhere afterwards. Remove what was imported, then ``rmdir``,
    which refuses a directory that still holds something; what survives is
    named in the return value rather than destroyed.
    """
    for child in sorted(bag.path.iterdir()):
        if child.is_file():
            child.unlink(missing_ok=True)
    remaining = sorted(p.name for p in bag.path.iterdir())
    if not remaining:
        bag.path.rmdir()
    return remaining


def finalize(staging: Path, final: Path) -> None:
    """Atomically move the staged directory into its final path.

    ``os.replace`` is atomic within a filesystem, and staging lives under
    ``recorded/.incoming`` precisely so it shares one with ``recorded/``. This
    single call is the instant the run becomes visible as complete — before it,
    ``metadata.yaml`` does not exist at the final path, so ``_bag_local`` (and
    therefore Review) correctly reports the run as not yet present.
    """
    final.parent.mkdir(parents=True, exist_ok=True)
    os.replace(staging, final)


def write_session(run_dir: Path, payload: dict[str, Any]) -> None:
    """Write ``session.json`` into *run_dir* atomically (temp + replace)."""
    import json

    path = run_dir / "session.json"
    fd, tmp_name = tempfile.mkstemp(
        dir=str(run_dir), prefix=".session.json.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise


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
        self, *, source_path: str, run_id: str, move: bool, bytes_total: int
    ) -> ImportRecord:
        record = ImportRecord(
            import_id=uuid.uuid4().hex[:12],
            source_path=source_path,
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
