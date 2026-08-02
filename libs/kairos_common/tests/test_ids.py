"""UUIDv7: valid by RFC 9562, and sortable by the order it was minted in."""

from __future__ import annotations

import uuid

import pytest
from kairos_common import ids


def _freeze(monkeypatch, unix_ms: int, *, last_ms: int | None = None) -> None:
    """Pin the clock *and* the minter's memory of it.

    The counter state is a module global that earlier calls have already
    advanced, so a test that only patched the clock would be measuring whatever
    the previous test left behind.
    """
    monkeypatch.setattr("time.time_ns", lambda: unix_ms * 1_000_000)
    monkeypatch.setattr(ids, "_last_ms", unix_ms - 1 if last_ms is None else last_ms)
    monkeypatch.setattr(ids, "_counter", 0)


def test_uuid7_is_canonical_and_carries_version_and_variant() -> None:
    value = ids.uuid7()

    assert ids.is_uuid7(value)
    parsed = uuid.UUID(value)
    assert parsed.version == 7
    # RFC 4122 variant: the two top bits of the clock-seq octet are 0b10.
    assert (parsed.int >> 62) & 0b11 == 0b10
    assert str(parsed) == value  # lowercase, hyphenated, no braces


def test_ids_sort_in_the_order_they_were_minted() -> None:
    """The reason v7 was chosen: "oldest first" is the string sort of the key,
    so a capture list, a ledger and a member list all order without a join."""
    minted = [ids.uuid7() for _ in range(2000)]

    assert minted == sorted(minted)
    assert len(set(minted)) == len(minted)


def test_ordering_survives_a_frozen_clock(monkeypatch) -> None:
    """Within one millisecond randomness alone would order arbitrarily. The
    rand_a counter is what keeps event_ids in agreement with the ledger's own
    line order."""
    _freeze(monkeypatch, 1_700_000_000_000)

    minted = [ids.uuid7() for _ in range(500)]

    assert minted == sorted(minted)
    assert len(set(minted)) == len(minted)


def test_more_than_4096_in_one_millisecond_borrows_instead_of_repeating(
    monkeypatch,
) -> None:
    """rand_a holds 4096 values. Overflowing it must not produce a duplicate or
    block the caller; the timestamp moves one millisecond ahead instead."""
    _freeze(monkeypatch, 1_700_000_000_000)

    minted = [ids.uuid7() for _ in range(5000)]

    assert len(set(minted)) == 5000
    assert minted == sorted(minted)
    assert ids.uuid7_timestamp_ms(minted[-1]) > ids.uuid7_timestamp_ms(minted[0])


def test_a_backwards_clock_never_lowers_the_timestamp(monkeypatch) -> None:
    """An NTP correction must not make new ids sort before older ones."""
    now_ms = 1_700_000_000_000
    _freeze(monkeypatch, now_ms)
    before = ids.uuid7()

    monkeypatch.setattr("time.time_ns", lambda: (now_ms - 60_000) * 1_000_000)
    after = ids.uuid7()

    assert after > before
    assert ids.uuid7_timestamp_ms(after) == now_ms  # the step back is not published


def test_uuid7_timestamp_ms_recovers_the_minting_time(monkeypatch) -> None:
    _freeze(monkeypatch, 1_700_000_000_123)

    assert ids.uuid7_timestamp_ms(ids.uuid7()) == 1_700_000_000_123


def test_is_uuid7_rejects_everything_that_is_not_one() -> None:
    """This is the guard that keeps a capture_id from becoming a path escape,
    so it must reject rather than normalise."""
    assert not ids.is_uuid7(str(uuid.uuid4()))  # right shape, wrong version
    assert not ids.is_uuid7(ids.uuid7().upper())  # case is part of the identity
    assert not ids.is_uuid7("../../etc/passwd")
    assert not ids.is_uuid7("")
    assert not ids.is_uuid7(None)
    assert not ids.is_uuid7(uuid.uuid4())  # a UUID object is not the string form


def test_uuid7_timestamp_ms_refuses_to_invent_a_time() -> None:
    with pytest.raises(ValueError):
        ids.uuid7_timestamp_ms(str(uuid.uuid4()))


def test_the_first_six_bytes_are_the_big_endian_millisecond(monkeypatch) -> None:
    """Checked against uuid's own parser rather than our extractor, so the two
    cannot agree on a layout that is not RFC 9562's: bits 127..80 hold
    unix_ts_ms, big-endian, and every other reader in the world will read them
    that way."""
    unix_ms = 1_700_000_000_123
    _freeze(monkeypatch, unix_ms)

    value = ids.uuid7()

    assert uuid.UUID(value).bytes[:6] == unix_ms.to_bytes(6, "big")


def test_the_named_id_minters_all_produce_uuid7() -> None:
    for mint in (
        ids.new_capture_id,
        ids.new_event_id,
        ids.new_membership_id,
        ids.new_dataset_id,
    ):
        assert ids.is_uuid7(mint())


def test_instance_id_is_uuid4_because_install_order_is_not_meaningful() -> None:
    value = ids.new_instance_id()

    assert uuid.UUID(value).version == 4
    assert not ids.is_uuid7(value)
