"""Transport fixes: IPv6 candidate filtering + RTP packet-max patch.

Pure logic — no live aiortc peer needed. Mirrors the field-verified behaviour
ported from webrtc_streamer (Tailscale MTU / IPv6 black-hole mitigations).
"""

from __future__ import annotations

import pytest
from dora_live.webrtc_peer import apply_rtp_packet_max, drop_ipv6_candidates

_SDP = "\r\n".join(
    [
        "v=0",
        "m=video 9 UDP/TLS/RTP/SAVPF 97",
        "c=IN IP4 0.0.0.0",
        "a=candidate:1 1 udp 2130706431 192.168.60.160 57620 typ host",
        "a=candidate:2 1 udp 2130706431 100.69.60.105 46257 typ host",
        "a=candidate:3 1 udp 2130706431 fd7a:115c:a1e0::ab01:3c8e 40469 typ host",
        "a=candidate:4 1 udp 2130706431 172.17.0.1 37880 typ host",
        "a=end-of-candidates",
        "",
    ]
)


def test_drops_ipv6_keeps_ipv4() -> None:
    out = drop_ipv6_candidates(_SDP)
    assert "fd7a:115c:a1e0::ab01:3c8e" not in out
    assert "100.69.60.105" in out
    assert "192.168.60.160" in out
    assert "172.17.0.1" in out
    assert out.count("a=candidate:") == 3


def test_preserves_non_candidate_lines_and_trailing_crlf() -> None:
    out = drop_ipv6_candidates(_SDP)
    assert out.startswith("v=0\r\n")
    assert "c=IN IP4 0.0.0.0" in out
    assert "a=end-of-candidates" in out
    assert out.endswith("\r\n")


def test_keep_ipv6_env_disables_filter(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEBRTC_KEEP_IPV6", "1")
    assert "fd7a:115c:a1e0::ab01:3c8e" in drop_ipv6_candidates(_SDP)


def test_no_candidates_is_noop() -> None:
    sdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 97\r\nc=IN IP4 0.0.0.0\r\n"
    assert drop_ipv6_candidates(sdp) == sdp


def test_apply_rtp_packet_max_is_safe_and_configurable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Never raises, whatever aiortc's presence; an invalid value is tolerated.
    apply_rtp_packet_max()
    monkeypatch.setenv("WEBRTC_PACKET_MAX", "not-an-int")
    apply_rtp_packet_max()
    monkeypatch.setenv("WEBRTC_PACKET_MAX", "1200")
    apply_rtp_packet_max()
    # If aiortc is installed, the patch actually landed on the codec module.
    vpx = pytest.importorskip("aiortc.codecs.vpx")
    assert vpx.PACKET_MAX == 1200
