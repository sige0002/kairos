# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Wire encoding is shared across live clients and replay of the same event."""

import asyncio
import gc
import json
import weakref
from unittest.mock import patch

from api_orchestrator.events import Event, EventHub


def test_live_fanout_and_replay_encode_once() -> None:
    async def scenario() -> None:
        hub = EventHub(monitor=None)  # type: ignore[arg-type]
        subscriptions = [hub.subscribe() for _ in range(4)]
        pending = [asyncio.create_task(sub.__anext__()) for sub in subscriptions]
        await asyncio.sleep(0)
        event = await hub.publish("metrics", {"value": None, "label": "\u00e9"})
        received = await asyncio.gather(*pending)
        with patch("api_orchestrator.events.json.dumps", wraps=json.dumps) as dumps:
            frames = [item.encode() for item in received]
            replay = hub._replay_since(event.id - 1)
            assert replay[0].encode() == frames[0]
            assert all(frame is frames[0] for frame in frames)
            dumps.assert_called_once()
        assert frames[0] == (
            f"id: {event.id}\nevent: metrics\n"
            'data: {"value":null,"label":"\\u00e9"}\n\n'
        )
        for sub in subscriptions:
            await sub.aclose()

    asyncio.run(scenario())


def test_encoding_cache_does_not_retain_evicted_events() -> None:
    event = Event(1, "job", {"value": 1}, 0.0)
    event.encode()
    reference = weakref.ref(event)
    del event
    gc.collect()
    assert reference() is None
