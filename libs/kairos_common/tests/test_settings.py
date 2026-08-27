# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Settings parsing — focus on WEBRTC_ICE_SERVERS.

WEBRTC_ICE_SERVERS lives in the SHARED Settings that every service loads, so a
blank or malformed value must degrade to ``[]`` (no ICE) rather than raise and
take the whole stack down. ``_env_file=None`` keeps a repo-root ``.env`` from
leaking into the assertions.
"""

from __future__ import annotations

import pytest
from kairos_common.settings import Settings


def _settings() -> Settings:
    return Settings(_env_file=None)


def test_ice_servers_unset_is_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WEBRTC_ICE_SERVERS", raising=False)
    assert _settings().webrtc_ice_servers == []


def test_ice_servers_blank_does_not_crash(monkeypatch: pytest.MonkeyPatch) -> None:
    # The crash vector: pydantic would try to JSON-decode "" and raise for every
    # service. NoDecode + the validator must turn it into [].
    monkeypatch.setenv("WEBRTC_ICE_SERVERS", "")
    assert _settings().webrtc_ice_servers == []
    monkeypatch.setenv("WEBRTC_ICE_SERVERS", "   ")
    assert _settings().webrtc_ice_servers == []


def test_ice_servers_malformed_degrades_to_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WEBRTC_ICE_SERVERS", "not-json{")
    assert _settings().webrtc_ice_servers == []


def test_ice_servers_non_list_json_degrades_to_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WEBRTC_ICE_SERVERS", '{"urls":"stun:x"}')
    assert _settings().webrtc_ice_servers == []


def test_ice_servers_valid_json_parses(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "WEBRTC_ICE_SERVERS",
        '[{"urls":["stun:stun.l.google.com:19302"]},'
        '{"urls":["turn:host:3478"],"username":"u","credential":"p"}]',
    )
    assert _settings().webrtc_ice_servers == [
        {"urls": ["stun:stun.l.google.com:19302"]},
        {"urls": ["turn:host:3478"], "username": "u", "credential": "p"},
    ]


def test_archive_roots_answers_to_its_documented_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """config.md and every archive_paths docstring say KAIROS_ARCHIVE_ROOTS.

    The field once answered only to ARCHIVE_ROOTS, so an operator who followed
    the documentation saw no archive control at all — found by E2E scenario 6.
    Both spellings must work; the documented one is the contract.
    """
    monkeypatch.setenv("KAIROS_ARCHIVE_ROOTS", "/mnt/nas:/mnt/backup")
    assert Settings().archive_roots == "/mnt/nas:/mnt/backup"

    monkeypatch.delenv("KAIROS_ARCHIVE_ROOTS")
    monkeypatch.setenv("ARCHIVE_ROOTS", "/mnt/other")
    assert Settings().archive_roots == "/mnt/other"

    # Direct construction (how every test builds Settings) keeps working too.
    monkeypatch.delenv("ARCHIVE_ROOTS")
    assert Settings(archive_roots="/direct").archive_roots == "/direct"
    assert Settings().archive_roots == ""


def test_tts_provider_and_voicevox_url_are_runtime_selectable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TTS_PROVIDER", "voicevox")
    monkeypatch.setenv("TTS_VOICEVOX_URL", "http://127.0.0.1:50021")

    settings = _settings()

    assert settings.tts_provider == "voicevox"
    assert settings.tts_voicevox_url == "http://127.0.0.1:50021"
