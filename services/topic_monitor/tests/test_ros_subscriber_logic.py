def test_resolve_qos_floors_at_configured_monitor_depth():
    from kairos_common import RecordingConfig
    from topic_monitor.ros_subscriber import RosTopicSubscriber

    config = RecordingConfig.model_validate(
        {"robot_name": "t", "default_topics": ["/a"], "monitor": {"qos_depth": 42}}
    )
    sub = RosTopicSubscriber(["/a"], config=config)

    class FakeNode:
        @staticmethod
        def get_publishers_info_by_topic(topic):
            return []  # no publishers -> fallback uses the configured floor

    qos = sub._resolve_qos(FakeNode(), "/a")
    assert qos.depth == 42
