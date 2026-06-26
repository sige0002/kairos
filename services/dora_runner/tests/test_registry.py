"""Pipeline registry (OL-④): metadata + runnable dispatch, no if/elif."""

from __future__ import annotations

from dora_runner.registry import (
    DEFAULT_REGISTRY,
    PipelineRegistry,
    RegisteredPipeline,
    build_default_registry,
)


def test_default_registry_has_runnable_and_placeholders() -> None:
    reg = build_default_registry()
    ids = {p.id for p in reg.all()}
    assert {"fast_validation", "dataset_export", "loss_report", "video_check"} <= ids
    # The four implemented pipelines are runnable; placeholders are not.
    for pid in ("fast_validation", "dataset_export", "loss_report", "video_check"):
        assert reg.runnable(pid), pid
    for pid in ("full_validation", "dataset_convert", "dataset_validation"):
        assert not reg.runnable(pid), pid
        assert reg.get(pid) is not None and reg.get(pid).enabled is False


def test_runnable_unknown_pipeline_is_false() -> None:
    assert DEFAULT_REGISTRY.runnable("does_not_exist") is False
    assert DEFAULT_REGISTRY.get("does_not_exist") is None


def test_metadata_carries_schema_outputs_executor() -> None:
    fv = DEFAULT_REGISTRY.get("fast_validation")
    assert fv is not None
    assert fv.params_schema["required"] == ["template"]
    assert fv.executor == "in_process"
    assert fv.outputs  # non-empty output contract
    assert fv.required_inputs == ["run_id"]


def test_register_is_idempotent_by_id() -> None:
    reg = PipelineRegistry()
    reg.register(
        RegisteredPipeline(id="x", name="X", description="d", params_schema={})
    )
    reg.register(
        RegisteredPipeline(id="x", name="X2", description="d2", params_schema={})
    )
    assert len(reg.all()) == 1
    assert reg.get("x").name == "X2"
