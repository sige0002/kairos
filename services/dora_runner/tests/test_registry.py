# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Pipeline registry (OL-④): metadata + runnable dispatch, no if/elif."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from dora_runner.models import RequiredTopicTemplate
from dora_runner.registry import (
    DEFAULT_REGISTRY,
    PipelineRegistry,
    RegisteredPipeline,
    _resolve_template,
    build_default_registry,
)
from dora_runner.store import JobRecord
from kairos_common import ApiError


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


def test_max_frames_param_defaults_without_type_coercion() -> None:
    """Integers are accepted, but strings and bools are not converted."""
    import pytest
    from dora_runner.registry import _max_frames_param
    from dora_runner.video_check import MAX_FRAMES
    from kairos_common import ApiError

    assert _max_frames_param({}) == MAX_FRAMES
    assert _max_frames_param({"max_frames": 0}) == 0
    assert _max_frames_param({"max_frames": 12}) == 12
    with pytest.raises(ApiError):
        _max_frames_param({"max_frames": -1})
    with pytest.raises(ApiError):
        _max_frames_param({"max_frames": "12"})
    with pytest.raises(ApiError):
        _max_frames_param({"max_frames": True})


# ---- fast_validation template resolution ---------------------------------
# E-21 asked whether an unknown template silently falls back to a default, which
# would make a pass untraceable. It does not — but the OMITTED-template path is
# worth pinning for what its pass is actually worth.


def _job(params: dict) -> JobRecord:
    return JobRecord(
        job_id="job_1", capture_id="cap_1", pipeline="fast_validation", params=params
    )


def test_a_named_template_that_does_not_exist_is_REFUSED_by_name() -> None:
    """No silent fallback: the run stops and says which template was missing.

    A fast_validation that quietly ran under some default would report a normal
    pass for a check the operator never asked for.
    """

    class _EmptyStore:
        async def get_template(self, name: str):  # noqa: ANN001, ANN202
            return None

    with pytest.raises(ApiError) as excinfo:
        asyncio.run(
            _resolve_template(
                _job({"template": "no_such_template"}), _EmptyStore(), Path(".")
            )
        )
    err = excinfo.value
    assert err.status_code == 400
    assert err.code == "template_not_found"
    assert "no_such_template" in err.message
    assert err.details == {"template": "no_such_template"}


def test_an_OMITTED_template_drafts_from_the_capture_and_asserts_almost_nothing(
    monkeypatch,
) -> None:
    """The draft path is deliberate — and near-vacuous. Both belong on the record.

    With no template named, fast_validation builds one from the capture's OWN
    topic inventory, so "the required topics are present" is true by
    construction: whatever the bag contains becomes what the bag is required to
    contain. A pass here asserts that the recording exists and could be read,
    not that it carries what the operator's robot is supposed to produce.

    It is kept rather than fixed because it is self-identifying — the artifact
    records `template.name` as `<capture_id>_template`, so a reader can tell a
    drafted run from a real one — and because full_validation explicitly refuses
    the same shortcut (see _resolve_optional_template) where it would matter. The
    Validation screen always fills the param, so this is not reachable from the UI.
    """
    bag_topics = [
        RequiredTopicTemplate(
            name="/whatever/this/bag/has", type="std_msgs/msg/String"
        ),
        RequiredTopicTemplate(name="/and/this/one", type="std_msgs/msg/String"),
    ]
    monkeypatch.setattr(
        "dora_runner.validation.mcap_loader",
        lambda capture_id, data_dir: {"topics": bag_topics},
    )

    class _EmptyStore:
        async def get_template(self, name: str):  # noqa: ANN001, ANN202
            return None

    template = asyncio.run(_resolve_template(_job({}), _EmptyStore(), Path(".")))

    # Self-identifying in the artifact: a reader can see this was drafted.
    assert template.name == "cap_1_template"
    # And the check it produces cannot fail on missing topics: the required set
    # IS the bag's set, so `missing` is empty for any bag it was drafted from.
    assert [t.name for t in template.required_topics] == [t.name for t in bag_topics]
