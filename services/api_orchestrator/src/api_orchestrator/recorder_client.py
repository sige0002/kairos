# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Internal HTTP client for the rosbag2_recorder service.

The orchestrator drives the recorder over its internal API (``/record/start``,
``/record/stop``, ``/record/disarm``, ``/record/status``, ``/record/metadata``,
``/healthz``). On
host networking the recorder binds the host, so the base URL is
``http://localhost:{recorder_port}`` (see ``config.md``).

Transport policy follows ``api_orchestrator.md``: a 3s timeout and one retry
for start/status/metadata (inherited from :class:`BaseServiceClient`); ``stop``
is the exception — it uses a longer :data:`STOP_TIMEOUT_S` budget (no retry)
because the recorder's clean flush of a large bag can take ~30s. When the
recorder is unreachable or errors, the failure surfaces to clients as a ``503``
(or the recorder's own 4xx) in the unified ``{error:{...}}`` shape.

The client takes an injected :class:`httpx.AsyncClient`, so tests can supply a
``MockTransport`` without touching the network.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import httpx
from kairos_common.ids import is_uuid7

from api_orchestrator.service_client import (
    DEFAULT_TIMEOUT_S,
    RETRIES,
    BaseServiceClient,
)

__all__ = [
    "DEFAULT_TIMEOUT_S",
    "LIVE_CAPTURE_IDS_FIELD",
    "PREPARE_TIMEOUT_S",
    "RETRIES",
    "START_TIMEOUT_S",
    "STOP_TIMEOUT_S",
    "RecorderClient",
    "live_capture_ids",
]

# The one field on ``/record/status`` and ``/record/stop`` that says which
# captures the recorder is holding. Pinned by contract §10 (rev.2.3) and named
# here so a rename breaks one constant and its test, not three call sites.
LIVE_CAPTURE_IDS_FIELD = "live_capture_ids"


def live_capture_ids(status: Mapping[str, Any]) -> set[str] | None:
    """Captures the recorder is holding, or ``None`` if it did not say.

    This array is the **only** liveness signal (§10 rev.2.3). It is non-empty
    for ``armed``, ``recording`` and ``stopping``, and empty otherwise — and
    critically it includes ARMED captures, whose ``objects/<id>/`` exists with
    no manifest yet. A rebuild that missed those would see a manifest-less
    directory and either refuse to adopt it or, worse, treat a live arm as an
    orphan.

    Two distinctions this function exists to preserve:

    **An empty array is an answer; a missing array is not.** ``[]`` means the
    recorder is genuinely idle, and callers may act on it. An absent or
    non-list field means the recorder is too old or too broken to say, which
    §8 rule 1 treats as unreachable — so ``None`` propagates and callers DEFER
    rather than normalizing live recordings to ``interrupted``.

    **The singular ``capture_id`` is not a liveness signal and is never read
    here.** It deliberately keeps naming the last capture after that capture
    reaches a terminal state, so folding it in would mark every just-finished
    recording as recorder-held forever: §9-4(b) would block its digest until
    the next recording started, and a rebuild would live-exclude it so no row
    was ever created.
    """
    value = status.get(LIVE_CAPTURE_IDS_FIELD)
    if not isinstance(value, list):
        return None
    return {item for item in value if is_uuid7(item)}


# POST /record/stop is special: the recorder's stop now escalates
# SIGINT (30s) -> SIGTERM (30s) -> SIGKILL (5s), so a stop that has to walk
# the whole chain returns after ~65s — and it is still a SUCCESSFUL stop
# (finalised as interrupted). The orchestrator must wait the chain out: a
# shorter timeout 503s while the recorder is correctly escalating, the console
# shows a failure for a stop that lands seconds later, and the final-state
# re-sync never runs. One long attempt, no retry (stop is idempotent).
STOP_TIMEOUT_S = 75.0

# POST /record/start now blocks while the recorder applies start_delay_s AND
# (for --start-paused) waits for subscriptions to match before resuming
# (subscription_ready_timeout_s). This is the FLOOR budget (correct for the
# default config waits), with NO retry: a slow-but-succeeding start must not
# be retried into a 409. RecordService passes a larger budget derived from the
# live config when its waits exceed the defaults (S2-3, `_start_budget_s`).
START_TIMEOUT_S = 25.0

# POST /record/prepare spawns the recorder subprocess ahead of the operator's
# start action and blocks through the same spawn + DDS discovery/subscription
# match latency that /record/start absorbs today (see START_TIMEOUT_S), so it
# shares that budget. NO retry, and deliberately not attempted automatically
# even on a slow prepare: retrying would just spawn and arm a second session
# for no benefit — an abandoned prepare (this one, or the one being retried
# over) auto-disarms on the recorder's own timeout regardless, so there is
# nothing a client-side retry here would recover.
PREPARE_TIMEOUT_S = START_TIMEOUT_S


class RecorderClient(BaseServiceClient):
    """Thin async wrapper over the recorder's internal HTTP API.

    Args:
        base_url: Recorder base URL (e.g. ``http://localhost:8010``).
        client: An :class:`httpx.AsyncClient` (injected so tests can mock the
            transport). The caller owns its lifecycle.
        timeout_s: Per-request timeout in seconds.
        retries: Number of retries after the first attempt (1 = two attempts).
    """

    def __init__(
        self,
        base_url: str,
        client: httpx.AsyncClient,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        retries: int = RETRIES,
    ) -> None:
        super().__init__(
            "recorder", base_url, client, timeout_s=timeout_s, retries=retries
        )

    async def start(
        self, payload: dict[str, Any], *, timeout_s: float | None = None
    ) -> dict[str, Any]:
        """Call recorder ``POST /record/start``; returns the recorder body.

        No retry — the recorder blocks during the start delay + the
        --start-paused readiness gate, and retrying a slow-but-succeeding
        start would hit a 409. ``timeout_s`` lets the caller pass a budget
        derived from the live config's own waits (S2-3);
        :data:`START_TIMEOUT_S` is the floor default.
        """
        return await self._request(
            "POST",
            "/record/start",
            json=payload,
            timeout=timeout_s if timeout_s is not None else START_TIMEOUT_S,
            retries=0,
        )

    async def prepare(
        self, payload: dict[str, Any], *, timeout_s: float | None = None
    ) -> dict[str, Any]:
        """Call recorder ``POST /record/prepare``; returns the recorder body.

        Same body shape as :meth:`start`. Returns ``{run_id, state: "armed",
        arming, disarm_at}`` (or the recorder's own error, e.g. ``409`` if it
        is already actively recording). Same budget semantics as :meth:`start`
        (config-derived ``timeout_s``, else :data:`PREPARE_TIMEOUT_S`), with
        no retry — see that constant's docstring for why retrying is not done.
        """
        return await self._request(
            "POST",
            "/record/prepare",
            json=payload,
            timeout=timeout_s if timeout_s is not None else PREPARE_TIMEOUT_S,
            retries=0,
        )

    async def stop(self) -> dict[str, Any]:
        """Call recorder ``POST /record/stop`` (idempotent on the recorder).

        Uses the longer :data:`STOP_TIMEOUT_S` budget (no retry) so a large
        bag's flush has time to finish; start/status keep the 3s + retry policy.
        """
        return await self._request(
            "POST", "/record/stop", timeout=STOP_TIMEOUT_S, retries=0
        )

    async def disarm_if_armed(self, expected_capture_id: str) -> dict[str, Any]:
        """Atomically disarm one exact unstarted recorder session.

        The recorder returns ``disarmed: false`` with its current status when
        the expected capture already started or changed; it never routes that
        outcome through the broad recording stop operation.
        """
        return await self._request(
            "POST",
            "/record/disarm",
            json={"expected_capture_id": expected_capture_id},
            timeout=STOP_TIMEOUT_S,
            retries=0,
        )

    async def status(self) -> dict[str, Any]:
        """Call recorder ``GET /record/status``.

        Returns the recorder's status body verbatim (no response model), so any
        additive recorder field — e.g. the ``arming`` snapshot (OL-①.4) — flows
        straight through to callers and the ``/api/v1/record/status`` proxy.
        """
        return await self._request("GET", "/record/status")

    async def preflight(self) -> dict[str, Any]:
        """Run recorder start preconditions without starting a recording."""
        return await self._request("GET", "/record/preflight")

    async def metadata(self) -> dict[str, Any]:
        """Call recorder ``GET /record/metadata`` (last run's metadata)."""
        return await self._request("GET", "/record/metadata")
