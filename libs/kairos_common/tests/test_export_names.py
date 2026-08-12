"""The shared export-name contract (§6.2): compose to exactly what validates."""

from __future__ import annotations

from kairos_common.export_names import (
    EXPORT_SEGMENT_MAX_LEN,
    compose_export_name,
    is_valid_export_segment,
    sanitize_export_segment,
)


class TestCompose:
    def test_a_normal_join_is_a_valid_name(self) -> None:
        assert compose_export_name("alice", "full", "beta1") == "alice_full_beta1"

    def test_empty_segments_are_dropped(self) -> None:
        assert compose_export_name("alice", "full", "") == "alice_full"

    def test_a_long_join_is_truncated_to_a_valid_name(self) -> None:
        # Each part is valid alone, but the JOIN would exceed the bound and the
        # exporter would reject it at submit — the F5 residual. The composed
        # name must satisfy the same contract the exporter enforces.
        name = compose_export_name("a" * 100, "b" * 100, "c" * 100)
        assert len(name) <= EXPORT_SEGMENT_MAX_LEN
        assert is_valid_export_segment(name)

    def test_truncation_does_not_leave_a_trailing_separator(self) -> None:
        name = compose_export_name("a" * 127, "bcd")
        assert not name.endswith(("_", ".", "-"))
        assert is_valid_export_segment(name)


class TestIsValid:
    def test_a_plain_name_is_valid(self) -> None:
        assert is_valid_export_segment("alice_full_beta1")

    def test_leading_non_alnum_is_invalid(self) -> None:
        # Dotfiles and ".." can never be addressed.
        assert not is_valid_export_segment(".hidden")
        assert not is_valid_export_segment("..")
        assert not is_valid_export_segment("-x")

    def test_separators_and_spaces_are_invalid(self) -> None:
        assert not is_valid_export_segment("a/b")
        assert not is_valid_export_segment("Alice Smith")
        assert not is_valid_export_segment("山田")

    def test_length_is_bounded(self) -> None:
        assert is_valid_export_segment("a" * EXPORT_SEGMENT_MAX_LEN)
        assert not is_valid_export_segment("a" * (EXPORT_SEGMENT_MAX_LEN + 1))
        assert not is_valid_export_segment("")


class TestSanitize:
    def test_sanitising_produces_a_valid_segment(self) -> None:
        # The whole point: whatever composition yields, the exporter accepts.
        for raw in ("Alice Smith", "café/run", "--weird--", "a b c"):
            out = sanitize_export_segment(raw, "fallback")
            assert is_valid_export_segment(out), (raw, out)

    def test_accents_fold_to_ascii(self) -> None:
        assert sanitize_export_segment("Ålëx", "fb") == "Alex"

    def test_spaces_become_single_underscores(self) -> None:
        assert sanitize_export_segment("Alice Smith", "fb") == "Alice_Smith"

    def test_a_name_with_nothing_ascii_falls_back(self) -> None:
        # Kanji drops to empty rather than a wall of underscores → fallback.
        assert sanitize_export_segment("山田", "mixed") == "mixed"
        assert sanitize_export_segment("", "mixed") == "mixed"
        assert sanitize_export_segment(None, "mixed") == "mixed"

    def test_length_is_capped(self) -> None:
        out = sanitize_export_segment("a" * 500, "fb")
        assert len(out) <= EXPORT_SEGMENT_MAX_LEN
        assert is_valid_export_segment(out)
