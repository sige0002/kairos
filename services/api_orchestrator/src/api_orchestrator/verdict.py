# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Capture verdict (§ validation gating): what validation says about a capture.

The problem this exists for: validation was a side channel. A capture could
fail ``full_validation``, keep sitting at GOOD, get adopted, land in a dataset
and be archived — because the verdict lived in a JSON file nobody opened, and
nothing downstream consulted it. A validator whose output cannot change what
happens to the data is a diary, not a gate.

Two deliberate design choices:

**The verdict is DERIVED, never stored.** It is computed from the pipeline
reports already on disk under ``report/<pipeline>/<capture_id>/summary.json``,
which the store's §8 rebuild does not own and cannot lose. Caching it in a
column would create a second truth that drifts the moment a validator re-runs.

**The override IS stored** — it is a human decision, not a derivation. It rides
the capture row (so a dataset add can consult it in one read) and the lifecycle
ledger (so "who let this through, and why" survives the row). Never-validated
is ``unknown``, not a pass: silence is not evidence.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

# Pipelines whose verdict gates adoption, in the order they are reported.
# fast_validation alone in v1: it is the one every capture gets, and its
# question ("are the required topics there at all") is the cheapest real
# failure. Adding a pipeline here makes it gating — a deliberate act.
GATING_PIPELINES: tuple[str, ...] = ("fast_validation",)


class Verdict(StrEnum):
    """What validation currently says about a capture.

    ``unknown`` is not a soft pass: it means no gating pipeline has reported,
    so nothing has been checked. The UI must show it as its own state.
    """

    unknown = "unknown"
    passed = "pass"
    needs_review = "needs_review"


def verdict_of(reports: dict[str, dict[str, Any] | None]) -> Verdict:
    """Fold the gating pipelines' summaries into one verdict.

    *reports* maps pipeline id → its ``summary.json`` (or ``None`` when it has
    not run). Any explicit failure wins over any pass — one broken required
    topic is not cancelled out by another check succeeding.
    """
    seen_pass = False
    for pipeline in GATING_PIPELINES:
        summary = reports.get(pipeline)
        if not isinstance(summary, dict):
            continue
        result = summary.get("result")
        if result == "fail":
            return Verdict.needs_review
        if result == "pass":
            seen_pass = True
    return Verdict.passed if seen_pass else Verdict.unknown


def blocks_adoption(verdict: Verdict, override_reason: str | None) -> bool:
    """Whether this capture may NOT join a dataset as things stand.

    Only a real failure blocks, and only until somebody overrides it on the
    record. ``unknown`` does not block: v1 gates on evidence of breakage, not
    on the absence of evidence — blocking every never-validated capture would
    stop a deployment that runs no validators at all from building any dataset,
    which is a different (and much bigger) product decision.
    """
    return verdict is Verdict.needs_review and not override_reason
