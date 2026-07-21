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
