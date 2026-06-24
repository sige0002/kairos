"""Unit tests for the validator node — no MCAP, no ROS, no HTTP.

``validator(loaded, template)`` is a pure function over a plain ``loaded`` dict
(``{"topics": [{"name", "type"}, ...]}``), so a check can be exercised in
isolation with a hand-built topic list. This is the fast, deterministic way to
develop and debug a validation rule (vs. the real-MCAP flow in
``test_fast_validation.py``, which depends on a local recording).
"""

from __future__ import annotations

from dora_runner.models import RequiredTopicTemplate, ValidationTemplate
from dora_runner.validation import validator


def _loaded(*topics: tuple[str, str]) -> dict:
    """Build a fake mcap_loader output from (name, type) pairs."""
    return {"topics": [{"name": name, "type": type_} for name, type_ in topics]}


def _template(*required: RequiredTopicTemplate) -> ValidationTemplate:
    return ValidationTemplate(name="t", version=1, required_topics=list(required))


def test_pass_when_all_required_present() -> None:
    loaded = _loaded(
        ("/joint_states", "sensor_msgs/msg/JointState"),
        ("/tf", "tf2_msgs/msg/TFMessage"),
    )
    out = validator(loaded, _template(RequiredTopicTemplate(name="/joint_states")))
    assert out["result"] == "pass"
    assert out["missing"] == []
    # Topics not named by the template surface as "extra".
    assert [e["name"] for e in out["extra"]] == ["/tf"]


def test_fail_lists_missing() -> None:
    loaded = _loaded(("/tf", "tf2_msgs/msg/TFMessage"))
    out = validator(loaded, _template(RequiredTopicTemplate(name="/joint_states")))
    assert out["result"] == "fail"
    assert out["missing"][0]["name"] == "/joint_states"


def test_glob_match() -> None:
    loaded = _loaded(("/camera/head/image_raw", "sensor_msgs/msg/Image"))
    out = validator(
        loaded, _template(RequiredTopicTemplate(name="/camera/*/image_raw"))
    )
    assert out["result"] == "pass"
    assert out["extra"] == []  # the glob matched it, so it is not "extra"


def test_type_must_match_when_specified() -> None:
    compressed = "sensor_msgs/msg/CompressedImage"
    loaded = _loaded(("/cam/compressed", compressed))
    ok = _template(RequiredTopicTemplate(name="/cam/compressed", type=compressed))
    bad = _template(
        RequiredTopicTemplate(name="/cam/compressed", type="sensor_msgs/msg/Image")
    )
    assert validator(loaded, ok)["result"] == "pass"
    assert validator(loaded, bad)["result"] == "fail"  # name matches, type does not
