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
    for pid in ("dataset_convert", "dataset_validation"):
        assert not reg.runnable(pid), pid
        assert reg.get(pid) is not None and reg.get(pid).enabled is False


def test_full_validation_follows_bagflow_availability(monkeypatch) -> None:
    """full_validation is the one pipeline gated on binaries the source tree does
    not carry: runnable in the image, an honest placeholder anywhere else."""
    import dora_runner.registry as registry_module

    monkeypatch.setattr(registry_module, "bagflow_available", lambda: False)
    absent = registry_module.build_default_registry(discover=False).get(
        "full_validation"
    )
    assert absent is not None and absent.enabled is False
    assert "bagflow" in absent.description

    monkeypatch.setattr(registry_module, "bagflow_available", lambda: True)
    monkeypatch.setattr(registry_module, "list_flows", lambda: ["default", "cameras"])
    present = registry_module.build_default_registry(discover=False).get(
        "full_validation"
    )
    assert present is not None and present.enabled is True
    # Discovered flows drive the auto-rendered form (a picker, not free text).
    assert present.params_schema["properties"]["flow"]["enum"] == ["default", "cameras"]
    assert present.executor == "dora"


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


def test_max_frames_param_defaults_coerces_and_rejects() -> None:
    """video_check's max_frames param: absent -> the default cap, 0 = full
    episode, numeric strings coerce, negatives/garbage -> a 400 ApiError."""
    import pytest
    from dora_runner.registry import _max_frames_param
    from dora_runner.video_check import MAX_FRAMES
    from kairos_common import ApiError

    assert _max_frames_param({}) == MAX_FRAMES
    assert _max_frames_param({"max_frames": 0}) == 0
    assert _max_frames_param({"max_frames": "12"}) == 12
    with pytest.raises(ApiError):
        _max_frames_param({"max_frames": -1})
    with pytest.raises(ApiError):
        _max_frames_param({"max_frames": "full"})
