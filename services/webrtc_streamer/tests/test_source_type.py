"""Unit tests for image-topic type resolution (no ROS needed).

``_is_compressed_topic`` decides whether a topic carries CompressedImage (vs raw
Image) so the source subscribes to exactly one type — subscribing to both on the
same topic makes rcl raise "invalid allocator".
"""

from __future__ import annotations

from webrtc_streamer.source import _is_compressed_topic


class _FakeNode:
    def __init__(self, graph: dict[str, list[str]]) -> None:
        self._graph = graph

    def get_topic_names_and_types(self) -> list[tuple[str, list[str]]]:
        return list(self._graph.items())


def test_prefers_graph_type_compressed() -> None:
    node = _FakeNode({"/cam/image": ["sensor_msgs/msg/CompressedImage"]})
    assert _is_compressed_topic(node, "/cam/image") is True


def test_prefers_graph_type_raw_image() -> None:
    node = _FakeNode({"/cam/image_raw": ["sensor_msgs/msg/Image"]})
    assert _is_compressed_topic(node, "/cam/image_raw") is False


def test_falls_back_to_name_when_topic_absent_from_graph() -> None:
    node = _FakeNode({})  # topic has no publisher yet
    assert _is_compressed_topic(node, "/cam/image_raw/compressed") is True
    assert _is_compressed_topic(node, "/cam/depth/compressedDepth") is True
    assert _is_compressed_topic(node, "/cam/image_raw") is False


def test_name_fallback_when_discovery_raises() -> None:
    class _Boom:
        def get_topic_names_and_types(self):
            raise RuntimeError("graph unavailable")

    assert _is_compressed_topic(_Boom(), "/x/compressed") is True
    assert _is_compressed_topic(_Boom(), "/x/raw") is False
