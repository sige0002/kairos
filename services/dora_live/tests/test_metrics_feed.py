"""Feed-row conversion (metrics node contract)."""

from dora_live.metrics_feed import row_from_meta


def test_row_from_bridged_meta():
    row = row_from_meta(
        {
            "topic": "/hsrb/joint_states",
            "t_recv_ns": "1500000000",
            "size": "204",
            "stamp_ns": "2000000500",
            "bridged": "1",
        }
    )
    assert row == {
        "topic": "/hsrb/joint_states",
        "recv_t": 1.5,
        "size": 204,
        "bridged": True,
        "stamp_s": 2.0000005,
    }


def test_row_from_unbridged_meta_has_no_size():
    row = row_from_meta(
        {"topic": "/x", "t_recv_ns": "1000", "bridged": "0", "error": "no type"}
    )
    assert row is not None
    assert row["bridged"] is False
    assert row["size"] == 0
    assert "stamp_s" not in row


def test_row_rejects_malformed_meta():
    assert row_from_meta({}) is None
    assert row_from_meta({"topic": "/x"}) is None
    assert row_from_meta({"topic": "/x", "t_recv_ns": "abc"}) is None
