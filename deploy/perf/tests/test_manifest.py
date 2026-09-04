"""Scenario identity and comparison-safety contracts."""

from __future__ import annotations

from pathlib import Path

import pytest
from perf_harness import build_manifest, comparison_mismatches, sha256_file


def _manifest(**overrides: object) -> dict:
    values: dict[str, object] = {
        "scenario_name": "monitor-control",
        "duration_s": 30.0,
        "warmup_s": 5.0,
        "sample_interval_s": 1.0,
        "camera_count": 0,
        "selected_topics": ["/example/control"],
        "preview_layout": "none",
        "preview_caps": {"max_fps": None, "max_width": None, "max_height": None},
        "recorder_state": "created",
        "probe_state": "idle",
        "robot_motion": "stationary",
        "rmw": "rmw_cyclonedds_cpp",
        "transport_evidence": {"cyclonedds_safe_profile": True},
        "config_hashes": {"recording": "abc", "stream": "def"},
        "git_sha": "baseline-sha",
    }
    values.update(overrides)
    return build_manifest(**values)


class TestConfigIdentity:
    def test_sha256_file_is_content_based(self, tmp_path: Path) -> None:
        first = tmp_path / "first.yaml"
        second = tmp_path / "renamed.yaml"
        first.write_bytes(b"topics:\n  - /example/control\n")
        second.write_bytes(first.read_bytes())

        assert sha256_file(first) == sha256_file(second)
        second.write_bytes(b"topics: []\n")
        assert sha256_file(first) != sha256_file(second)

    def test_manifest_contains_complete_workload_and_environment(self) -> None:
        manifest = _manifest()

        assert manifest["schema_version"] == 1
        assert manifest["scenario"]["name"] == "monitor-control"
        assert manifest["scenario"]["duration_s"] == 30.0
        assert manifest["workload"]["selected_topics"] == ["/example/control"]
        assert manifest["workload"]["preview_caps"]["max_fps"] is None
        assert manifest["workload"]["recorder_state"] == "created"
        assert manifest["workload"]["robot_motion"] == "stationary"
        assert manifest["environment"]["rmw"] == "rmw_cyclonedds_cpp"
        assert manifest["environment"]["config_hashes"] == {
            "recording": "abc",
            "stream": "def",
        }
        assert manifest["environment"]["git_sha"] == "baseline-sha"


class TestComparisonSafety:
    @pytest.mark.parametrize(
        ("field", "replacement", "expected_path"),
        [
            ("camera_count", 2, "workload.camera_count"),
            ("selected_topics", ["/example/state"], "workload.selected_topics"),
            ("preview_layout", "main-plus-subtiles", "workload.preview_layout"),
            (
                "preview_caps",
                {"max_fps": 10, "max_width": 640, "max_height": 480},
                "workload.preview_caps",
            ),
            ("recorder_state", "recording", "workload.recorder_state"),
            ("probe_state", "active", "workload.probe_state"),
            ("robot_motion", "moving", "workload.robot_motion"),
            ("rmw", "rmw_fastrtps_cpp", "environment.rmw"),
            (
                "transport_evidence",
                {"fastdds_shm_verified": True},
                "environment.transport_evidence",
            ),
            (
                "config_hashes",
                {"recording": "changed", "stream": "def"},
                "environment.config_hashes",
            ),
            ("duration_s", 60.0, "scenario.duration_s"),
            ("warmup_s", 10.0, "scenario.warmup_s"),
            ("sample_interval_s", 2.0, "scenario.sample_interval_s"),
        ],
    )
    def test_rejects_unlike_measurements(
        self, field: str, replacement: object, expected_path: str
    ) -> None:
        assert expected_path in comparison_mismatches(
            _manifest(), _manifest(**{field: replacement})
        )

    def test_git_sha_may_differ_for_baseline_candidate_comparison(self) -> None:
        assert (
            comparison_mismatches(
                _manifest(git_sha="before"), _manifest(git_sha="after")
            )
            == []
        )

    def test_transport_comparison_can_explicitly_allow_only_rmw_axis(self) -> None:
        baseline = _manifest(rmw="rmw_cyclonedds_cpp")
        candidate = _manifest(rmw="rmw_fastrtps_cpp")
        baseline["comparison"] = {"allowed_axes": ["environment.rmw"]}
        candidate["comparison"] = {"allowed_axes": ["environment.rmw"]}

        assert comparison_mismatches(baseline, candidate) == []

    def test_one_sided_axis_declaration_does_not_suppress_rmw_mismatch(self) -> None:
        baseline = _manifest(rmw="rmw_cyclonedds_cpp")
        candidate = _manifest(rmw="rmw_fastrtps_cpp")
        baseline["comparison"] = {"allowed_axes": ["environment.rmw"]}

        assert "environment.rmw" in comparison_mismatches(baseline, candidate)

    def test_manifest_rejects_unknown_recorder_state(self) -> None:
        with pytest.raises(ValueError, match="recorder_state"):
            _manifest(recorder_state="sometimes")
