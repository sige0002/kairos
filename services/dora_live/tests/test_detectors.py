"""Demo detector logic (pure)."""

from dora_live.detectors import JointVelocityDetector, StampLagDetector


def test_joint_velocity_spike_fires_once_baseline_learned():
    det = JointVelocityDetector(threshold=4.0, min_samples=10)
    t = 0.0
    pos = [0.0, 0.0]
    # steady slow motion builds the baseline
    for _ in range(40):
        t += 0.01
        pos = [p + 0.001 for p in pos]
        assert det.on_message("/j", {"position": list(pos)}, t) is None
    # violent jump -> spike event
    t += 0.01
    pos = [p + 0.5 for p in pos]
    event = det.on_message("/j", {"position": list(pos)}, t)
    assert event is not None
    assert event.detector == "joint_velocity"
    assert event.grade == "demo"
    assert event.severity == "warn"


def test_joint_velocity_ignores_malformed():
    det = JointVelocityDetector()
    assert det.on_message("/j", {"position": []}, 1.0) is None
    assert det.on_message("/j", {"velocity": [1.0]}, 1.1) is None
    det.on_message("/j", {"position": [0.0, 0.0]}, 1.2)
    # joint count changed between messages -> skipped, no crash
    assert det.on_message("/j", {"position": [0.0]}, 1.3) is None


def test_stamp_lag_fires_and_rearms():
    det = StampLagDetector(warn_s=0.5)
    assert det.on_sample("/x", stamp_s=100.0, wall_t=100.1) is None
    event = det.on_sample("/x", stamp_s=100.0, wall_t=101.0)
    assert event is not None and event.detector == "stamp_lag"
    # stays silent while the condition persists
    assert det.on_sample("/x", stamp_s=100.0, wall_t=102.0) is None
    # recovers, then fires again on the next breach
    assert det.on_sample("/x", stamp_s=103.0, wall_t=103.1) is None
    assert det.on_sample("/x", stamp_s=103.0, wall_t=104.0) is not None


def test_stamp_lag_ignores_zero_stamp():
    det = StampLagDetector()
    assert det.on_sample("/x", stamp_s=None, wall_t=10.0) is None
    assert det.on_sample("/x", stamp_s=0.0, wall_t=10.0) is None


def test_stamp_lag_classifies_clock_mismatch():
    det = StampLagDetector()
    # bag replay: stamps are months old -> info-grade clock-domain event
    event = det.on_sample("/x", stamp_s=1_000_000.0, wall_t=35_000_000.0)
    assert event is not None
    assert event.severity == "info"
    assert "clock domain" in event.message
    # and only once per topic
    assert det.on_sample("/x", stamp_s=1_000_001.0, wall_t=35_000_001.0) is None


def test_joint_velocity_cooldown_limits_event_rate():
    det = JointVelocityDetector(threshold=4.0, min_samples=10, cooldown_s=5.0)
    t = 0.0
    pos = [0.0]
    for _ in range(30):
        t += 0.01
        pos = [p + 0.001 for p in pos]
        det.on_message("/j", {"position": list(pos)}, t)
    # first spike fires
    t += 0.01
    pos = [p + 0.5 for p in pos]
    assert det.on_message("/j", {"position": list(pos)}, t) is not None
    # immediate second spike is suppressed by the cooldown
    t += 0.01
    pos = [p + 0.5 for p in pos]
    assert det.on_message("/j", {"position": list(pos)}, t) is None
    # after the cooldown window it can fire again
    t += 6.0
    det.on_message("/j", {"position": list(pos)}, t)
    t += 0.01
    pos = [p + 3.0 for p in pos]
    assert det.on_message("/j", {"position": list(pos)}, t) is not None
