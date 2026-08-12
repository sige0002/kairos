# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""fast_validation's report -> summary adapter (no dora, no MCAP).

The Validation screen renders a bespoke required-topic checklist from
``missing`` / ``extra`` / ``result``, so those three fields are a contract with
the frontend: they survived the port from the in-process validator to the
bagflow flow and must keep their shape.
"""

from __future__ import annotations

from pathlib import Path

from dora_runner.bagflow_pipeline import FlowOutcome
from dora_runner.fast_validation import summarize
from kairos_common import ValidationTemplate
from kairos_common.ids import new_capture_id

# A capture_id is a UUIDv7 everywhere it is used as a key or path segment (§1).
CAPTURE_ID = new_capture_id()

TEMPLATE = ValidationTemplate(
    name="airoa_hsr", version=3, required_topics=[{"name": "/joint_states"}]
)


def _outcome(
    report: dict, template: ValidationTemplate | None = TEMPLATE
) -> FlowOutcome:
    return FlowOutcome(
        report=report,
        flow="fast_validation",
        capture_id=CAPTURE_ID,
        wall_s=0.42,
        bag_dir=Path(f"/data/objects/{CAPTURE_ID}"),
        template=template,
    )


def _report(presence: dict, *, source_ok: bool = True, incomplete: list | None = None):
    return {
        "results": {
            "bagflow_source": [{"check": "source_read", "ok": source_ok}],
            "topic_presence": [{"check": "topic_presence", **presence}],
        },
        "incomplete": incomplete or [],
        "bag": {"path": "/data/recorded/run_1", "duration_s": 61.8, "topics": {}},
    }


def test_pass_keeps_the_checklist_contract() -> None:
    summary = summarize(
        _outcome(
            _report(
                {
                    "ok": True,
                    "required": 1,
                    "matched": 1,
                    "topics_in_bag": 3,
                    "missing": [],
                    "extra": [{"name": "/tf", "type": "tf2_msgs/msg/TFMessage"}],
                }
            )
        )
    )

    assert summary["result"] == "pass"
    assert summary["pipeline"] == "fast_validation"
    assert summary["engine"] == "bagflow"
    assert summary["template"] == {"name": "airoa_hsr", "version": 3}
    assert summary["missing"] == []
    assert summary["extra"][0]["name"] == "/tf"
    assert summary["metrics"]["topics_in_bag"] == 3
    # `required` counts patterns, `matched` counts topics: one glob can cover
    # several, so the headline must not read as a single ratio.
    assert "1/1 required topic pattern(s) matched (1 topic(s))" in summary["message"]
    assert summary["metrics"]["wall_s"] == 0.42
    # `topics` is a per-topic map that would bloat every summary; it stays in
    # report.json (an artifact).
    assert "topics" not in summary["bag"]


def test_missing_topics_fail_and_are_named_in_the_message() -> None:
    summary = summarize(
        _outcome(
            _report(
                {
                    "ok": False,
                    "required": 2,
                    "matched": 1,
                    "topics_in_bag": 3,
                    "missing": [
                        {
                            "name": "/hsrb/hand_camera/image_raw/compressed",
                            "type": None,
                            "reason": "topic not in bag",
                        }
                    ],
                    "extra": [],
                }
            )
        )
    )

    assert summary["result"] == "fail"
    assert summary["missing"][0]["name"] == "/hsrb/hand_camera/image_raw/compressed"
    # The reason bagflow gives survives into the summary — "which topic" is not
    # enough to fix a recording, "why" is.
    assert summary["missing"][0]["reason"] == "topic not in bag"
    assert "1 required topic(s) missing" in summary["message"]
    assert summary["metrics"]["missing"] == 1


def test_a_failing_source_read_fails_the_run_even_with_all_topics_present() -> None:
    """A truncated MCAP is exactly what a gate must catch: every required topic
    is still declared in metadata.yaml, so presence alone would pass it."""
    summary = summarize(
        _outcome(
            _report(
                {"ok": True, "required": 1, "matched": 1, "missing": [], "extra": []},
                source_ok=False,
            )
        )
    )

    assert summary["result"] == "fail"
    assert "also failed" in summary["message"]


def test_a_node_that_died_fails_the_run() -> None:
    """The check it was supposed to run simply did not happen; reporting "no
    failures" would be a lie."""
    summary = summarize(
        _outcome(
            _report(
                {"ok": True, "required": 1, "matched": 1, "missing": [], "extra": []},
                incomplete=["result_topic_presence"],
            )
        )
    )

    assert summary["result"] == "fail"
    assert summary["incomplete"] == ["topic_presence"]


def test_a_flow_without_a_presence_result_never_passes() -> None:
    report = {"results": {"bagflow_source": [{"check": "source_read", "ok": True}]}}

    summary = summarize(_outcome(report))

    assert summary["result"] == "fail"
    assert "no topic_presence result" in summary["message"]


def test_an_empty_template_says_nothing_was_checked() -> None:
    """0 required topics can only ever pass; the headline must not read like a
    verdict that something was verified."""
    summary = summarize(
        _outcome(
            _report(
                {"ok": True, "required": 0, "matched": 0, "missing": [], "extra": []}
            )
        )
    )

    assert summary["result"] == "pass"
    assert "nothing checked" in summary["message"]


def test_missing_bag_metadata_is_reported_as_such() -> None:
    summary = summarize(
        _outcome(
            _report(
                {
                    "ok": False,
                    "required": 1,
                    "matched": 0,
                    "topics_in_bag": 0,
                    "bag_metadata": False,
                    "reason": "no bag metadata.yaml — no topic inventory",
                    "missing": [
                        {"name": "/joint_states", "reason": "topic not in bag"}
                    ],
                    "extra": [],
                }
            )
        )
    )

    assert summary["result"] == "fail"
    assert "metadata.yaml" in summary["message"]
