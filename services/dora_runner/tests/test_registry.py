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
    assert {"fast_validation", "loss_report", "video_check"} <= ids
    # The MCAP-reading pipelines are runnable wherever the service runs;
    # placeholders are not. (The two validation gates need the bagflow binaries
    # and are covered by their own availability test below.)
    for pid in ("loss_report", "video_check", "signal_report"):
        assert reg.runnable(pid), pid
    for pid in ("dataset_convert", "dataset_validation"):
        assert not reg.runnable(pid), pid
        assert reg.get(pid) is not None and reg.get(pid).enabled is False


def test_dataset_pipelines_are_gone() -> None:
    """§6: datasets are rows, so dora_runner no longer moves or archives them.

    ``dataset_export`` MOVED a recording out of the store and ``dataset_archive``
    copied one out and deleted the source. Both are the orchestrator's now
    (``POST /api/v1/captures/{id}/archive`` and the views regeneration), and a
    registry that still advertised them would let the UI submit a job that
    reaches for a directory layout that no longer exists.
    """
    reg = build_default_registry()
    ids = {p.id for p in reg.all()}
    assert "dataset_export" not in ids
    assert "dataset_archive" not in ids


def test_no_pipeline_still_takes_a_dataset_dir_param() -> None:
    """§6/§10.5: the source is objects/<capture_id> and nothing else.

    A leftover ``dataset_dir`` property would be an unreachable form field, and
    worse, an input that looks like it can still redirect a job's source.
    """
    for pipeline in build_default_registry().all():
        properties = pipeline.params_schema.get("properties", {})
        assert "dataset_dir" not in properties, pipeline.id
        assert pipeline.required_inputs in (["capture_id"], []), pipeline.id


def test_outputs_are_keyed_by_capture_id() -> None:
    """§2: report/<pipeline>/<capture_id>/ — the advertised contract says so."""
    for pipeline in build_default_registry().all():
        for output in pipeline.outputs:
            assert "<run_id>" not in output, pipeline.id
            assert "<capture_id>" in output, pipeline.id


def test_validation_gates_follow_bagflow_availability(monkeypatch) -> None:
    """Both gates run on dora, so both are gated on binaries the source tree does
    not carry: runnable in the image, an honest placeholder anywhere else."""
    import dora_runner.registry as registry_module

    monkeypatch.setattr(registry_module, "bagflow_available", lambda: False)
    absent_registry = registry_module.build_default_registry(discover=False)
    for pid in ("fast_validation", "full_validation"):
        absent = absent_registry.get(pid)
        assert absent is not None and absent.enabled is False, pid
        assert "bagflow" in absent.description, pid

    monkeypatch.setattr(registry_module, "bagflow_available", lambda: True)
    monkeypatch.setattr(registry_module, "list_flows", lambda: ["default", "cameras"])
    present_registry = registry_module.build_default_registry(discover=False)
    present = present_registry.get("full_validation")
    assert present is not None and present.enabled is True
    # Discovered flows drive the auto-rendered form (a picker, not free text).
    assert present.params_schema["properties"]["flow"]["enum"] == ["default", "cameras"]
    assert present.executor == "dora"
    # fast_validation needs no authored flow: its own ships with the service.
    fast = present_registry.get("fast_validation")
    assert fast is not None and fast.enabled is True
    assert fast.executor == "dora"


def test_runnable_unknown_pipeline_is_false() -> None:
    assert DEFAULT_REGISTRY.runnable("does_not_exist") is False
    assert DEFAULT_REGISTRY.get("does_not_exist") is None


def test_metadata_carries_schema_outputs_executor() -> None:
    fv = DEFAULT_REGISTRY.get("fast_validation")
    assert fv is not None
    assert fv.params_schema["required"] == ["template"]
    assert fv.executor == "dora"
    assert fv.outputs  # non-empty output contract
    assert fv.required_inputs == ["capture_id"]


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
