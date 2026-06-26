"""Pydantic models for the topic_probe API (OL-3.3).

The public contract consumed by the frontend's Probe tab (same-origin via the
nginx ``/probe/`` proxy). Timestamps are UTC ISO8601; sample timestamps carry
both a wall-clock ISO string and a monotonic-ish float seconds value the chart
plots on its x-axis.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class TopicInfo(BaseModel):
    """One subscribable topic on the ROS 2 graph (the ``/topics`` items)."""

    name: str
    type: str | None = None


class TopicsResponse(BaseModel):
    """Body of ``GET /topics``."""

    ts: str
    topics: list[TopicInfo] = Field(default_factory=list)


class FieldsResponse(BaseModel):
    """Body of ``GET /fields?topic=<name>``.

    ``fields`` are dotted numeric paths (``pose.position.x``, ``data[2]``)
    introspected from a freshly decoded message of the topic. Empty with a
    ``reason`` when no message arrived in time or the type has no numeric leaves.
    """

    ts: str
    topic: str
    type: str | None = None
    fields: list[str] = Field(default_factory=list)
    reason: str | None = None


class Sample(BaseModel):
    """One sampled value of a field (the ``/sample`` body and SSE frames).

    ``t`` is float seconds (wall clock) for the chart x-axis; ``value`` is the
    numeric field value, or ``null`` when the field did not resolve on the most
    recent message (no message yet, or path mismatch).
    """

    topic: str
    field: str
    t: float
    value: float | None = None
