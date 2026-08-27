# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Fetch an exact, checksummed Kokoro model subset during image build."""

# ruff: noqa: E501 -- full SHA-256 values stay visually auditable on one line.

from __future__ import annotations

import hashlib
import os
import sys
import urllib.request
from pathlib import Path

REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
BASE_URL = f"https://huggingface.co/hexgrad/Kokoro-82M/resolve/{REVISION}"
FILES = {
    "config.json": "5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f",
    "kokoro-v1_0.pth": "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4",
    "voices/af_bella.pt": "8cb64e02fcc8de0327a8e13817e49c76c945ecf0052ceac97d3081480e8e48d6",
    "voices/af_heart.pt": "0ab5709b8ffab19bfd849cd11d98f75b60af7733253ad0d67b12382a102cb4ff",
    "voices/am_michael.pt": "9a443b79a4b22489a5b0ab7c651a0bcd1a30bef675c28333f06971abbd47bd37",
    "voices/bf_emma.pt": "d0a423deabf4a52b4f49318c51742c54e21bb89bbbe9a12141e7758ddb5da701",
    "voices/jf_alpha.pt": "1bf4c9dc69e45ee46183b071f4db766349aac5592acbcfeaf051018048a5d787",
    "voices/jf_gongitsune.pt": "1b171917f18f351e65f2bf9657700cd6bfec4e65589c297525b9cf3c20105770",
    "voices/jf_nezumi.pt": "d83f007a7f01783b77014561a7d493d327a0210e143440e91c9b697590d27661",
    "voices/jf_tebukuro.pt": "0d6917904438aec85f73a6fa1f7ac2be6481aae47c697834936930a91796c576",
    "voices/jm_kumo.pt": "98340afd68b1cee84fe0cd95528cfa6d4b39e416aa75a9df64049d52c8b55896",
}


def fetch(destination: Path) -> None:
    """Download the model subset and reject any byte drift."""
    for relative, expected in FILES.items():
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(f"{target.suffix}.part")
        digest = hashlib.sha256()
        request = urllib.request.Request(
            f"{BASE_URL}/{relative}", headers={"User-Agent": "kairos-model-build/1"}
        )
        with (
            urllib.request.urlopen(request, timeout=600) as response,
            temporary.open("wb") as output,
        ):
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != expected:
            temporary.unlink(missing_ok=True)
            raise RuntimeError(f"checksum mismatch for {relative}")
        os.replace(temporary, target)


if __name__ == "__main__":
    fetch(Path(sys.argv[1]))
