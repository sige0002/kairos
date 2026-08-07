"""Row ↔ model conversion for the capture store.

Pure functions split out of ``store.py``: each one renders a model into its
column mapping or rebuilds a model from a ``sqlite3.Row``. ``CaptureStore``
binds them as class attributes (``_capture_from_row = staticmethod(...)``) so
call sites — and class-level patches — keep addressing them through the class.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from kairos_common import Compression, JobState
from kairos_common.rebuild import ReplicaState

from api_orchestrator.models import (
    Batch,
    Capture,
    CaptureState,
    CaptureTopic,
    DatasetMember,
    JobStatus,
    QuickCheck,
    Replica,
    Split,
    ValidationTemplate,
    coerce_error,
)
from api_orchestrator.schema import JSON_COLUMNS


def encode_field(name: str, value: Any) -> Any:
    """Encode one model-level field into its column representation."""
    if name == "topics":
        return json.dumps(
            [
                t.model_dump() if isinstance(t, CaptureTopic) else t
                for t in (value or [])
            ]
        )
    if name in JSON_COLUMNS:
        if value is None:
            return None
        if hasattr(value, "model_dump"):
            return json.dumps(value.model_dump(mode="json"))
        return json.dumps(value)
    if name in {"state", "compression", "review_status"}:
        return None if value is None else str(getattr(value, "value", value))
    return value


def capture_columns(capture: Capture) -> dict[str, Any]:
    """Render a full :class:`Capture` into its INSERT column mapping."""
    return {
        "capture_id": capture.capture_id,
        "run_id": capture.run_id,
        "source_instance_id": capture.source_instance_id,
        "state": str(capture.state),
        "operator": capture.operator,
        "task": capture.task,
        "robot": capture.robot,
        "started_at": capture.started_at,
        "ended_at": capture.ended_at,
        "topics": encode_field("topics", capture.topics),
        "compression": str(capture.compression),
        "split": encode_field("split", capture.split),
        "error": encode_field("error", capture.error),
        "message_count": capture.message_count,
        "bytes": capture.bytes,
        "quick_check": encode_field("quick_check", capture.quick_check),
        "task_result": capture.task_result,
        "failure_reason": capture.failure_reason,
        "quality": capture.quality,
        "quality_source": capture.quality_source,
        "review_status": capture.review_status,
        "review_revision": capture.review_revision,
        "batch_id": capture.batch_id,
        "index_in_batch": capture.index_in_batch,
        "deleted_at": capture.deleted_at,
        "delete_kind": capture.delete_kind,
        "delete_reason": capture.delete_reason,
        "archived_at": capture.archived_at,
        "archive_destination": capture.archive_destination,
        "created_at": capture.created_at,
        "updated_at": capture.updated_at,
    }


def _optional_column(row: sqlite3.Row, name: str) -> Any:
    """A column that only some of the capture SELECTs project."""
    return row[name] if name in row.keys() else None


def capture_from_row(row: sqlite3.Row) -> Capture:
    topics_raw = json.loads(row["topics"]) if row["topics"] else []
    split_raw = json.loads(row["split"]) if row["split"] else None
    error_raw = json.loads(row["error"]) if row["error"] else None
    qc_raw = json.loads(row["quick_check"]) if row["quick_check"] else None
    return Capture(
        capture_id=row["capture_id"],
        run_id=row["run_id"],
        source_instance_id=row["source_instance_id"],
        state=CaptureState(row["state"]),
        operator=row["operator"],
        task=row["task"],
        robot=row["robot"],
        started_at=row["started_at"],
        ended_at=row["ended_at"],
        topics=[CaptureTopic.model_validate(t) for t in topics_raw],
        compression=Compression(row["compression"]),
        split=Split.model_validate(split_raw) if split_raw else None,
        error=coerce_error(error_raw),
        message_count=row["message_count"],
        bytes=row["bytes"],
        quick_check=QuickCheck.model_validate(qc_raw) if qc_raw else None,
        task_result=row["task_result"],
        failure_reason=row["failure_reason"],
        quality=row["quality"],
        quality_source=row["quality_source"],
        review_status=row["review_status"],
        review_revision=row["review_revision"],
        validation_override=row["validation_override"],
        batch_id=row["batch_id"],
        index_in_batch=row["index_in_batch"],
        deleted_at=row["deleted_at"],
        delete_kind=row["delete_kind"],
        delete_reason=row["delete_reason"],
        archived_at=row["archived_at"],
        archive_destination=row["archive_destination"],
        # Present when the row came from ``captures_with_lease`` (every path
        # that serves a capture to a client); absent on a raw ``captures`` row.
        lease_owner=_optional_column(row, "lease_owner"),
        lease_expires_at=_optional_column(row, "lease_expires_at"),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def replica_from_row(row: sqlite3.Row) -> Replica:
    return Replica(
        instance_id=row["instance_id"],
        state=ReplicaState(row["state"]),
        path=row["path"],
        manifest_digest=row["manifest_digest"],
        verified_at=row["verified_at"],
        updated_at=row["updated_at"],
    )


def member_from_row(row: sqlite3.Row) -> DatasetMember:
    return DatasetMember(
        membership_id=row["membership_id"],
        dataset_id=row["dataset_id"],
        capture_id=row["capture_id"],
        display_index=row["display_index"],
        created_at=row["created_at"],
    )


def job_from_row(row: sqlite3.Row) -> JobStatus:
    return JobStatus(
        job_id=row["job_id"],
        capture_id=row["capture_id"],
        pipeline=row["pipeline"],
        state=JobState(row["state"]),
        progress=float(row["progress"]),
        logs_tail=json.loads(row["logs_tail"]) if row["logs_tail"] else [],
    )


def template_from_row(row: sqlite3.Row) -> ValidationTemplate:
    return ValidationTemplate(
        name=row["name"],
        version=row["version"],
        required_topics=(
            json.loads(row["required_topics"]) if row["required_topics"] else []
        ),
    )


def batch_from_row(row: sqlite3.Row) -> Batch:
    return Batch(
        batch_id=row["batch_id"],
        robot=row["robot"],
        project=row["project"],
        task=row["task"],
        condition=row["condition"],
        operator=row["operator"],
        target_episodes=row["target_episodes"],
        status=row["status"],
        ended_reason=row["ended_reason"],
        created_at=row["created_at"],
        ended_at=row["ended_at"],
        episodes_recorded=row["episodes_recorded"],
        episodes_recorded_is_floor=bool(row["episodes_recorded_is_floor"]),
        batch_seq=row["batch_seq"],
    )
