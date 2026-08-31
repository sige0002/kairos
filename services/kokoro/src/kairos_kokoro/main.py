# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Process entry point for the Kokoro sidecar."""

from __future__ import annotations

import os
from pathlib import Path

import uvicorn

from kairos_kokoro.app import create_app
from kairos_kokoro.runtime import NativeKokoroRuntime


def main() -> None:
    """Load the pinned model before accepting requests."""
    runtime = NativeKokoroRuntime(Path(os.environ.get("KOKORO_MODEL_DIR", "/model")))
    uvicorn.run(
        create_app(runtime),
        host=os.environ.get("KOKORO_BIND", "0.0.0.0"),
        port=int(os.environ.get("KOKORO_PORT", "8050")),
        workers=1,
    )


if __name__ == "__main__":
    main()
