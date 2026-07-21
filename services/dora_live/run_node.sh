#!/usr/bin/env bash
# dora node launcher wrapper (bench-proven pattern).
#
# dora runs *.py node paths with the system python3, ignoring the /opt/venv
# interpreter — but our nodes need the venv (dora wheel + pyarrow + dora_live).
# Giving dora a plain executable (this .sh, NOT a .py) bypasses its python
# resolution; we exec the venv interpreter ourselves. The module to run comes
# from DORA_NODE_MODULE (set per node in the generated dataflow).
set -u
exec /opt/venv/bin/python -m "${DORA_NODE_MODULE:?DORA_NODE_MODULE not set}"
