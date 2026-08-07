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
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from kairos_common.bag_metadata import METADATA_FILENAME
from kairos_common.capture_sidecars import read_object_manifest
from kairos_common.errors import ApiError
from pydantic import BaseModel, Field

from api_orchestrator import bag_import
from api_orchestrator.layout import (
    is_reserved_name,
    reject_unsafe_labels,
    reject_unusable_labels,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/imports", tags=["imports"])


class ImportRequest(BaseModel):
    """Body for ``POST /api/v1/imports``.

    ``source_path`` is a path on the SERVER (these bags are multi-GB; there is
    no browser upload). ``move`` defaults to false — the operator's source data
    is never destroyed unless they ask, and even then only after the import has
    fully succeeded.

    ``operator``/``task``/``robot`` are optional and are written into the bag's
    synthesized manifest as RECORDED facts (§3.3), not as §4.3 overrides: an
    import writes the capture's birth manifest, so naming them here is the same
    act as the recorder stamping a start request. Omitted means the bag comes in
    unlabelled, exactly as before, and Review can label it afterwards.

    A bulk import is this endpoint called once per bag, so "apply to every bag
    in the request" is the client sending the same three values on each call.
    """

    source_path: str = Field(min_length=1)
    move: bool = False
    operator: str | None = None
    task: str | None = None
    robot: str | None = None

    def labels(self) -> bag_import.ImportLabels:
        """The supplied labels, with blank strings read as "not supplied".

        Matches §4.3's review save: a whitespace-only label is not a label, and
        storing one would put an empty attribution on the capture instead of
        leaving it honestly absent.
        """
        return bag_import.ImportLabels(
            **{
                name: value.strip() or None
                for name, value in (
                    ("operator", self.operator or ""),
                    ("task", self.task or ""),
                    ("robot", self.robot or ""),
                )
            }
        )


def _registry(request: Request) -> bag_import.ImportRegistry:
    return request.app.state.import_registry


@router.post("", status_code=202)
async def start_import(request: Request, body: ImportRequest) -> dict[str, Any]:
    """Validate a bag directory and queue its import; 202 with the import id."""
    layout = request.app.state.data_layout

    # Before anything else, including the source inspection: a label that
    # cannot be a folder name must not start a copy it would then have to
    # explain. Nothing has been claimed or written when this raises.
    labels = body.labels()
    reject_unsafe_labels(operator=labels.operator, task=labels.task, robot=labels.robot)
    reject_unusable_labels(
        operator=labels.operator, task=labels.task, robot=labels.robot
    )

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

    # A folder that already FINISHED importing. The scan reports this too, but
    # the scan's answer was computed before the operator started clicking: two
    # browsers that both scanned while the folder was importable race in the
    # window AFTER the first one's copy completes, where
    # `import_already_running` below no longer fires and the scan's verdict is
    # stale. The server has to be the authority for the same reason it owns the
    # episode number (E-7) — the client's picture is always older than the
    # store's.
    #
    # Read from the manifests so it survives a dropped database, at the cost of
    # a walk of objects/. That is the cost `GET /imports/scan` already pays on
    # an interactive path; if a large store ever makes it matter, the answer is
    # an index of `imported_from`, not a client-supplied claim.
    #
    # This await must stay ABOVE the in-flight check: everything from there to
    # the registry `create` below is deliberately await-free, so that two
    # concurrent requests cannot both find nothing and both claim.
    already = await asyncio.to_thread(_imported_sources, layout)
    if str(source) in already:
        raise ApiError(
            status_code=409,
            code="already_imported",
            message=(
                f"{source} is already in Review as capture "
                f"{already[str(source)]}. Importing it again would make a "
                "second copy of the same bag under a second capture id, with "
                "nothing afterwards to tell them apart."
            ),
            details={
                "source_path": str(source),
                "capture_id": already[str(source)],
            },
        )

    # An import already in flight for this exact folder cannot be seen above
    # (that reads finished manifests), so a double click, a second browser, or
    # a re-run of the same bulk selection would copy the same bag twice under
    # two capture ids — indistinguishable afterwards, and paid for twice in
    # disk.
    for existing in _registry(request).list():
        if existing.source_path == str(source) and existing.state == "running":
            raise ApiError(
                status_code=409,
                code="import_already_running",
                message=(
                    f"{source} is already being imported (started "
                    f"{existing.started_at})."
                ),
                details={
                    "source_path": str(source),
                    "capture_id": existing.capture_id,
                },
            )

    capture_id = bag_import.claim_capture_id(layout)
    # Rows AND the imports still in flight: the row for an import that is
    # copying does not exist yet (it is written last, deliberately), so the
    # catalog alone would hand the same name to every bag of a bulk run. No
    # await separates this from the ``create`` below, so a second request
    # cannot slip between the two and see neither.
    run_id = bag_import.allocate_import_run_id(
        taken=bag_import.taken_run_ids(
            request.app.state.capture_store, bag_import.RUN_ID_PREFIX
        )
        | {rec.run_id for rec in _registry(request).list() if rec.state == "running"}
    )
    record = _registry(request).create(
        source_path=str(source),
        capture_id=capture_id,
        run_id=run_id,
        move=body.move,
        bytes_total=bag.bytes,
    )

    task = asyncio.create_task(
        bag_import.run_import(
            bag,
            record,
            layout,
            store=request.app.state.capture_store,
            instance_id=request.app.state.instance_id,
            copy_slots=request.app.state.import_copy_slots,
            labels=labels,
        )
    )
    # Strong refs to in-flight tasks: asyncio only holds weak ones, so without
    # this the GC may cancel a multi-GB copy mid-flight.
    tasks = request.app.state.import_tasks
    tasks.add(task)
    task.add_done_callback(tasks.discard)

    return {
        "queued": True,
        **record.to_dict(),
        "topics": len(bag.topics),
        "message_count": bag.message_count,
    }


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

    candidates, truncated, skipped = await asyncio.to_thread(
        _find_bag_dirs, root, layout
    )
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
        "max_depth": SCAN_DEPTH,
        # Subfolders that are not bags themselves but DO hold bags one level
        # further down. The scan still lists one level only; this is what turns
        # an empty result into a next step instead of a dead end.
        "nested": await asyncio.to_thread(_nested_hints, skipped),
    }


def _nested_hints(skipped: list[Path]) -> list[dict[str, Any]]:
    """`[{path, name, bags}]` for skipped folders that hold bags one level in."""
    hints: list[dict[str, Any]] = []
    for directory in skipped:
        count = _count_bags_inside(directory)
        if count:
            hints.append(
                {"path": str(directory), "name": directory.name, "bags": count}
            )
    return hints


# ONE level, by decision (2026-08-05): the folders directly inside the one the
# operator named. Recursion was tried and withdrawn — "the folder my bags are
# in" is the shape people actually point at, and a walk that wanders into a
# home directory or a NAS root is a surprise nobody asked for. A nested tree is
# imported by naming the subfolder.
SCAN_DEPTH = 1
# Breadth is still capped: a folder with tens of thousands of entries should
# report that the list is short, not silently return part of it.
SCAN_MAX_DIRS = 20_000


def _count_bags_inside(directory: Path) -> int:
    """How many bag directories sit directly inside *directory* (0 on error).

    Used ONLY to hint. The list stays one level deep by decision, but an
    operator who names the parent of a <date>/<session>/ tree must not be left
    staring at an empty result unable to tell "this folder is empty" from "your
    bags are one step further down" — the two look identical and only one is
    worth acting on.
    """
    try:
        children = [c for c in directory.iterdir() if c.is_dir() and not c.is_symlink()]
    except OSError:
        return 0
    count = 0
    for child in children:
        try:
            if (child / METADATA_FILENAME).is_file() or any(child.glob("*.mcap")):
                count += 1
        except OSError:
            continue
    return count


def _find_bag_dirs(root: Path, layout: Any) -> tuple[list[Path], bool, list[Path]]:
    """Bag directories directly inside *root*, the short-list flag, and the
    non-bag folders that were skipped (so the caller can hint about them).

    One level deep (``SCAN_DEPTH``). A directory that is neither a bag nor an
    attempt at one is simply not listed — it is not a failed import, and
    reporting every unrelated subfolder as "no metadata.yaml" buries the
    directories that really are broken.

    Also skipped: kairos's own store subtrees (importing from them is refused
    anyway, and ``objects/`` can hold thousands of directories), hidden
    directories, and symlinks.
    """
    if (root / METADATA_FILENAME).is_file():
        return [root], False, []

    data_root = layout.data_dir.resolve()
    found: list[Path] = []
    skipped: list[Path] = []
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
            if depth + 1 < SCAN_DEPTH:
                queue.append((child, depth + 1))
            else:
                # Not a bag and not descended into: remember it so the caller
                # can hint if it turns out to hold bags one level further down.
                skipped.append(child)
            # Deeper than SCAN_DEPTH is not "truncated": it is the stated
            # policy. Only the breadth cap below shortens a list the operator
            # had reason to expect in full.
        if visited > SCAN_MAX_DIRS:
            truncated = True
            break
    return sorted(found), truncated, sorted(skipped)


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
