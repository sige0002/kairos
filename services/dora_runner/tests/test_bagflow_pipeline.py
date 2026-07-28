"""Shared bagflow machinery: how kairos config reaches a flow, and job hygiene.

Both gates (``fast_validation`` / ``full_validation``) run through
``bagflow_pipeline``; these tests cover the parts that are the same for both.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from dora_runner.bagflow_pipeline import (
    reported_artifact,
    required_topics,
    topic_expectations,
)
from kairos_common import ApiError, RecordingConfig, ValidationTemplate

# NOTE: `RequiredTopic` exists twice (recording_config's own + validation_config's
# for templates), so these fixtures build each side from plain dicts rather than
# passing one module's model into the other's field.


def _config(**overrides) -> RecordingConfig:
    return RecordingConfig(robot_name="test", **overrides)


def _names(specs: list[dict[str, str | None]]) -> list[str]:
    return [str(spec["name"]) for spec in specs]


def test_required_topics_prefer_the_job_template() -> None:
    template = ValidationTemplate(
        name="t", version=1, required_topics=[{"name": "/from_template"}]
    )
    config = _config(validation={"required_topics": [{"name": "/from_config"}]})

    assert _names(required_topics(template, config)) == ["/from_template"]
    assert _names(required_topics(None, config)) == ["/from_config"]
    assert required_topics(None, None) == []


def test_required_topics_carry_the_declared_message_type() -> None:
    """``${KAIROS_REQUIRED_TOPIC_SPECS}`` keeps ``type``: bagflow-topic-presence
    fails a topic that exists under a different message type, which a bare name
    list could never express."""
    template = ValidationTemplate(
        name="t",
        version=1,
        required_topics=[
            {"name": "/img", "type": "sensor_msgs/msg/CompressedImage"},
            {"name": "/tf"},
        ],
    )

    assert required_topics(template, None) == [
        {"name": "/img", "type": "sensor_msgs/msg/CompressedImage"},
        {"name": "/tf", "type": None},
    ]


def test_required_topics_become_presence_only_expectations() -> None:
    """hz 0 is how a required topic reaches bagflow-topic-rate: it reports a
    topic missing from the bag and never flags a rate below 0."""
    expectations = topic_expectations(["/present"], ["/required"], None)

    assert expectations == {"/required": 0.0}


def test_static_expected_hz_overrides_and_covers_recorded_topics() -> None:
    config = _config(
        expected_hz_patterns=[
            {"pattern": "**/compressed", "hz": 10.0},
            {"pattern": "/joint_states", "hz": 100.0},
        ]
    )

    expectations = topic_expectations(
        ["/cam/image_raw/compressed", "/joint_states", "/tf"],
        ["/joint_states", "/never_recorded"],
        config,
    )

    assert expectations == {
        "/cam/image_raw/compressed": 10.0,  # recorded, has a pattern
        "/joint_states": 100.0,  # required AND rated -> the rate wins
        "/never_recorded": 0.0,  # required, absent from the run -> presence only
        # "/tf" is neither required nor rated: nothing to assert about it.
    }


def test_a_pattern_without_hz_is_not_an_expectation() -> None:
    """``hz:`` omitted means 'learn it dynamically' — inventing 0 there would
    turn a monitoring hint into a hard presence requirement."""
    config = _config(expected_hz_patterns=[{"pattern": "/tf"}])

    assert topic_expectations(["/tf"], [], config) == {}


def test_artifacts_keep_the_configured_data_dir_shape(tmp_path) -> None:
    """The orchestrator rewrites artifacts relative to the CONFIGURED data dir
    (``./data`` by default) before the UI links them; reporting the resolved
    absolute path would make every artifact unclickable text."""
    resolved = tmp_path / "data"
    summary = resolved / "report" / "full_validation" / "run_1" / "summary.json"

    assert (
        reported_artifact(summary, resolved, Path("data"))
        == "data/report/full_validation/run_1/summary.json"
    )
    # A path outside the data root is passed through rather than mangled.
    outside = tmp_path / "elsewhere" / "x.json"
    assert reported_artifact(outside, resolved, Path("data")) == str(outside)


def test_unavailable_bagflow_is_a_clear_error_for_both_gates(
    tmp_path, monkeypatch
) -> None:
    import asyncio

    import dora_runner.bagflow_pipeline as module
    from dora_runner.fast_validation import run_fast_validation
    from dora_runner.full_validation import run_full_validation

    monkeypatch.setattr(module, "bagflow_available", lambda: False)

    with pytest.raises(ApiError) as full_error:
        asyncio.run(
            run_full_validation(
                run_id="run_1",
                data_dir=tmp_path,
                flow="default",
                endpoint=module.DoraEndpoint(),
                job_name="job_1",
            )
        )
    assert full_error.value.code == "bagflow_unavailable"

    with pytest.raises(ApiError) as fast_error:
        asyncio.run(
            run_fast_validation(
                run_id="run_1",
                data_dir=tmp_path,
                endpoint=module.DoraEndpoint(),
                job_name="job_2",
                template=ValidationTemplate(
                    name="t", version=1, required_topics=[{"name": "/tf"}]
                ),
            )
        )
    assert fast_error.value.code == "bagflow_unavailable"
