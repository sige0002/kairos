"""Real aiortc happy path: a client offer answered through AiortcPeerManager.

Skipped where aiortc/av are unavailable. Exercises the actual offer/answer
exchange (fresh RTCPeerConnection, track add, codec pin, ICE gather, IPv6 drop)
without needing cross-network ICE connectivity or media flow.
"""

from __future__ import annotations

import asyncio

import pytest

pytest.importorskip("aiortc")
pytest.importorskip("av")

from dora_live.webrtc_frame import LatestFrame  # noqa: E402
from dora_live.webrtc_models import Encoding  # noqa: E402
from dora_live.webrtc_peer import AiortcPeerManager  # noqa: E402


async def _roundtrip() -> tuple[str, str, int]:
    from aiortc import RTCPeerConnection

    frames: LatestFrame = LatestFrame()
    manager = AiortcPeerManager(frames, encoding=Encoding.vp8, max_fps=5)

    client = RTCPeerConnection()
    client.addTransceiver("video", direction="recvonly")
    offer = await client.createOffer()
    await client.setLocalDescription(offer)

    answer_sdp, answer_type = await manager.handle_offer(
        client.localDescription.sdp, client.localDescription.type
    )
    clients = manager.client_count()

    await client.close()
    await manager.close()
    return answer_sdp, answer_type, clients


def test_real_offer_is_answered() -> None:
    answer_sdp, answer_type, clients = asyncio.run(_roundtrip())
    assert answer_type == "answer"
    assert "m=video" in answer_sdp
    assert clients == 1
    # IPv6 candidates are filtered out of the answer (default policy).
    for line in answer_sdp.splitlines():
        body = line[2:] if line.startswith("a=") else line
        if body.startswith("candidate:"):
            parts = body.split()
            assert len(parts) < 5 or ":" not in parts[4]
