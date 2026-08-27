# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Pure guards around the heavyweight Kokoro runtime."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from kairos_kokoro.runtime import reject_unknown_english, terminate_process


def test_known_english_phonemes_are_accepted() -> None:
    reject_unknown_english(
        "ɹəkˈɔɹdɪŋ.",
        [SimpleNamespace(text="Recording", phonemes="ɹəkˈɔɹdɪŋ")],
    )


def test_unknown_english_token_is_rejected_instead_of_silently_dropped() -> None:
    tokens = [SimpleNamespace(text="bazquux", phonemes=None)]

    with pytest.raises(ValueError, match="bazquux"):
        reject_unknown_english("\ue000.", tokens)


def test_worker_termination_escalates_when_sigterm_is_ignored() -> None:
    class StubbornProcess:
        def __init__(self) -> None:
            self.alive = True
            self.calls: list[object] = []

        def is_alive(self) -> bool:
            return self.alive

        def terminate(self) -> None:
            self.calls.append("terminate")

        def kill(self) -> None:
            self.calls.append("kill")
            self.alive = False

        def join(self, timeout: float) -> None:
            self.calls.append(("join", timeout))

    process = StubbornProcess()

    terminate_process(process, timeout=0.25)

    assert process.calls == ["terminate", ("join", 0.25), "kill", ("join", 0.25)]
