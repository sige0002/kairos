# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Reconciling the store at boot: captures a previous process left mid-flight.

Split out of :mod:`rosbag2_recorder.recorder` unchanged. Everything here runs
once, before the service accepts requests, and only ever touches directories
under ``objects/`` that this recorder itself could have abandoned.

The functions take the live :class:`~rosbag2_recorder.recorder.RecorderSession`
and call back through it (``session._recover_capture`` and friends) rather than
calling each other directly, so the dispatch is the same one the methods had
before the split. What the recorder still holds itself — the clock and the log
path — is passed in by those thin methods rather than imported from
:mod:`rosbag2_recorder.recorder`, which keeps the dependency one-way and keeps
the clock substitutable in the recorder's own namespace.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from kairos_common.capture_sidecars import (
    ROSBAG2_METADATA_FILENAME,
    UNFINALIZED_STATES,
    CaptureState,
    DigestState,
    ObjectManifestV2,
    SidecarStatus,
    read_object_manifest,
    write_object_manifest,
)
from kairos_common.ids import is_uuid7
from kairos_common.rebuild import has_bag
from kairos_common.record_meta import UNKNOWN_OPERATOR, UNKNOWN_TASK
from kairos_common.time import utc_iso8601_of

if TYPE_CHECKING:
    from rosbag2_recorder.recorder import RecorderSession

# Deliberately the same logger the recorder itself uses: recovery lines are the
# recorder's voice at boot, and splitting the module must not split the log
# stream an operator greps after a crash.
logger = logging.getLogger("kairos.rosbag2_recorder")


def reconcile_on_startup(session: RecorderSession) -> None:
    """Finalise captures a previous process left mid-flight.

    Scans ``objects/`` for manifests still in ``recording``/``stopping`` —
    the only states this process would still own had it not died — and
    rewrites them so the audit trail reflects the crash/restart. The new
    state comes from the same discriminator finalise and the rebuild use:
    a capture with a bag is ``interrupted``, one without ever produced
    nothing and is ``failed``.

    Directories with **no manifest at all** are reclaimed here too (see
    :func:`adopt_manifestless_capture`). They can only be this recorder's
    own abandoned arm or start — imports land atomically from
    ``.incoming/`` — and leaving them would break §2's invariant that an
    incomplete directory under ``objects/`` means a live capture, which is
    exactly what makes the orchestrator's scan trustworthy.

    Every other manifest is left strictly alone (§3.3). Once a capture is
    terminal the orchestrator's digest job is its sole writer, and a
    rewrite from here would race — or silently undo — the single atomic
    write that seals ``files``/``manifest_digest``. A corrupt manifest is
    reported and left as it is, never repaired (§8 rule 4).
    """
    root = session._objects_root()
    try:
        children = sorted(root.iterdir())
    except FileNotFoundError:
        return
    except OSError:
        logger.exception("could not scan %s for interrupted captures", root)
        return

    for child in children:
        # Nothing kairos writes under objects/ is a symlink, and following
        # one would let a planted link redirect a manifest rewrite outside
        # the store entirely.
        if child.is_symlink() or not child.is_dir():
            continue
        capture_id = child.name
        if not is_uuid7(capture_id):
            continue
        session._recover_capture(child, capture_id)


def recover_capture(
    session: RecorderSession,
    path: Path,
    capture_id: str,
    *,
    now: Callable[[], str],
) -> None:
    """Rewrite one crashed capture's manifest, if it is ours to rewrite."""
    read = read_object_manifest(path)
    if read.status is SidecarStatus.corrupt:
        logger.error(
            "capture manifest is unreadable; leaving it untouched",
            extra={
                "capture_id": capture_id,
                "error": read.error,
                "component": "recorder",
            },
        )
        return
    if read.status is SidecarStatus.missing:
        session._adopt_manifestless_capture(path, capture_id)
        return
    manifest = read.manifest
    if manifest is None or manifest.state not in UNFINALIZED_STATES:
        return
    if manifest.capture_id != capture_id:
        # The manifest names a different capture than the directory it sits
        # in. Rewriting it would stamp this directory's id onto whatever
        # that other capture actually is.
        logger.error(
            "capture manifest names another capture; leaving it untouched",
            extra={
                "capture_id": capture_id,
                "manifest_capture_id": manifest.capture_id,
                "component": "recorder",
            },
        )
        return

    recovered_state = (
        CaptureState.interrupted.value if has_bag(path) else CaptureState.failed.value
    )
    # Siblings first: the manifest write is the handoff (§3.3), and adding
    # recorder.log to the directory afterwards would leave the digest job's
    # sealed file list describing a directory that no longer matches.
    session._archive_log(capture_id)
    session._cleanup_qos_file(capture_id)
    session._cleanup_storage_config(capture_id)
    # Re-measure rather than carrying the last manifest's numbers forward.
    # Those were written at start, before the recording ran; a crash after
    # an hour would otherwise be filed as the few kilobytes that existed in
    # its first second, and the drop count the process reported on its way
    # down would never be read at all.
    meta = session._read_rosbag2_metadata(capture_id)
    recovered = replace(
        manifest,
        state=recovered_state,
        ended_at=manifest.ended_at or now(),
        error=(
            manifest.error
            or f"recorder restarted while the capture was {manifest.state}"
        ),
        message_count=(
            session._message_count(meta) if meta is not None else manifest.message_count
        ),
        bytes=session._recorded_bytes(capture_id),
        dropped_messages=session._scan_dropped_messages(capture_id),
        integrity="failed",
        digest_state=DigestState.pending.value,
        files=None,
        manifest_digest=None,
    )
    try:
        write_object_manifest(path, recovered)
    except OSError:
        logger.exception(
            "could not rewrite the interrupted capture's manifest",
            extra={"capture_id": capture_id, "component": "recorder"},
        )
        return
    session._make_host_writable(path)
    logger.info(
        "recovered a capture left mid-flight",
        extra={
            "capture_id": capture_id,
            "run_id": manifest.run_id,
            "state": recovered_state,
            "component": "recorder",
        },
    )


def adopt_manifestless_capture(
    session: RecorderSession,
    path: Path,
    capture_id: str,
    *,
    log_path: Path,
) -> None:
    """Reclaim an ``objects/<id>/`` that has no manifest at all.

    Such a directory can only be this recorder's own abandoned work: an arm
    or a start that died between ``ros2 bag record`` creating its output
    directory and the first manifest write. Imports never produce one —
    they are completed under ``.incoming/`` and moved in with a single
    ``os.replace`` (§2) — so there is no third party whose directory this
    could be, and leaving it in place would break the invariant that an
    incomplete directory under ``objects/`` means a *live* capture.

    Whether it is worth keeping is decided by the same discriminator as
    everywhere else. Bytes on disk become an ``interrupted`` capture with a
    synthesized manifest, because throwing away a recording just for
    missing its sidecar is not a call this function gets to make. Nothing on
    disk is deleted outright: a crash while armed is materially a disarm,
    and a disarm writes no failure record.
    """
    if session._holds_recorded_data(path):
        session._synthesize_manifest(path, capture_id)
        return
    # No bag: remove the directory and the siblings that only made sense
    # while it was being spawned into.
    removed = session._remove_capture_dir(capture_id)
    session._cleanup_qos_file(capture_id)
    session._cleanup_storage_config(capture_id)
    log_path.unlink(missing_ok=True)
    if removed:
        # Only when it is genuinely gone: _remove_capture_dir has already
        # warned about residue, and announcing a removal on top of that
        # would leave two log lines flatly contradicting each other for
        # whoever reads them during an incident.
        logger.warning(
            "removed an empty capture directory left by a crash while armed "
            "or starting; no bag was ever written, so there is nothing to "
            "recover",
            extra={"capture_id": capture_id, "component": "recorder"},
        )


def synthesize_manifest(
    session: RecorderSession,
    path: Path,
    capture_id: str,
    *,
    now: Callable[[], str],
) -> None:
    """Write an ``interrupted`` manifest for a capture that never got one.

    Every field is best-effort: the operator, task and topic selection died
    with the process that knew them. What can be measured is measured, and
    what cannot falls back to the same shared ``unknown_*`` placeholders a
    live start uses (:mod:`kairos_common.record_meta`) — deliberately NOT
    null. Null operator/task is §3.3's import-only spelling, which
    ``bag_import`` sets to say "this capture came from somewhere else"; a
    recovered capture was recorded right here, and borrowing the import
    spelling would misfile its origin. ``unknown_*`` fabricates nothing: it
    is the same honest "we don't know" the live path already writes when a
    standalone start names no operator.

    The ``run_id`` is synthesized from the directory's mtime because the
    manifest requires one and it is a display name only (§1) — no key, no
    path, nothing that a collision could corrupt.
    """
    stamp = session._directory_timestamp(path)
    session._archive_log(capture_id)
    session._cleanup_qos_file(capture_id)
    session._cleanup_storage_config(capture_id)
    meta = session._read_rosbag2_metadata(capture_id)
    manifest = ObjectManifestV2(
        capture_id=capture_id,
        source_instance_id=session._instance_id,
        run_id="run_recovered_" + stamp.strftime("%Y%m%d_%H%M%S"),
        state=CaptureState.interrupted.value,
        started_at=utc_iso8601_of(stamp),
        ended_at=now(),
        operator=UNKNOWN_OPERATOR,
        task=UNKNOWN_TASK,
        robot=session._configured_robot(),
        topics=tuple(
            {"name": name, "type": type_, "qos": None}
            for name, type_ in session._metadata_topics(meta)
        ),
        message_count=session._message_count(meta) if meta is not None else None,
        bytes=session._recorded_bytes(capture_id),
        dropped_messages=session._scan_dropped_messages(capture_id),
        integrity="failed",
        error=(
            "recovered from bytes on disk: the recorder died before it wrote "
            "a manifest, so operator, task and settings are unknown"
        ),
        digest_state=DigestState.pending.value,
    )
    try:
        write_object_manifest(path, manifest)
    except OSError:
        logger.exception(
            "could not synthesize a manifest for an orphaned capture",
            extra={"capture_id": capture_id, "component": "recorder"},
        )
        return
    session._make_host_writable(path)
    logger.warning(
        "adopted a capture directory that had no manifest; it holds a bag, "
        "so it was recovered as interrupted with synthesized metadata",
        extra={
            "capture_id": capture_id,
            "run_id": manifest.run_id,
            "component": "recorder",
        },
    )


def holds_recorded_data(path: Path) -> bool:
    """Whether a manifest-less directory is worth keeping: real bytes or none.

    Stricter than :func:`has_bag` on purpose, and only for this decision.
    ``has_bag`` answers "is there a bag here" for a capture that already has
    a manifest, where a row exists either way and agreeing with the
    rebuild's spelling is what matters (§8 rule 2). Here the question is
    whether to *invent* a capture, and the difference is a single file: a
    paused ``ros2 bag record`` creates its storage file the moment it
    starts, so a crash while armed leaves a 0-byte ``.mcap`` and nothing
    else. Counting that as a recording would publish an empty capture with
    fabricated metadata for an operator to puzzle over, when the honest
    reading is that the arm was cancelled by the crash.
    """
    if (path / ROSBAG2_METADATA_FILENAME).is_file():
        return True
    try:
        return any(mcap.stat().st_size > 0 for mcap in path.glob("*.mcap"))
    except OSError:
        return False


def directory_timestamp(path: Path) -> datetime:
    """The capture directory's mtime — when its last bytes were written."""
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
    except OSError:
        return datetime.now(UTC)


def metadata_topics(meta: dict[str, Any] | None) -> list[tuple[str, str | None]]:
    """``(name, type)`` for every topic rosbag2 recorded, or an empty list."""
    if meta is None:
        return []
    topics: list[tuple[str, str | None]] = []
    for item in meta.get("topics_with_message_count") or []:
        tmeta = (item or {}).get("topic_metadata") or {}
        name = tmeta.get("name")
        if name:
            topics.append((name, tmeta.get("type")))
    return topics
