"""Shared base for internal HTTP clients to other kairos services.

The orchestrator drives several internal services (recorder, topic_monitor,
webrtc_streamer) over HTTP on the host (host networking → ``localhost:<port>``).
They share one transport policy (``api_orchestrator.md``): a short timeout with
one retry, failures surfaced to clients as a unified ``503`` ``ApiError``;
genuine downstream 4xx pass through with their own status/code.

:class:`BaseServiceClient` holds that machinery, parameterized by a service
name so each client's error codes read naturally (``recorder_unreachable``,
``monitor_unreachable``, ...). Concrete clients add their own typed endpoint
methods. The :class:`httpx.AsyncClient` is injected so tests can supply a
``MockTransport`` without touching the network.
"""

from __future__ import annotations

from typing import Any

import httpx
from kairos_common import ApiError

# Default internal-call policy: a 3s timeout and exactly one retry.
DEFAULT_TIMEOUT_S = 3.0
RETRIES = 1
# Separate, shorter CONNECT budget: on a healthy LAN a TCP connect completes in
# milliseconds, so 1s only ever bites when the peer host is gone (robot powered
# off in the cross-host split) — turning each proxied call's failure from a
# ~3s-per-attempt hang into ~1s, while a slow RESPONSE still gets the full
# read timeout.
CONNECT_TIMEOUT_S = 1.0


class BaseServiceClient:
    """Common request/retry/error plumbing for an internal service client.

    Args:
        name: Short service name used in error codes (``"recorder"`` ->
            ``recorder_unreachable`` / ``recorder_error``).
        base_url: Service base URL (e.g. ``http://localhost:8001``).
        client: An injected :class:`httpx.AsyncClient` (the caller owns it).
        timeout_s: Per-request timeout in seconds.
        retries: Retries after the first attempt (1 = two attempts).
    """

    def __init__(
        self,
        name: str,
        base_url: str,
        client: httpx.AsyncClient,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        retries: int = RETRIES,
    ) -> None:
        self._name = name
        self._base_url = base_url.rstrip("/")
        self._client = client
        self._timeout = httpx.Timeout(
            timeout_s, connect=min(CONNECT_TIMEOUT_S, timeout_s)
        )
        self._retries = retries

    @property
    def base_url(self) -> str:
        """The service base URL (used for streaming endpoints)."""
        return self._base_url

    async def healthz(self) -> bool:
        """Return ``True`` if the service ``/healthz`` responds 2xx.

        Never raises: used by ``/readyz`` to classify each component.
        """
        try:
            await self._request("GET", "/healthz")
        except ApiError:
            return False
        return True

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        timeout: float | httpx.Timeout | None = None,
        retries: int | None = None,
    ) -> dict[str, Any]:
        """Send a request with retry, mapping failures to a unified error.

        Connection/timeout errors are retried (default once). A non-2xx response
        is surfaced as an :class:`ApiError`: genuine downstream 4xx pass through
        with their own status + code; downstream 5xx and transport failures
        become a unified ``503``. ``timeout`` / ``retries`` override the defaults
        for a single call.
        """
        url = f"{self._base_url}{path}"
        timeout = self._timeout if timeout is None else timeout
        retries = self._retries if retries is None else retries
        last_exc: httpx.HTTPError | None = None
        for _attempt in range(retries + 1):
            try:
                resp = await self._client.request(
                    method, url, json=json, timeout=timeout
                )
            except httpx.HTTPError as exc:
                # Transport-level failure (connect/read timeout, etc.): retry.
                last_exc = exc
                continue
            if resp.is_success:
                return self._decode(resp)
            # Non-2xx: do not retry; relay the service's status + error body.
            raise self._error_from_response(resp)

        # Exhausted retries on transport failures -> service unreachable.
        raise ApiError(
            status_code=503,
            code=f"{self._name}_unreachable",
            message=f"The {self._name} service is unreachable.",
            details={"cause": str(last_exc) if last_exc else "unknown"},
        )

    @staticmethod
    def _decode(resp: httpx.Response) -> dict[str, Any]:
        """Decode a successful JSON body, or ``{}`` for an empty 2xx."""
        if not resp.content:
            return {}
        body = resp.json()
        return body if isinstance(body, dict) else {"data": body}

    def _error_from_response(self, resp: httpx.Response) -> ApiError:
        """Translate a downstream non-2xx response into an :class:`ApiError`.

        Reuses the service's unified ``{error:{...}}`` body when present.
        Genuine client-errors (4xx) pass through with their own status; only
        downstream 5xx are masked as a unified ``503``.
        """
        code = f"{self._name}_error"
        message = f"The {self._name} reported an error."
        details: dict[str, Any] = {f"{self._name}_status": resp.status_code}
        try:
            body = resp.json()
        except ValueError:
            body = None
        if isinstance(body, dict) and isinstance(body.get("error"), dict):
            err = body["error"]
            code = str(err.get("code", code))
            message = str(err.get("message", message))
            if isinstance(err.get("details"), dict):
                details = {**err["details"], f"{self._name}_status": resp.status_code}
        status = resp.status_code if 400 <= resp.status_code < 500 else 503
        return ApiError(status_code=status, code=code, message=message, details=details)
