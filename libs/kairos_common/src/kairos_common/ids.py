# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""UUIDv7 identifiers: globally unique, and sortable by when they were minted.

Every durable v2 identity (capture_id, event_id, membership_id, dataset_id) is a
UUIDv7 per RFC 9562 — a 48-bit unix-millisecond prefix followed by randomness.
The prefix is the reason for the choice: a capture list, a ledger file and a
dataset's members all want "oldest first", and with v7 that is the *string* sort
of the primary key. A v4 id would force every such ordering through a separate
timestamp column, and would scatter B-tree inserts across the whole keyspace.

``instance_id`` stays UUIDv4 (:func:`new_instance_id`) because an installation's
identity carries no useful creation order, and leaking the install time of every
robot into an id that travels with exported data buys nothing.

**Monotonic within a millisecond.** Randomness alone would make two ids minted in
the same millisecond sort arbitrarily, and event_ids that sort out of order in
``lifecycle.jsonl`` would make the ledger's own "what happened last" reading
disagree with the file order. The 12 bits of ``rand_a`` therefore hold a counter
that resets each millisecond (RFC 9562 §6.2 method 2). Two consequences are
deliberate:

* a clock that steps **backwards** never lowers the published timestamp — the
  last one is reused and the counter advances instead, so ids stay increasing
  across an NTP correction;
* more than 4096 ids inside one millisecond borrow the *next* millisecond rather
  than blocking or repeating. The prefix is then a few ms ahead of the wall
  clock, which is the cheaper lie: uniqueness and ordering both survive it.

The counter is process-local. Two processes minting in the same millisecond order
arbitrarily against each other, which is the same guarantee a monotonic clock
would give across hosts, and nothing in the contract needs more.
"""

from __future__ import annotations

import os
import re
import threading
import time
import uuid

# Canonical form only: lowercase hex, hyphenated, version nibble 7, RFC 4122
# variant (10xx → 8/9/a/b). Uppercase or brace-wrapped spellings are rejected
# rather than normalised, so an id compares equal as a plain string everywhere
# (DB key, path segment, JSON field) without a parse step.
_UUID7_PATTERN = re.compile(
    r"\A[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z"
)

# rand_a is 12 bits (RFC 9562 §5.7): 4096 ids per millisecond before borrowing.
_MAX_COUNTER = 0xFFF

_lock = threading.Lock()
_last_ms = -1
_counter = 0


def _next_slot() -> tuple[int, int]:
    """Reserve the (timestamp, counter) pair for one id, never decreasing."""
    global _last_ms, _counter
    now_ms = time.time_ns() // 1_000_000
    with _lock:
        if now_ms > _last_ms:
            _last_ms = now_ms
            _counter = 0
        else:
            # Same millisecond, or the clock went backwards: keep the timestamp
            # already published and distinguish by the counter.
            _counter += 1
            if _counter > _MAX_COUNTER:
                _last_ms += 1
                _counter = 0
        return _last_ms, _counter


def uuid7() -> str:
    """Mint a UUIDv7 in canonical lowercase hyphenated form.

    Layout (RFC 9562 §5.7): 48-bit ``unix_ts_ms`` | 4-bit version ``7`` |
    12-bit ``rand_a`` (the monotonic counter) | 2-bit variant ``0b10`` |
    62-bit ``rand_b`` from :func:`os.urandom`.
    """
    unix_ts_ms, counter = _next_slot()
    rand_b = int.from_bytes(os.urandom(8), "big") & ((1 << 62) - 1)
    value = (
        ((unix_ts_ms & 0xFFFFFFFFFFFF) << 80)
        | (0x7 << 76)
        | (counter << 64)
        | (0b10 << 62)
        | rand_b
    )
    return str(uuid.UUID(int=value))


def is_uuid7(value: object) -> bool:
    """Whether *value* is a canonical UUIDv7 string.

    Used as an input guard wherever an id becomes a path segment: a capture_id
    that passes this cannot contain ``/`` or ``..``, so ``objects/<capture_id>``
    stays inside ``objects/``.
    """
    return isinstance(value, str) and _UUID7_PATTERN.match(value) is not None


def uuid7_timestamp_ms(value: str) -> int:
    """The unix-millisecond prefix encoded in a UUIDv7.

    Lets a caller order or age ids without a separate timestamp column. Raises
    ``ValueError`` if *value* is not a canonical UUIDv7 — a fabricated time is
    worse than no time.
    """
    if not is_uuid7(value):
        raise ValueError(f"not a UUIDv7: {value!r}")
    return uuid.UUID(value).int >> 80


def new_capture_id() -> str:
    """A capture's global identity (§1): path segment, DB PK, sidecar field."""
    return uuid7()


def new_event_id() -> str:
    """A lifecycle event's idempotency key (§1), used to replay a resume safely."""
    return uuid7()


def new_export_id() -> str:
    """A LeRobot export run's identity (§6.2): lease owner suffix, staging dir."""
    return uuid7()


def new_membership_id() -> str:
    """A dataset member's stable id (§1) — the URL/testid handle for one member."""
    return uuid7()


def new_dataset_id() -> str:
    """A logical dataset's id (§1). Datasets are rows plus ledger events, not dirs."""
    return uuid7()


def new_instance_id() -> str:
    """An installation's identity (§1): UUIDv4, minted once into instance.json."""
    return str(uuid.uuid4())
