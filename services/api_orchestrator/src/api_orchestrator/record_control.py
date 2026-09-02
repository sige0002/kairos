# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""In-memory browser control leases for an active recording.

This is deliberately *not* authentication.  Kairos remains a trusted-LAN
console; the lease simply prevents a second browser from accidentally sending
the ordinary Stop for a take another browser started.  The opaque value lives
in an HttpOnly session cookie and is bound to one ``capture_id``.

Leases are process-local on purpose.  After an orchestrator restart ownership
is unknown rather than silently attributed to whichever browser still has an
old cookie.  The public takeover and force-stop routes are the explicit
recovery paths for that situation.
"""

from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass

from kairos_common import ApiError

CONTROL_COOKIE = "kairos_record_control"


@dataclass(frozen=True)
class RecordControl:
    """The one active browser-control lease, if this process issued one."""

    capture_id: str
    token: str


class RecordControlService:
    """Issue and validate a single opaque controller token.

    The recorder itself permits only one active capture.  Keeping one lease
    here therefore matches the physical lifecycle and makes takeover a token
    rotation rather than a second authority channel.
    """

    def __init__(self) -> None:
        self._control: RecordControl | None = None
        # Serializes control admission with takeover/force-stop.  A normal Stop
        # keeps this lock until the recorder lifecycle has admitted it, giving
        # the three control operations one deterministic total order.
        self.operation_lock = asyncio.Lock()

    def issue_for_start(self, capture_id: str) -> str:
        """Make the starting browser the controller for ``capture_id``."""
        token = secrets.token_urlsafe(32)
        self._control = RecordControl(capture_id=capture_id, token=token)
        return token

    def take_over(self, capture_id: str) -> str:
        """Rotate control to the browser that explicitly requested takeover."""
        return self.issue_for_start(capture_id)

    def status(self, capture_id: str | None, token: str | None) -> dict[str, object]:
        """Return only truthful control state for the currently reported take."""
        control = self._control
        if capture_id is None:
            return {
                "capture_id": None,
                "controlled_by_this_client": False,
                "lease_known": False,
            }
        if control is None or control.capture_id != capture_id:
            return {
                "capture_id": capture_id,
                "controlled_by_this_client": False,
                "lease_known": False,
            }
        return {
            "capture_id": capture_id,
            "controlled_by_this_client": secrets.compare_digest(
                control.token, token or ""
            ),
            "lease_known": True,
        }

    def require(self, capture_id: str, token: str | None) -> None:
        """Fail closed unless this exact browser owns this exact capture."""
        control = self._control
        if control is None:
            raise ApiError(
                status_code=409,
                code="record_control_recovery_required",
                message=(
                    "Recording control is unavailable after a server restart. "
                    "Confirm takeover or use emergency stop."
                ),
                details={"capture_id": capture_id},
            )
        if control.capture_id != capture_id:
            raise ApiError(
                status_code=409,
                code="record_control_capture_mismatch",
                message="This browser control token belongs to a different recording.",
                details={"capture_id": capture_id},
            )
        if not token or not secrets.compare_digest(control.token, token):
            raise ApiError(
                status_code=409,
                code="record_control_token_invalid",
                message=(
                    "This browser does not control this recording. Confirm takeover "
                    "before stopping it."
                ),
                details={"capture_id": capture_id},
            )

    def clear_if(self, capture_id: str) -> None:
        """Forget a finished lease without touching a newer capture's lease."""
        if self._control is not None and self._control.capture_id == capture_id:
            self._control = None
