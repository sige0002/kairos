"""Pure-logic tests (no dora, no ROS)."""

import pyarrow as pa
from dora_live.bridge_logic import classify_value, dora_type_name, extract_stamp_ns


def test_classify_runtimeerror_is_unbridged():
    err = RuntimeError("could not find message type rm_ros_interfaces::Udpliftstate")
    info = classify_value(err)
    assert info.bridged is False
    assert info.size_bytes is None
    assert "Udpliftstate" in (info.error or "")


def test_classify_arrow_value():
    val = pa.array([1, 2, 3], type=pa.int32())
    info = classify_value(val)
    assert info.bridged is True
    assert info.size_bytes == val.nbytes
    assert info.error is None


def _stamped_struct(sec: int, nanosec: int) -> pa.Array:
    stamp = {"sec": sec, "nanosec": nanosec}
    header = {"stamp": stamp, "frame_id": "base"}
    return pa.array([{"header": header, "data": [0.5]}])


def test_extract_stamp_ns():
    val = _stamped_struct(7, 250)
    assert extract_stamp_ns(val) == 7_000_000_250


def test_extract_stamp_ns_zero_stamp_is_none():
    assert extract_stamp_ns(_stamped_struct(0, 0)) is None


def test_extract_stamp_ns_absent():
    assert extract_stamp_ns(pa.array([{"x": 1}])) is None
    assert extract_stamp_ns(pa.array([1.0])) is None
    assert extract_stamp_ns(RuntimeError("boom")) is None


def test_dora_type_name_strips_msg_infix():
    assert dora_type_name("sensor_msgs/msg/JointState") == "sensor_msgs/JointState"
    assert dora_type_name("sensor_msgs/JointState") == "sensor_msgs/JointState"


def test_feed_row_shapes():
    from dora_live.bridge_logic import ValueInfo, feed_row

    bridged = ValueInfo(bridged=True, size_bytes=123, error=None)
    row = feed_row("/a", 2_000_000_000, bridged, 1_500_000_000)
    assert row == {
        "topic": "/a",
        "recv_t": 2.0,
        "size": 123,
        "bridged": True,
        "stamp_s": 1.5,
    }
    unbridged = ValueInfo(bridged=False, size_bytes=None, error="no type")
    row = feed_row("/a", 1_000_000_000, unbridged, None)
    assert row == {"topic": "/a", "recv_t": 1.0, "size": 0, "bridged": False}


def test_decode_first_guards():
    from dora_live.bridge_logic import decode_first

    assert decode_first(object()) is None  # no to_pylist

    class Fake:
        def to_pylist(self):
            return [{"x": 1}]

    assert decode_first(Fake()) == {"x": 1}

    class Empty:
        def to_pylist(self):
            return []

    assert decode_first(Empty()) is None


def test_control_feeder_buffers_and_flushes():
    from dora_live.nodes.bridge import MAX_BUFFERED_ROWS, ControlFeeder

    feeder = ControlFeeder("http://c", "/a")  # thread NOT started: test pieces

    class FakeClient:
        def __init__(self):
            self.posts = []

        def post(self, url, json=None):
            self.posts.append((url, json))

        def get(self, url):
            raise RuntimeError("down")

    feeder.add_row({"topic": "/a", "recv_t": 1.0})
    feeder.post_probe("/internal/probe/values", {"topic": "/a"})
    client = FakeClient()
    feeder._flush(client)
    urls = [u for u, _ in client.posts]
    assert urls == ["http://c/internal/samples", "http://c/internal/probe/values"]
    assert client.posts[0][1] == {"rows": [{"topic": "/a", "recv_t": 1.0}]}
    # Buffers drained; a second flush posts nothing.
    client.posts.clear()
    feeder._flush(client)
    assert client.posts == []
    # Overflow cap: buffer never exceeds MAX_BUFFERED_ROWS.
    for i in range(MAX_BUFFERED_ROWS + 100):
        feeder.add_row({"n": i})
    assert len(feeder._rows) == MAX_BUFFERED_ROWS
    assert feeder._rows[-1] == {"n": MAX_BUFFERED_ROWS + 99}  # newest kept
    # Poll failure keeps previous probe state (no exception).
    feeder.active_fields = ["x"]
    feeder._poll_probe(client)
    assert feeder.active_fields == ["x"]


def test_control_feeder_introspect_is_one_shot():
    from dora_live.nodes.bridge import ControlFeeder

    feeder = ControlFeeder("http://c", "/a")

    class OkClient:
        def get(self, url):
            class R:
                @staticmethod
                def json():
                    return {"topics": {"/a": ["f1"]}, "introspect": ["/a"]}

            return R()

    feeder._poll_probe(OkClient())
    assert feeder.active_fields == ["f1"]
    assert feeder.take_introspect() is True
    assert feeder.take_introspect() is False  # consumed


def test_feed_row_from_tuple():
    from dora_live.bridge_logic import feed_row_from_tuple

    row = feed_row_from_tuple("/a", (2_000_000_000, 64, 1_500_000_000, True))
    assert row == {
        "topic": "/a",
        "recv_t": 2.0,
        "size": 64,
        "bridged": True,
        "stamp_s": 1.5,
    }
    row = feed_row_from_tuple("/a", (1_000_000_000, 0, None, False))
    assert row == {"topic": "/a", "recv_t": 1.0, "size": 0, "bridged": False}


def test_feeder_metrics_mode_drains_and_taps():
    from dora_live.nodes.bridge import ControlFeeder

    class FakeMsub:
        def __init__(self):
            self.samples = [(1_000_000_000, 8, None, True)]
            self.tap = None
            self._dropped = 0

        def drain(self):
            out, self.samples = self.samples, []
            return out

        def dropped(self):
            return self._dropped

        def set_tap(self, enabled):
            self.tap = enabled

        def take_latest(self):
            class V:
                @staticmethod
                def to_pylist():
                    return [{"position": [1.5, 2.5]}]

            return V()

    feeder = ControlFeeder("http://c", "/j")  # thread not started: drive by hand
    msub = FakeMsub()
    feeder.attach_metrics(msub)

    feeder._drain_metrics()
    assert feeder._rows[0]["topic"] == "/j" and feeder._rows[0]["size"] == 8

    # probe activates -> tap syncs on -> latest payload serves values
    feeder.active_fields = ["position[0]"]
    feeder._sync_tap()
    assert msub.tap is True
    feeder._serve_tap()
    posts = feeder._probe_posts
    assert posts and posts[-1][0] == "/internal/probe/values"
    assert posts[-1][1]["values"] == {"position[0]": 1.5}

    # probe deactivates -> tap off
    feeder.active_fields = []
    feeder._sync_tap()
    assert msub.tap is False


def test_feeder_metrics_mode_unresolved_type_answers_introspect():
    from dora_live.nodes.bridge import ControlFeeder

    class UnresolvedMsub:
        def drain(self):
            return [(1_000_000_000, 0, None, False)]

        def dropped(self):
            return 0

    feeder = ControlFeeder("http://c", "/x")
    feeder.attach_metrics(UnresolvedMsub())
    feeder._introspect = True
    feeder._drain_metrics()
    posts = feeder._probe_posts
    assert posts and posts[0][0] == "/internal/probe/fields"
    assert "not bridged" in posts[0][1]["reason"]


def _fake_client():
    class C:
        def __init__(self):
            self.posts = []

        def post(self, url, json=None):
            self.posts.append((url, json))

        def get(self, url):
            class R:
                @staticmethod
                def json():
                    return {"topics": {"/a": ["x"]}, "introspect": ["/a"]}

            return R()

    return C()


def test_ingest_feeder_cycle_drains_all_and_posts_once():
    from dora_live.nodes.ingest import IngestFeeder

    class Sub:
        def __init__(self, rows):
            self.rows = rows
            self.tap = False

        def drain(self):
            out, self.rows = self.rows, []
            return out

        def dropped(self):
            return 0

        def set_tap(self, enabled):
            self.tap = enabled

        def take_latest(self):
            class V:
                @staticmethod
                def to_pylist():
                    return [{"x": 7.5}]

            return V()

    subs = {
        "/a": Sub([(1_000_000_000, 4, None, True)]),
        "/b": Sub([(2_000_000_000, 8, 500_000_000, True)]),
    }
    feeder = IngestFeeder("http://c", subs)
    client = _fake_client()
    feeder._cycle(client, poll_probe=False)
    sample_posts = [p for p in client.posts if p[0].endswith("/internal/samples")]
    assert len(sample_posts) == 1  # ONE post for the whole topic set
    rows = sample_posts[0][1]["rows"]
    assert {r["topic"] for r in rows} == {"/a", "/b"}

    # probe poll -> /a tapped -> values served next cycle
    feeder._cycle(client, poll_probe=True)
    assert subs["/a"].tap is True and subs["/b"].tap is False
    feeder._cycle(client, poll_probe=False)
    values = [p for p in client.posts if p[0].endswith("/internal/probe/values")]
    assert values and values[-1][1] == {
        "topic": "/a",
        "t": values[-1][1]["t"],
        "values": {"x": 7.5},
    }


def test_ingest_feeder_unresolved_type_answers_introspect():
    from dora_live.nodes.ingest import IngestFeeder

    class DeadSub:
        tap = False

        def drain(self):
            return [(1_000_000_000, 0, None, False)]

        def dropped(self):
            return 0

        def set_tap(self, enabled):
            self.tap = enabled

    feeder = IngestFeeder("http://c", {"/a": DeadSub()})
    client = _fake_client()
    feeder._cycle(client, poll_probe=True)  # introspect for /a arrives
    feeder._cycle(client, poll_probe=False)  # unresolved -> honest reason
    fields = [p for p in client.posts if p[0].endswith("/internal/probe/fields")]
    assert fields and "not bridged" in fields[-1][1]["reason"]
