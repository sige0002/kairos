# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Strict pipeline parameter validation at the HTTP admission boundary."""

from __future__ import annotations

from pathlib import Path

import pytest
from dora_runner.main import create_dora_app
from dora_runner.params_validation import validate_pipeline_params
from dora_runner.registry import (
    PipelineRegistry,
    RegisteredPipeline,
    build_default_registry,
)
from dora_runner.store import JobRecord, RunnerStore
from fastapi.testclient import TestClient
from kairos_common import ApiError, Settings
from kairos_common.ids import new_capture_id


async def _runner(_: JobRecord, __: RunnerStore, ___: Path) -> dict:
    return {"summary": {"result": "pass"}, "artifacts": []}


SCHEMA = {
    "type": "object",
    "properties": {
        "limit": {"type": "integer", "minimum": 1, "default": 5},
        "force": {"type": "boolean", "default": False},
    },
    "additionalProperties": False,
}


@pytest.mark.parametrize("invalid", [True, "3", 3.0])
def test_integer_params_are_not_coerced(invalid: object) -> None:
    with pytest.raises(ApiError) as raised:
        validate_pipeline_params("strict", SCHEMA, {"limit": invalid})

    assert raised.value.status_code == 400
    assert raised.value.code == "invalid_pipeline_params"
    assert raised.value.details["pipeline"] == "strict"
    assert raised.value.details["path"] == ["limit"]


@pytest.mark.parametrize("invalid", [0, 1, "false"])
def test_boolean_params_are_not_coerced(invalid: object) -> None:
    with pytest.raises(ApiError) as raised:
        validate_pipeline_params("strict", SCHEMA, {"force": invalid})

    assert raised.value.code == "invalid_pipeline_params"
    assert raised.value.details["path"] == ["force"]


def test_schema_defaults_are_applied_without_mutating_the_request() -> None:
    supplied: dict[str, object] = {}

    validated = validate_pipeline_params("strict", SCHEMA, supplied)

    assert validated == {"limit": 5, "force": False}
    assert supplied == {}


def test_fast_validation_accepts_the_resolved_template_contract() -> None:
    pipeline = build_default_registry(discover=False).get("fast_validation")
    assert pipeline is not None
    resolved = {
        "name": "test_robot",
        "version": 1,
        "required_topics": [
            {"name": "/joint_states", "type": "sensor_msgs/msg/JointState"},
            {"name": "/tf", "type": None},
        ],
    }

    validated = validate_pipeline_params(
        pipeline.id, pipeline.params_schema, {"template": resolved}
    )

    assert validated == {"template": resolved}


@pytest.mark.parametrize(
    "template",
    [
        {},
        {"name": "test_robot", "version": 1.0},
        {"name": "test_robot", "version": 1, "unknown": True},
        {
            "name": "test_robot",
            "version": 1,
            "required_topics": [{"name": "/tf", "unknown": True}],
        },
    ],
)
def test_fast_validation_rejects_malformed_resolved_templates(
    template: object,
) -> None:
    pipeline = build_default_registry(discover=False).get("fast_validation")
    assert pipeline is not None

    with pytest.raises(ApiError) as raised:
        validate_pipeline_params(
            pipeline.id, pipeline.params_schema, {"template": template}
        )

    assert raised.value.code == "invalid_pipeline_params"
    assert raised.value.details["path"] == ["template"]


def test_full_validation_accepts_the_orchestrator_resolved_template() -> None:
    pipeline = build_default_registry(discover=False).get("full_validation")
    assert pipeline is not None
    resolved = {
        "name": "test_robot",
        "version": 1,
        "required_topics": [{"name": "/joint_states", "type": None}],
    }

    validated = validate_pipeline_params(
        pipeline.id,
        pipeline.params_schema,
        {"flow": "default", "template": resolved},
    )

    assert validated["template"] == resolved


def _strict_registry() -> PipelineRegistry:
    registry = PipelineRegistry()
    registry.register(
        RegisteredPipeline(
            id="strict",
            name="Strict",
            description="",
            params_schema=SCHEMA,
            runner=_runner,
        )
    )
    return registry


def test_create_job_rejects_invalid_params_before_persisting(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr("dora_runner.main.DEFAULT_REGISTRY", _strict_registry())
    store = RunnerStore()
    app = create_dora_app(Settings(data_dir=str(tmp_path)), store=store)

    with TestClient(app) as client:
        response = client.post(
            "/jobs",
            json={
                "capture_id": new_capture_id(),
                "pipeline": "strict",
                "params": {"limit": True},
            },
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_pipeline_params"
    assert response.json()["error"]["details"]["path"] == ["limit"]
    assert store.jobs == {}


def test_create_job_persists_materialized_defaults(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr("dora_runner.main.DEFAULT_REGISTRY", _strict_registry())
    store = RunnerStore()
    app = create_dora_app(Settings(data_dir=str(tmp_path)), store=store)

    with TestClient(app) as client:
        response = client.post(
            "/jobs",
            json={
                "capture_id": new_capture_id(),
                "pipeline": "strict",
                "params": {},
            },
        )

    assert response.status_code == 201
    job = store.jobs[response.json()["job_id"]]
    assert job.params == {"limit": 5, "force": False}


def test_idempotent_retry_matches_a_job_persisted_before_defaults(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr("dora_runner.main.DEFAULT_REGISTRY", _strict_registry())
    store = RunnerStore()
    capture_id = new_capture_id()
    legacy = JobRecord(
        job_id="job_before_schema_defaults",
        capture_id=capture_id,
        pipeline="strict",
        params={},
        idempotency_key="stable-request",
    )
    store.jobs[legacy.job_id] = legacy
    store.persist_job(legacy)
    app = create_dora_app(Settings(data_dir=str(tmp_path)), store=store)

    with TestClient(app) as client:
        same = client.post(
            "/jobs",
            json={
                "capture_id": capture_id,
                "pipeline": "strict",
                "params": {},
                "idempotency_key": "stable-request",
            },
        )
        changed = client.post(
            "/jobs",
            json={
                "capture_id": capture_id,
                "pipeline": "strict",
                "params": {"limit": 6},
                "idempotency_key": "stable-request",
            },
        )

    assert same.status_code == 201
    assert same.json()["job_id"] == legacy.job_id
    assert changed.status_code == 409
    assert changed.json()["error"]["code"] == "idempotency_conflict"


def test_idempotency_identity_conflict_precedes_current_schema_validation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr("dora_runner.main.DEFAULT_REGISTRY", _strict_registry())
    store = RunnerStore()
    legacy = JobRecord(
        job_id="job_for_another_pipeline",
        capture_id=new_capture_id(),
        pipeline="retired_pipeline",
        params={"retired_option": "value"},
        idempotency_key="reused-request",
    )
    store.jobs[legacy.job_id] = legacy
    store.persist_job(legacy)
    app = create_dora_app(Settings(data_dir=str(tmp_path)), store=store)

    with TestClient(app) as client:
        response = client.post(
            "/jobs",
            json={
                "capture_id": new_capture_id(),
                "pipeline": "strict",
                "params": {},
                "idempotency_key": "reused-request",
            },
        )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "idempotency_conflict"
