"""Extraction contracts for the four ROS-facing service APIs."""

from __future__ import annotations

import pytest
from perf_harness import extract_service_metrics


def _missing(reason: str = "field absent") -> dict[str, str]:
    return {"status": "unavailable", "reason": reason}


class TestMonitorMetrics:
    def test_extracts_rates_bytes_and_self_load(self) -> None:
        payload = {
            "topics": [
                {
                    "name": "/example/control",
                    "hz": 25.0,
                    "bandwidth_bps": 4000.0,
                    "messages_total": 250,
                }
            ],
            "self_load": {
                "callback_lag_ms": 0.4,
                "callback_lag_p95_ms": 1.2,
                "snapshot_age_s": 0.08,
            },
        }

        result = extract_service_metrics("monitor", payload)

        assert result["topic_rates_hz"] == {"/example/control": 25.0}
        assert result["topic_bandwidth_bps"] == {"/example/control": 4000.0}
        assert result["messages_total"] == {"/example/control": 250}
        assert result["callback_lag_ms"] == 0.4
        assert result["callback_lag_p95_ms"] == 1.2
        assert result["snapshot_age_s"] == 0.08

    def test_absent_self_load_fields_are_explicit(self) -> None:
        result = extract_service_metrics("monitor", {"topics": [], "self_load": None})

        assert result["callback_lag_ms"] == _missing()
        assert result["callback_lag_p95_ms"] == _missing()
        assert result["snapshot_age_s"] == _missing()


class TestStreamerMetrics:
    def test_extracts_current_and_future_stream_fields(self) -> None:
        payload = {
            "streams": [
                {
                    "stream_id": "cam-1",
                    "topic": "/example/camera",
                    "clients": 1,
                    "fps": 14.0,
                    "received_fps": 30.0,
                    "decoded_fps": 15.0,
                    "output_fps": 14.0,
                    "width": 640,
                    "height": 480,
                }
            ]
        }

        stream = extract_service_metrics("streamer", payload)["streams"][0]

        assert stream["client_count"] == 1
        assert stream["received_fps"] == 30.0
        assert stream["decoded_fps"] == 15.0
        assert stream["output_fps"] == 14.0
        assert stream["resolution"] == {"width": 640, "height": 480}

    def test_fields_not_yet_exposed_are_not_fabricated_from_fps(self) -> None:
        payload = {
            "streams": [
                {
                    "stream_id": "cam-1",
                    "topic": "/example/camera",
                    "clients": 0,
                    "fps": 12.0,
                }
            ]
        }

        stream = extract_service_metrics("streamer", payload)["streams"][0]

        assert stream["client_count"] == 0
        assert stream["received_fps"] == _missing()
        assert stream["decoded_fps"] == _missing()
        assert stream["output_fps"] == _missing()
        assert stream["resolution"] == _missing()


class TestRecorderMetrics:
    def test_extracts_state_counters_drops_and_validation(self) -> None:
        payload = {
            "state": "completed",
            "message_count": 101,
            "bytes": 4096,
            "dropped_messages": 2,
            "integrity": "dropped",
            "post_stop_validation": "fail",
        }

        assert extract_service_metrics("recorder", payload) == {
            "state": "completed",
            "message_count": 101,
            "bytes": 4096,
            "dropped_messages": 2,
            "integrity": "dropped",
            "post_stop_validation": "fail",
        }

    def test_null_drop_count_stays_unavailable_not_zero(self) -> None:
        result = extract_service_metrics(
            "recorder", {"state": "created", "message_count": 0, "bytes": 0}
        )

        assert result["dropped_messages"] == _missing()
        assert result["post_stop_validation"] == _missing()


class TestProbeMetrics:
    def test_active_probe_records_selected_topic_and_observed_sample(self) -> None:
        result = extract_service_metrics(
            "probe",
            {
                "topic": "/example/state",
                "field": "value",
                "value": 1.5,
                "t": 10.0,
            },
        )

        assert result == {
            "state": "active",
            "topic": "/example/state",
            "field": "value",
            "sample_value": 1.5,
            "sample_timestamp": 10.0,
        }

    def test_absent_probe_payload_is_explicitly_unavailable(self) -> None:
        result = extract_service_metrics("probe", None)

        assert result["state"] == "idle"
        assert result["topic"] == _missing("probe inactive")
        assert result["sample_value"] == _missing("probe inactive")

    def test_unknown_service_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="service"):
            extract_service_metrics("other", {})
