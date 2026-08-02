"""The two files that make a capture self-describing on disk.

``objects/<capture_id>/object_manifest.json`` (contract §3) is the recorder's
audit record — what was recorded, when, in what state, and once the digest job
has run, the per-file hashes that prove the bytes are intact. It replaces the
pre-v2 pair ``manifest.json`` + ``session.json``, which split one recording's
truth across two files that could disagree.

``objects/<capture_id>/record.json`` (contract §4) is the operator's review: was
the task a success, is the quality usable, has it been adopted. It is the *only*
mutable sidecar, and for review fields it — not the database — is authoritative
(§4.1-4). The DB is a queryable cache of it, which is what makes "delete
kairos.db and restart" a supported recovery rather than data loss.

Three things this module is careful about:

**A missing file and a corrupt file are different answers.** §8 rule 4 forbids
reading a 0-byte or unparseable manifest as "no capture here": that would let a
power loss during finalise silently delete a recording from the catalog. So
reads return a :class:`SidecarStatus` — ``ok`` / ``missing`` / ``corrupt`` —
and corrupt carries the reason so it can be shown to an operator instead of
logged and dropped.

**Unknown fields survive a rewrite.** The digest job rewrites the whole manifest
in one atomic write (§3.3), and it must not silently drop a field a newer
recorder wrote. Anything not in the contract's field list is kept in ``extra``
and re-emitted, so passing a manifest through this module is lossless.

**Every id that becomes a path is validated.** ``capture_id`` is a UUIDv7 or the
path helpers raise, so ``objects/<capture_id>`` cannot escape ``objects/``.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

from kairos_common.atomic_io import atomic_write_json
from kairos_common.ids import is_uuid7
from kairos_common.time import utc_now_iso8601

SIDECAR_SCHEMA_VERSION = 2

OBJECTS_DIRNAME = "objects"
TRASH_DIRNAME = ".trash"
INCOMING_DIRNAME = ".incoming"
OBJECT_MANIFEST_FILENAME = "object_manifest.json"
RECORD_FILENAME = "record.json"
ROSBAG2_METADATA_FILENAME = "metadata.yaml"
# A start that never produced a bag is a *sibling* file, never a directory:
# the invariant "a directory under objects/ means bytes were written" is what
# lets a scan trust what it finds (§3.4).
FAILED_START_SUFFIX = ".failed.json"

# What ``hashlib.sha256().hexdigest()`` produces, and the only spelling §3.2's
# digest concatenation may see.
_SHA256_HEX = re.compile(r"\A[0-9a-f]{64}\Z")


class CaptureState(StrEnum):
    """Every state a capture row can hold (§3, §7).

    The first five are what a manifest may carry. The last three are reached
    only through the deletion path and live in the database and the ledger —
    a manifest never says "deleted", because the deletion is precisely the act
    of taking the manifest away.
    """

    recording = "recording"
    stopping = "stopping"
    completed = "completed"
    interrupted = "interrupted"
    failed = "failed"
    delete_pending = "delete_pending"
    discarded = "discarded"
    deleted = "deleted"


# Sets hold plain strings, not enum members: what arrives from JSON is a str,
# and membership must not depend on how Enum happens to hash.
# States a manifest on disk is allowed to declare.
MANIFEST_STATES: frozenset[str] = frozenset(
    {
        CaptureState.recording.value,
        CaptureState.stopping.value,
        CaptureState.completed.value,
        CaptureState.interrupted.value,
        CaptureState.failed.value,
    }
)
# States where the recorder is done and the digest job may run (§9-4).
TERMINAL_STATES: frozenset[str] = frozenset(
    {
        CaptureState.completed.value,
        CaptureState.interrupted.value,
        CaptureState.failed.value,
    }
)
# States the recorder still owns as sole writer (§3.3).
UNFINALIZED_STATES: frozenset[str] = frozenset(
    {CaptureState.recording.value, CaptureState.stopping.value}
)


class DigestState(StrEnum):
    """Whether per-file hashes have been computed and sealed into the manifest."""

    pending = "pending"
    complete = "complete"


class ReviewStatus(StrEnum):
    pending = "pending"
    adopted = "adopted"
    excluded = "excluded"


DIGEST_STATES: frozenset[str] = frozenset(s.value for s in DigestState)
REVIEW_STATUSES: frozenset[str] = frozenset(s.value for s in ReviewStatus)


class SidecarStatus(StrEnum):
    """The three outcomes of reading a sidecar. ``corrupt`` is never ``missing``."""

    ok = "ok"
    missing = "missing"
    corrupt = "corrupt"


@dataclass(frozen=True)
class ManifestFile:
    """One file inside a capture, as sealed by the digest job."""

    path: str
    size: int
    sha256: str

    def to_json(self) -> dict[str, Any]:
        return {"path": self.path, "size": self.size, "sha256": self.sha256}


@dataclass(frozen=True)
class ObjectManifestV2:
    """``object_manifest.json`` (§3): the recorder's record of one capture."""

    capture_id: str
    source_instance_id: str
    run_id: str
    state: str
    started_at: str
    operator: str | None = None
    task: str | None = None
    robot: str | None = None
    ended_at: str | None = None
    topics: tuple[dict[str, Any], ...] = ()
    message_count: int | None = None
    bytes: int | None = None
    compression: str | None = None
    split: dict[str, Any] | None = None
    dropped_messages: int | None = None
    integrity: str = "unknown"
    # Kept from v1 and load-bearing: the terminal state alone does not say why a
    # capture ended, and the reason is what an operator needs to triage it.
    error: str | None = None
    digest_state: str = DigestState.pending
    # ``None`` = the digest job has not run. An empty list would mean "it ran and
    # found nothing", which is a different and much more alarming statement.
    files: tuple[ManifestFile, ...] | None = None
    manifest_digest: str | None = None
    # Imported bags only (§3.3): operator/task are null and these say where the
    # bytes came from.
    imported_from: str | None = None
    imported_at: str | None = None
    schema_version: int = SIDECAR_SCHEMA_VERSION
    # Fields written by some other version of the code. Carried through a
    # read → write cycle untouched so the digest job's rewrite cannot lose them.
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def is_terminal(self) -> bool:
        return self.state in TERMINAL_STATES

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = dict(self.extra)
        payload.update(
            {
                "schema_version": self.schema_version,
                "capture_id": self.capture_id,
                "source_instance_id": self.source_instance_id,
                "run_id": self.run_id,
                "state": str(self.state),
                "operator": self.operator,
                "task": self.task,
                "robot": self.robot,
                "started_at": self.started_at,
                "ended_at": self.ended_at,
                "topics": [dict(topic) for topic in self.topics],
                "message_count": self.message_count,
                "bytes": self.bytes,
                "compression": self.compression,
                "split": self.split,
                "dropped_messages": self.dropped_messages,
                "integrity": self.integrity,
                "error": self.error,
                "digest_state": str(self.digest_state),
                "files": (
                    None if self.files is None else [f.to_json() for f in self.files]
                ),
                "manifest_digest": self.manifest_digest,
            }
        )
        # Only imported bags carry these; a null pair on every recorded capture
        # would read as "import that lost its provenance".
        if self.imported_from is not None:
            payload["imported_from"] = self.imported_from
        if self.imported_at is not None:
            payload["imported_at"] = self.imported_at
        return payload


@dataclass(frozen=True)
class RecordV2:
    """``record.json`` (§4): the operator's review of one capture."""

    capture_id: str
    revision: int
    review_status: str = ReviewStatus.pending
    task_result: str | None = None
    failure_reason: str | None = None
    quality: str | None = None
    quality_source: str | None = None
    batch_id: str | None = None
    index_in_batch: int | None = None
    updated_at: str | None = None
    schema_version: int = SIDECAR_SCHEMA_VERSION
    extra: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # Revision 0 is spelled "no record.json at all" (§4), so a *file* can
        # never carry it. Enforced at construction rather than only at parse
        # time: §4.1 step 2 writes ``base_revision + 1``, and a caller that
        # computed 0 there would produce a sidecar the CAS in step 3 could never
        # match, leaving review saves failing with no visible cause.
        if isinstance(self.revision, bool) or not isinstance(self.revision, int):
            raise ValueError(f"revision must be an int: {self.revision!r}")
        if self.revision < 1:
            raise ValueError(
                f"revision must be >= 1 (0 means no file): {self.revision}"
            )

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = dict(self.extra)
        payload.update(
            {
                "schema_version": self.schema_version,
                "capture_id": self.capture_id,
                "revision": self.revision,
                "task_result": self.task_result,
                "failure_reason": self.failure_reason,
                "quality": self.quality,
                "quality_source": self.quality_source,
                "review_status": str(self.review_status),
                "batch_id": self.batch_id,
                "index_in_batch": self.index_in_batch,
                "updated_at": self.updated_at or utc_now_iso8601(),
            }
        )
        return payload


@dataclass(frozen=True)
class ManifestRead:
    """The outcome of reading an ``object_manifest.json``."""

    status: SidecarStatus
    path: Path
    manifest: ObjectManifestV2 | None = None
    # Why it is corrupt, in words an operator can act on. ``None`` otherwise.
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.status is SidecarStatus.ok


@dataclass(frozen=True)
class RecordRead:
    """The outcome of reading a ``record.json``."""

    status: SidecarStatus
    path: Path
    record: RecordV2 | None = None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.status is SidecarStatus.ok


# -- paths --------------------------------------------------------------------


def validate_capture_id(capture_id: str) -> str:
    """Return *capture_id* if it is a UUIDv7, else raise ``ValueError``.

    Called by every path helper: a capture_id becomes a directory name, so this
    is the guard that keeps ``objects/<capture_id>`` inside ``objects/``.
    """
    if not is_uuid7(capture_id):
        raise ValueError(f"capture_id must be a UUIDv7: {capture_id!r}")
    return capture_id


def objects_dir(data_dir: str | Path) -> Path:
    return Path(data_dir) / OBJECTS_DIRNAME


def trash_dir(data_dir: str | Path) -> Path:
    return Path(data_dir) / TRASH_DIRNAME


def incoming_dir(data_dir: str | Path) -> Path:
    return Path(data_dir) / INCOMING_DIRNAME


def capture_dir(data_dir: str | Path, capture_id: str) -> Path:
    """``<data_dir>/objects/<capture_id>`` — where a capture's bytes live."""
    return objects_dir(data_dir) / validate_capture_id(capture_id)


def object_manifest_path(data_dir: str | Path, capture_id: str) -> Path:
    return capture_dir(data_dir, capture_id) / OBJECT_MANIFEST_FILENAME


def record_path(data_dir: str | Path, capture_id: str) -> Path:
    return capture_dir(data_dir, capture_id) / RECORD_FILENAME


def failed_start_path(data_dir: str | Path, capture_id: str) -> Path:
    """``<data_dir>/objects/<capture_id>.failed.json`` — a sibling, not a dir."""
    return objects_dir(data_dir) / (
        validate_capture_id(capture_id) + FAILED_START_SUFFIX
    )


def _resolve_read(target: str | Path, filename: str) -> Path:
    """A sidecar to read: *target* itself, or *filename* inside it if it is a dir.

    Both spellings are needed. A scan walks capture directories and wants to say
    ``read_object_manifest(dir)``; a caller reading ``objects/<id>.failed.json``
    passes an exact path whose name is not *filename*.
    """
    path = Path(target)
    return path / filename if path.is_dir() else path


def _resolve_write(target: str | Path, filename: str) -> Path:
    """A sidecar to write. The directory need not exist yet, so ``is_dir`` is
    useless here: the name decides."""
    path = Path(target)
    return path if path.name == filename else path / filename


# -- digest -------------------------------------------------------------------


def manifest_digest(files: Iterable[ManifestFile | Mapping[str, Any]]) -> str:
    """The capture's content digest (§3.2), as ``sha256:<hex>``.

    Files are sorted by ``path`` and each contributes ``path\\nsize\\nsha256\\n``
    to one SHA-256. Sorting is what makes the digest a property of the *capture*
    rather than of the directory-listing order that happened to produce it, so
    two machines that hold the same bytes compute the same value and a replica
    can be verified by comparing one string.

    Accepts :class:`ManifestFile` objects or plain mappings with the same keys.
    """
    entries = [_as_manifest_file(entry) for entry in files]
    digest = hashlib.sha256()
    for entry in sorted(entries, key=lambda f: f.path):
        digest.update(f"{entry.path}\n{entry.size}\n{entry.sha256}\n".encode())
    return "sha256:" + digest.hexdigest()


def _as_manifest_file(entry: object) -> ManifestFile:
    if isinstance(entry, ManifestFile):
        return entry
    if isinstance(entry, Mapping):
        return _manifest_file_from_json(entry)
    raise ValueError(f"not a manifest file entry: {entry!r}")


def _manifest_file_from_json(data: Mapping[str, Any]) -> ManifestFile:
    path = data.get("path")
    size = data.get("size")
    sha256 = data.get("sha256")
    if not isinstance(path, str) or not path:
        raise ValueError(f"files[].path must be a non-empty string: {path!r}")
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        raise ValueError(f"files[].size must be a non-negative int: {size!r}")
    if not isinstance(sha256, str) or not _SHA256_HEX.match(sha256):
        # Lowercase specifically: §3.2 concatenates this string into the capture
        # digest, so an uppercase spelling of the same hash would compute a
        # different digest and make two identical replicas compare unequal.
        raise ValueError(
            f"files[].sha256 must be 64 lowercase hex characters: {sha256!r}"
        )
    return ManifestFile(path=path, size=size, sha256=sha256)


# -- parsing ------------------------------------------------------------------

_MANIFEST_KNOWN_KEYS = frozenset(
    {
        "schema_version",
        "capture_id",
        "source_instance_id",
        "run_id",
        "state",
        "operator",
        "task",
        "robot",
        "started_at",
        "ended_at",
        "topics",
        "message_count",
        "bytes",
        "compression",
        "split",
        "dropped_messages",
        "integrity",
        "error",
        "digest_state",
        "files",
        "manifest_digest",
        "imported_from",
        "imported_at",
    }
)

_RECORD_KNOWN_KEYS = frozenset(
    {
        "schema_version",
        "capture_id",
        "revision",
        "task_result",
        "failure_reason",
        "quality",
        "quality_source",
        "review_status",
        "batch_id",
        "index_in_batch",
        "updated_at",
    }
)


def _require_str(data: Mapping[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} must be a non-empty string: {value!r}")
    return value


def _optional_str(data: Mapping[str, Any], key: str) -> str | None:
    value = data.get(key)
    if value is None or isinstance(value, str):
        return value
    raise ValueError(f"{key} must be a string or null: {value!r}")


def _optional_int(data: Mapping[str, Any], key: str) -> int | None:
    value = data.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{key} must be an int or null: {value!r}")
    return value


def _optional_dict(data: Mapping[str, Any], key: str) -> dict[str, Any] | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"{key} must be an object or null: {value!r}")
    return dict(value)


def _check_schema_version(data: Mapping[str, Any]) -> int:
    version = data.get("schema_version")
    if version != SIDECAR_SCHEMA_VERSION:
        # Pre-v2 sidecars are not read at all (alpha reset, §5). Saying so
        # explicitly beats a cascade of "missing field" errors.
        raise ValueError(
            f"unsupported schema_version {version!r} "
            f"(expected {SIDECAR_SCHEMA_VERSION})"
        )
    return SIDECAR_SCHEMA_VERSION


def object_manifest_from_json(data: Mapping[str, Any]) -> ObjectManifestV2:
    """Validate a decoded ``object_manifest.json``. Raises ``ValueError``."""
    if not isinstance(data, Mapping):
        raise ValueError("manifest must be a JSON object")
    _check_schema_version(data)

    capture_id = _require_str(data, "capture_id")
    if not is_uuid7(capture_id):
        raise ValueError(f"capture_id must be a UUIDv7: {capture_id!r}")

    state = _require_str(data, "state")
    if state not in MANIFEST_STATES:
        raise ValueError(f"state {state!r} is not a manifest state")

    digest_state = data.get("digest_state", DigestState.pending.value)
    if digest_state not in DIGEST_STATES:
        raise ValueError(f"digest_state {digest_state!r} is not pending|complete")

    raw_topics = data.get("topics") or []
    if not isinstance(raw_topics, list) or not all(
        isinstance(topic, dict) for topic in raw_topics
    ):
        raise ValueError("topics must be a list of objects")

    raw_files = data.get("files")
    files: tuple[ManifestFile, ...] | None
    if raw_files is None:
        files = None
    elif isinstance(raw_files, list):
        files = tuple(_manifest_file_from_json(entry) for entry in raw_files)
    else:
        raise ValueError("files must be a list or null")

    integrity = data.get("integrity", "unknown")
    if not isinstance(integrity, str):
        raise ValueError(f"integrity must be a string: {integrity!r}")

    return ObjectManifestV2(
        capture_id=capture_id,
        source_instance_id=_require_str(data, "source_instance_id"),
        run_id=_require_str(data, "run_id"),
        state=state,
        started_at=_require_str(data, "started_at"),
        operator=_optional_str(data, "operator"),
        task=_optional_str(data, "task"),
        robot=_optional_str(data, "robot"),
        ended_at=_optional_str(data, "ended_at"),
        topics=tuple(dict(topic) for topic in raw_topics),
        message_count=_optional_int(data, "message_count"),
        bytes=_optional_int(data, "bytes"),
        compression=_optional_str(data, "compression"),
        split=_optional_dict(data, "split"),
        dropped_messages=_optional_int(data, "dropped_messages"),
        integrity=integrity,
        error=_optional_str(data, "error"),
        digest_state=str(digest_state),
        files=files,
        manifest_digest=_optional_str(data, "manifest_digest"),
        imported_from=_optional_str(data, "imported_from"),
        imported_at=_optional_str(data, "imported_at"),
        extra={k: v for k, v in data.items() if k not in _MANIFEST_KNOWN_KEYS},
    )


def record_from_json(data: Mapping[str, Any]) -> RecordV2:
    """Validate a decoded ``record.json``. Raises ``ValueError``."""
    if not isinstance(data, Mapping):
        raise ValueError("record must be a JSON object")
    _check_schema_version(data)

    capture_id = _require_str(data, "capture_id")
    if not is_uuid7(capture_id):
        raise ValueError(f"capture_id must be a UUIDv7: {capture_id!r}")

    revision = data.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        # Revision 0 is spelled "no record.json at all" (§4); a file claiming
        # revision 0 would make the CAS in §4.1 compare against a value that
        # cannot be reached by a legal save.
        raise ValueError(f"revision must be an int >= 1: {revision!r}")

    review_status = data.get("review_status", ReviewStatus.pending.value)
    if review_status not in REVIEW_STATUSES:
        raise ValueError(f"review_status {review_status!r} is not a review status")

    return RecordV2(
        capture_id=capture_id,
        revision=revision,
        review_status=str(review_status),
        task_result=_optional_str(data, "task_result"),
        failure_reason=_optional_str(data, "failure_reason"),
        quality=_optional_str(data, "quality"),
        quality_source=_optional_str(data, "quality_source"),
        batch_id=_optional_str(data, "batch_id"),
        index_in_batch=_optional_int(data, "index_in_batch"),
        updated_at=_optional_str(data, "updated_at"),
        extra={k: v for k, v in data.items() if k not in _RECORD_KNOWN_KEYS},
    )


# -- reading ------------------------------------------------------------------


def _read_sidecar(
    path: Path,
) -> tuple[SidecarStatus, dict[str, Any] | None, str | None]:
    """Load and decode one sidecar, distinguishing absent from unusable."""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return SidecarStatus.missing, None, None
    except OSError as exc:
        # Unreadable is not absent: a permission or I/O error must be surfaced,
        # never rendered as "this capture does not exist".
        return SidecarStatus.corrupt, None, f"unreadable: {exc}"
    if not raw.strip():
        # The signature of a crash between rename and writeback — the exact case
        # §8 rule 4 exists for.
        return SidecarStatus.corrupt, None, f"empty file ({len(raw)} bytes)"
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        return SidecarStatus.corrupt, None, f"invalid JSON: {exc}"
    if not isinstance(data, dict):
        return SidecarStatus.corrupt, None, "not a JSON object"
    return SidecarStatus.ok, data, None


def read_object_manifest(target: str | Path) -> ManifestRead:
    """Read ``object_manifest.json``, given its path or its capture directory."""
    path = _resolve_read(target, OBJECT_MANIFEST_FILENAME)
    status, data, error = _read_sidecar(path)
    if status is not SidecarStatus.ok:
        return ManifestRead(status=status, path=path, error=error)
    try:
        manifest = object_manifest_from_json(data or {})
    except ValueError as exc:
        return ManifestRead(status=SidecarStatus.corrupt, path=path, error=str(exc))
    return ManifestRead(status=SidecarStatus.ok, path=path, manifest=manifest)


def read_record(target: str | Path) -> RecordRead:
    """Read ``record.json``, given its path or its capture directory.

    ``missing`` is the normal state of an unreviewed capture, not a problem.
    """
    path = _resolve_read(target, RECORD_FILENAME)
    status, data, error = _read_sidecar(path)
    if status is not SidecarStatus.ok:
        return RecordRead(status=status, path=path, error=error)
    try:
        record = record_from_json(data or {})
    except ValueError as exc:
        return RecordRead(status=SidecarStatus.corrupt, path=path, error=str(exc))
    return RecordRead(status=SidecarStatus.ok, path=path, record=record)


# -- writing ------------------------------------------------------------------


def write_object_manifest(target: str | Path, manifest: ObjectManifestV2) -> Path:
    """Write *manifest* through the §3.1 atomic write. Returns the path written.

    *target* is the manifest path or the capture directory. Raises ``OSError``:
    §3.4's rule that a failed sidecar write is never swallowed applies to every
    sidecar, not only the failed-start record.
    """
    if Path(target).name.endswith(FAILED_START_SUFFIX):
        # Otherwise this would create objects/<id>.failed.json/ as a DIRECTORY
        # and put the manifest inside it, breaking §3.4's invariant in the very
        # place it is supposed to hold.
        raise ValueError(
            f"{target} is a failed-start path; use write_failed_start() instead"
        )
    path = _resolve_write(target, OBJECT_MANIFEST_FILENAME)
    return atomic_write_json(path, manifest.to_json())


def write_record(target: str | Path, record: RecordV2) -> Path:
    """Write *record* through the §3.1 atomic write, stamping ``updated_at``.

    Step 2 of §4.1: the sidecar is written *before* the database CAS, so a crash
    between them leaves the sidecar ahead — the direction rebuild can resolve,
    because §4.1-4 makes the sidecar authoritative.
    """
    path = _resolve_write(target, RECORD_FILENAME)
    return atomic_write_json(path, record.to_json())


def write_failed_start(data_dir: str | Path, manifest: ObjectManifestV2) -> Path:
    """Write ``objects/<capture_id>.failed.json`` for a start that made no bag.

    Only ``objects/`` is created — never ``objects/<capture_id>/``, which would
    look to every scan like a recording that produced data (§3.4).
    """
    path = failed_start_path(data_dir, manifest.capture_id)
    return atomic_write_json(path, manifest.to_json())
