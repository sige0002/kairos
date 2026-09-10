# SPDX-License-Identifier: Apache-2.0
"""Receive backend selection must not silently hide native startup failures."""

import pytest
from topic_monitor.main import _build_subscriber
from topic_monitor.native_backend import NativeTopicSubscriber
from topic_monitor.ros_subscriber import RosTopicSubscriber


def test_native_is_default_without_importing_ros(monkeypatch):
    monkeypatch.delenv("KAIROS_MONITOR_BACKEND", raising=False)
    subscriber = _build_subscriber(None)
    assert isinstance(subscriber, NativeTopicSubscriber)
    assert subscriber.engine is None
    assert not subscriber.is_up()


def test_python_rollback_is_explicit(monkeypatch):
    monkeypatch.setenv("KAIROS_MONITOR_BACKEND", "python")
    assert type(_build_subscriber(None)) is RosTopicSubscriber


def test_invalid_backend_is_not_silently_ignored(monkeypatch):
    monkeypatch.setenv("KAIROS_MONITOR_BACKEND", "typo")
    with pytest.raises(ValueError, match="unknown monitor backend"):
        _build_subscriber(None)


def test_native_failure_does_not_fall_back_to_python(monkeypatch):
    monkeypatch.setenv("KAIROS_MONITOR_BACKEND", "native")

    def fail(_self):
        raise RuntimeError("native library unavailable")

    monkeypatch.setattr(NativeTopicSubscriber, "_spin_up", fail)
    subscriber = _build_subscriber(None)
    with pytest.raises(RuntimeError, match="native library unavailable"):
        subscriber.start()
    assert not subscriber.is_up()
