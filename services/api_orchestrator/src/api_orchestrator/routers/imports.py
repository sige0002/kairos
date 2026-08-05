"""Import endpoints (``/api/v1/imports``) — bring an external rosbag in.

A recording made outside kairos — a plain ``ros2 bag record -s mcap``, an
archived experiment, a colleague's bag — becomes a first-class capture: the
orchestrator mints its ``capture_id`` at claim time (§1), stages the copy under
``.incoming/<capture_id>``, writes a v2 ``object_manifest.json`` inside the
staging directory, and moves the whole thing into ``objects/`` with one
``os.replace``.

- ``POST /imports`` validates the source SYNCHRONOUSLY (so a bad path is a
  useful 400 straight away, not a job that fails a minute later) and queues the
  copy, which may be many GB. Returns 202 with an ``import_id``.
- ``GET /imports`` / ``GET /imports/{id}`` report progress. This is job status
  held in memory; the durable outcome is the capture row and the bag on disk.

Ordering guarantee (§2): the capture row appears only after the staged copy has
been atomically moved into ``objects/<capture_id>``, so a capture visible in
Review is one whose bytes are complete.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from kairos_common.bag_metadata import METADATA_FILENAME
from kairos_common.capture_sidecars import read_object_manifest
from kairos_common.errors import ApiError
from kairos_common.rebuild import ReplicaState
from kairos_common.time import utc_now_iso8601
from pydantic import BaseModel, Field

from api_orchestrator import bag_import
from api_orchestrator.layout import is_reserved_name
from api_orchestrator.models import Capture, CaptureState, CaptureTopic
from api_orchestrator.store import CaptureExistsError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/imports", tags=["imports"])

# Strong refs to in-flight import tasks: asyncio only holds weak ones, so
# without this the GC may cancel a multi-GB copy mid-flight.
_import_tasks: set[asyncio.Task[None]] = set()


class ImportRequest(BaseModel):
    """Body for ``POST /api/v1/imports``.

    ``source_path`` is a path on the SERVER (these bags are multi-GB; there is
    no browser upload). ``move`` defaults to false — the operator's source data
    is never destroyed unless they ask, and even then only after the import has
    fully succeeded.
    """

    source_path: str = Field(min_length=1)
    move: bool = False


def _registry(request: Request) -> bag_import.ImportRegistry:
    return request.app.state.import_registry


@router.post("", status_code=202)
async def start_import(request: Request, body: ImportRequest) -> dict[str, Any]:
    """Validate a bag directory and queue its import; 202 with the import id."""
    layout = request.app.state.data_layout

    source = Path(body.source_path).expanduser()
    try:
        source = source.resolve(strict=False)
    except OSError as exc:  # pragma: no cover - exotic FS failure
        raise ApiError(
            status_code=400,
            code="import_source_unresolvable",
            message=f"Could not resolve {body.source_path}: {exc}",
        ) from exc

    # Synchronous validation: cheap (a YAML parse + an MCAP footer read) and it
    # is the difference between "that path has no metadata.yaml, run reindex"
    # now and a mystery failure after a 20-minute copy.
    bag = await asyncio.to_thread(bag_import.inspect_source, source, layout=layout)

    capture_id = bag_import.claim_capture_id(layout)
    run_id = bag_import.allocate_import_run_id()
    record = _registry(request).create(
        source_path=str(source),
        capture_id=capture_id,
        run_id=run_id,
        move=body.move,
        bytes_total=bag.bytes,
    )

    task = asyncio.create_task(_run_import(request, bag, record, layout))
    _import_tasks.add(task)
    task.add_done_callback(_import_tasks.discard)

    return {
        "queued": True,
        **record.to_dict(),
        "topics": len(bag.topics),
        "message_count": bag.message_count,
    }


async def _run_import(
    request: Request,
    bag: bag_import.SourceBag,
    record: bag_import.ImportRecord,
    layout: Any,
) -> None:
    """Copy, describe, move into place, then create the row. Source last."""
    staging = layout.incoming_dir(record.capture_id)
    store = request.app.state.capture_store
    instance_id = request.app.state.instance_id
    try:
        # 1. Copy into staging. Nothing is visible under objects/ yet, so a
        #    crash here leaves no capture that looks complete.
        record.bytes_copied = await asyncio.to_thread(
            bag_import.copy_into_staging, bag, staging
        )

        # 2. The manifest goes INSIDE staging so it arrives with the rename
        #    rather than appearing a moment later.
        await asyncio.to_thread(
            bag_import.write_manifest,
            staging,
            bag_import.import_manifest(
                bag, record.capture_id, record.run_id, instance_id=instance_id
            ),
        )

        # 3. The atomic instant: the capture becomes real here and not before.
        await asyncio.to_thread(bag_import.finalize, layout, record.capture_id)

        # 4. Row last. A row without its bytes would be a capture every other
        #    path (reconciler, retention, digest) has to special-case.
        _create_capture_row(store, record, bag, instance_id, layout)

        # 5. Only now may the source go, and only if asked — and only the files
        #    that were actually imported. The copy takes top-level FILES only,
        #    so a recursive delete here would destroy an operator's `notes/` or
        #    `videos/` sitting beside the bag: data that was never imported and
        #    would then exist nowhere.
        if record.move:
            await asyncio.to_thread(bag_import.remove_moved_source, bag)

        record.state = "succeeded"
        record.finished_at = utc_now_iso8601()
        logger.info(
            "bag imported",
            extra={"capture_id": record.capture_id, "source": record.source_path},
        )
    except Exception as exc:  # noqa: BLE001 - any failure must land in the record
        # Clean up BEFORE publishing the terminal state: a caller polling until
        # "failed" is entitled to find nothing half-imported at that moment.
        await asyncio.to_thread(shutil.rmtree, staging, True)
        record.state = "failed"
        record.finished_at = utc_now_iso8601()
        if isinstance(exc, ApiError):
            record.error_code, record.error_message = exc.code, exc.message
        else:
            record.error_code = "import_failed"
            record.error_message = str(exc) or exc.__class__.__name__
        logger.warning(
            "bag import failed",
            extra={
                "capture_id": record.capture_id,
                "source": record.source_path,
                "error": record.error_code,
            },
        )


def _create_capture_row(
    store: Any,
    record: bag_import.ImportRecord,
    bag: bag_import.SourceBag,
    instance_id: str,
    layout: Any,
) -> None:
    """Insert the imported bag as a completed capture with a present replica.

    ``completed`` is the honest state: the recording is over and its bag is
    whole. ``operator``/``task`` stay null — the two things an external bag
    cannot tell us, filled in from Review rather than invented here.
    """
    capture = Capture(
        capture_id=record.capture_id,
        run_id=record.run_id,
        source_instance_id=instance_id,
        state=CaptureState.completed,
        started_at=bag.started_at,
        ended_at=bag.ended_at,
        topics=[CaptureTopic(name=name, type=type_) for name, type_ in bag.topics],
        message_count=bag.message_count,
        bytes=bag.bytes,
    )
    try:
        store.create_capture(capture)
    except CaptureExistsError:  # pragma: no cover - the id was just minted
        pass
    store.upsert_replica(
        record.capture_id,
        instance_id,
        # Present but UNVERIFIED: the copy was verified file-by-file on the way
        # in, but §9-4 reserves present_verified for a sealed manifest, and the
        # digest job has not run yet.
        ReplicaState.present_unverified,
        path=str(layout.capture_dir(record.capture_id)),
    )


@router.get("/scan")
async def scan_folder(request: Request, path: str) -> dict[str, Any]:
    """List the bag directories under *path*, with why each can or cannot come in.

    The point is that nothing is copied to find this out. An operator pointing
    at a folder of 40 recordings gets one screen saying exactly which ones will
    import, which are already here, and which need `ros2 bag reindex` — before
    a single gigabyte moves. Without it the only way to learn that the 12th bag
    has no metadata.yaml is to wait for the 12th copy to fail.

    Scanned shallowly on purpose: *path* itself if it is a bag, otherwise its
    immediate children. A recursive walk over an operator-supplied path is an
    unbounded filesystem crawl, and "the folder my bags are in" is always one
    level in practice.
    """
    layout = request.app.state.data_layout
    root = Path(path).expanduser()
    try:
        root = root.resolve(strict=False)
    except OSError as exc:  # pragma: no cover - exotic FS failure
        raise ApiError(
            status_code=400,
            code="import_source_unresolvable",
            message=f"Could not resolve {path}: {exc}",
        ) from exc
    if not root.exists():
        raise ApiError(
            status_code=400,
            code="import_source_missing",
            message=(
                f"Nothing exists at {root}. Give the folder as the SERVER sees "
                "it (not your laptop's path)."
            ),
            details={"source_path": str(root)},
        )
    if not root.is_dir():
        raise ApiError(
            status_code=400,
            code="import_source_not_a_directory",
            message=f"{root} is a file, not a folder of rosbag directories.",
            details={"source_path": str(root)},
        )

    candidates, truncated = await asyncio.to_thread(_find_bag_dirs, root, layout)
    already = await asyncio.to_thread(_imported_sources, layout)

    entries: list[dict[str, Any]] = []
    for candidate in candidates:
        # Nested bags are named by their path RELATIVE to the scanned folder:
        # in a tree of <date>/<session>/ the leaf names repeat, and a list of
        # six identical "session1" rows identifies nothing.
        try:
            label = str(candidate.relative_to(root))
        except ValueError:
            label = candidate.name
        entry: dict[str, Any] = {"path": str(candidate), "name": label}
        if str(candidate) in already:
            # Importing it again would make a second copy of the same bag under
            # a second capture_id — indistinguishable afterwards.
            entry.update(
                importable=False,
                reason_code="already_imported",
                reason="Already imported — it is in Review.",
                capture_id=already[str(candidate)],
            )
            entries.append(entry)
            continue
        try:
            bag = await asyncio.to_thread(
                bag_import.inspect_source, candidate, layout=layout
            )
        except ApiError as exc:
            # A rejected directory is REPORTED, never skipped silently: the
            # operator needs to know the folder held something that will not
            # come in, and what to do about it.
            entry.update(
                importable=False,
                reason_code=exc.code,
                reason=exc.message,
                remedy=(exc.details or {}).get("remedy"),
            )
            entries.append(entry)
            continue
        entry.update(
            importable=True,
            bytes=bag.bytes,
            topics=len(bag.topics),
            message_count=bag.message_count,
            duration_s=bag.duration_s,
            started_at=bag.started_at,
        )
        entries.append(entry)

    return {
        "path": str(root),
        "bags": entries,
        "importable": sum(1 for e in entries if e.get("importable")),
        # Said out loud rather than silently returning a short list: a scan
        # that stopped early and looks complete is how a folder gets
        # half-imported and nobody notices the rest.
        "truncated": truncated,
        "max_depth": SCAN_MAX_DEPTH,
    }


# Bounds on the recursive scan. An operator-supplied path is arbitrary — it can
# be a home directory or a NAS root — so the walk is bounded in both depth and
# breadth, and says when it hit a bound instead of quietly returning less.
SCAN_MAX_DEPTH = 5
SCAN_MAX_DIRS = 20_000


def _find_bag_dirs(root: Path, layout: Any) -> tuple[list[Path], bool]:
    """Bag directories at or under *root*, plus whether the walk was cut short.

    Recursive so a tree like ``incoming/<date>/<session>/`` works — pointing at
    the parent and getting nothing (or, worse, the intermediate folders
    reported as broken bags) is the shape operators actually have.

    What it does NOT do is walk forever:

    * a directory that IS a bag is not descended into — its ``.mcap`` files are
      its contents, not more candidates;
    * kairos's own store subtrees are skipped entirely (importing from them is
      refused anyway, and ``objects/`` can hold thousands of directories);
    * hidden directories and symlinks are skipped — the first is where tools
      keep their caches, the second is how a walk finds a cycle;
    * depth and total directories are capped, and hitting a cap is REPORTED.
    """
    if (root / METADATA_FILENAME).is_file():
        return [root], False

    data_root = layout.data_dir.resolve()
    found: list[Path] = []
    visited = 0
    truncated = False
    queue: list[tuple[Path, int]] = [(root, 0)]
    while queue:
        directory, depth = queue.pop(0)
        try:
            children = sorted(
                c
                for c in directory.iterdir()
                if c.is_dir() and not c.is_symlink() and not c.name.startswith(".")
            )
        except OSError:
            continue  # unreadable dir: skip it, never fail the whole scan
        for child in children:
            visited += 1
            if visited > SCAN_MAX_DIRS:
                truncated = True
                break
            # Never descend into the store itself.
            try:
                relative = child.resolve().relative_to(data_root)
            except (OSError, ValueError):
                pass
            else:
                if relative.parts and is_reserved_name(relative.parts[0]):
                    continue
            if (child / METADATA_FILENAME).is_file() or list(child.glob("*.mcap")):
                # A bag, or something trying to be one (an .mcap with no
                # metadata.yaml is exactly the case worth reporting).
                found.append(child)
                continue
            if depth + 1 < SCAN_MAX_DEPTH:
                queue.append((child, depth + 1))
            else:
                truncated = True
        if visited > SCAN_MAX_DIRS:
            truncated = True
            break
    return sorted(found), truncated


def _imported_sources(layout: Any) -> dict[str, str]:
    """``imported_from`` → capture_id for every capture already imported here.

    Read from the manifests rather than the index: the manifest is what the §8
    rebuild restores from, so this answer survives a dropped database exactly
    like the captures themselves do.
    """
    found: dict[str, str] = {}
    objects = layout.data_dir / "objects"
    if not objects.is_dir():
        return found
    for capture_dir in objects.iterdir():
        if not capture_dir.is_dir():
            continue
        result = read_object_manifest(capture_dir)
        manifest = result.manifest
        if manifest is not None and manifest.imported_from:
            found[manifest.imported_from] = manifest.capture_id
    return found


@router.get("")
async def list_imports(request: Request) -> dict[str, Any]:
    """Every import this process has run (newest last)."""
    return {"imports": [rec.to_dict() for rec in _registry(request).list()]}


@router.get("/{import_id}")
async def get_import(request: Request, import_id: str) -> dict[str, Any]:
    """One import's status."""
    return _registry(request).get(import_id).to_dict()
