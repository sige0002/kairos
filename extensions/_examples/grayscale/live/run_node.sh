#!/usr/bin/env bash
# dora executes *.py node paths with the SYSTEM python (venv ignored) — exec
# the venv python instead; same bypass kairos's own nodes use.
exec /opt/venv/bin/python node.py
