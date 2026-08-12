"""The shared export-name contract (§6.2): compose to exactly what validates."""

from __future__ import annotations

from kairos_common.export_names import (
    EXPORT_SEGMENT_MAX_LEN,
    is_valid_export_segment,
    sanitize_export_segment,
)


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
