#!/usr/bin/env bash
# dora executes *.py node paths with the SYSTEM python (ignoring the venv, so
# `import dora` / `import httpx` fail). Exec the venv python instead -- the
# supported bypass, identical to the grayscale example and kairos's own nodes.
exec /opt/venv/bin/python /example/range_check_node.py
