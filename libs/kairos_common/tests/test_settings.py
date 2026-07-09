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
