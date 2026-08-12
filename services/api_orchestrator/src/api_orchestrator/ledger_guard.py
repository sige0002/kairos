# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""One place that turns an unwritable ledger into a ``503 ledger_unwritable``.

Contract §5: every ledger append is fatal to the operation it precedes. Deletes,
archives, dataset edits and batch edits each had their own copy of the same
three lines — append, catch ``OSError``, raise 503 — and the copies are what let
one of them quietly stop matching the rule.

What each caller keeps is the only part that legitimately differs: **what the
operator is told was not done.** "The dataset change was not applied" and "the
source was NOT deleted; remove the copy or retry" are different instructions to
a human, so the message stays with the code that knows which one is true, and is
passed in as a function of the ``OSError`` rather than a fixed string.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from kairos_common import ApiError, ledger_v2


def append_or_503(
    data_dir: str | Path,
    kind: str,
    *,
    instance_id: str,
    payload: dict[str, Any] | None = None,
    capture_id: str | None = None,
    failure: Callable[[OSError], str],
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Append a lifecycle event, or raise ``503 ledger_unwritable``.

    Returns the appended event. *failure* builds the operator-facing message
    from the ``OSError``; *details* rides along on the error so a client can name
    the capture or dataset that did not change.
    """
    try:
        return ledger_v2.append_with_slack_release(
            data_dir,
            kind,
            instance_id=instance_id,
            capture_id=capture_id,
            payload=payload,
        )
    except OSError as exc:
        raise ApiError(
            status_code=503,
            code="ledger_unwritable",
            message=failure(exc),
            details=details,
        ) from exc
