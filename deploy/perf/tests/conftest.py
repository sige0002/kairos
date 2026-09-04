"""Test bootstrap for the standalone, standard-library performance harness."""

from __future__ import annotations

import sys
from pathlib import Path

PERF_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PERF_DIR))
