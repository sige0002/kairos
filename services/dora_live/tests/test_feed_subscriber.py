"""Graph discovery: snapshot conversion and backend selection surface."""

from dora_live.feed_subscriber import DoraFeedSubscriber, entries_from_snapshot


def test_entries_from_snapshot_shapes():
    rows = [
        (
            "/hsrb/joint_states",
            "sensor_msgs/msg/JointState",
            2,
            1,
            [("reliable", "volatile", 1), ("best_effort", "transient_local", 5)],
        ),
        ("/cam", "sensor_msgs/msg/CompressedImage", 0, 3, []),
    ]
    entries, qos = entries_from_snapshot(rows)
    assert [e.name for e in entries] == ["/hsrb/joint_states", "/cam"]
    assert entries[0].type == "sensor_msgs/msg/JointState"
    assert entries[0].publisher_count == 2
    assert entries[0].subscriber_count == 1
    assert entries[1].publisher_count == 0
    infos = qos["/hsrb/joint_states"]
    assert [(i.reliability, i.durability, i.depth) for i in infos] == [
        ("reliable", "volatile", 1),
        ("best_effort", "transient_local", 5),
    ]
    assert qos["/cam"] == []


def test_entries_from_snapshot_empty_type_is_none():
    entries, _ = entries_from_snapshot([("/t", "", 1, 0, [])])
    assert entries[0].type is None


def test_discovery_source_defaults_to_none_without_thread():
    feed = DoraFeedSubscriber(enable_discovery=False)
    feed.start()
    assert feed.discovery_source == "none"
    assert feed._thread is None
    feed.stop()
