#!/usr/bin/env bash
# dora executes *.py node paths with the SYSTEM python (ignoring the venv, so
# `import dora` / `import cv2` fail) — the bench-proven pitfall documented in
# docs/specs/ja/dora_live.md. A shell wrapper that execs the venv python is
# the supported bypass; kairos's own nodes launch the same way.
exec /opt/venv/bin/python /example/grayscale_node.py
