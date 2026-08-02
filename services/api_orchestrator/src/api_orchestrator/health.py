"""The store's opinion of its own condition, shared across the process.

Contract §8 (rebuild reporting) and §9-3 (the SUSPECT latch). Three facts have
to be visible to request handlers, to the background reconciler and to
``GET /api/v1/store/health`` at once, and none of them belongs in the database:

* **SUSPECT** — the reconciler saw more copies vanish in one pass than it is
  willing to believe (§9-3), so it stopped applying missing-transitions, stopped
  the reaper and stopped digests. It *latches*: re-firing every pass would turn
  one storage incident into a log flood, and the operator's Repair action is the
  only thing that clears it.
* **delete availability** — objects/, .trash/ and .incoming/ turned out not to
  share a filesystem (§2), so the trash rename would be a cross-device copy.
  Deletion is withdrawn rather than silently degraded.
* **the last rebuild** — what it found, what it could not parse, what it warned
  about. A rebuild that quietly dropped three unreadable manifests is exactly
  the situation an operator must be able to see without reading logs.

Kept deliberately in memory: all three describe *this process's* view of the
disk, and persisting them would let a stale row outlive the condition it
describes. A restart re-derives every one of them.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any

from kairos_common.time import utc_now_iso8601


@dataclass
class RebuildReport:
    """What one rebuild pass concluded, for the health endpoint."""

    at: str
    captures: int = 0
    replicas: int = 0
    deferred: tuple[str, ...] = ()
    corrupt: tuple[dict[str, Any], ...] = ()
    warnings: tuple[str, ...] = ()
    # Why the rebuild ran at all: no database, wrong schema version, or an
    # explicit request. Shown so "why did my catalog change" has an answer.
    trigger: str = "startup"

    def summary(self) -> dict[str, Any]:
        return {
            "trigger": self.trigger,
            "at": self.at,
            "captures": self.captures,
            "replicas": self.replicas,
            "deferred": list(self.deferred),
            "corrupt_count": len(self.corrupt),
            "warning_count": len(self.warnings),
        }


class StoreHealth:
    """Process-wide store condition. Every method is safe from any thread."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._suspect = False
        self._suspect_reason: str | None = None
        self._suspect_at: str | None = None
        self._delete_reason: str | None = None
        self._rebuild: RebuildReport | None = None
        self._last_reconcile: dict[str, Any] | None = None
        self._last_reconcile_at: str | None = None
        # The most recent COMPLETE corrupt-sidecar observation from a reconciler
        # pass. ``None`` until one has run, at which point it supersedes the
        # startup rebuild's list — see :meth:`snapshot`.
        self._reconcile_corrupt: tuple[dict[str, Any], ...] | None = None
        self._corrupt_observed_at: str | None = None
        self.instance_id: str | None = None

    # ---- SUSPECT (§9-3) ----------------------------------------------------

    @property
    def suspect(self) -> bool:
        return self._suspect

    @property
    def suspect_reason(self) -> str | None:
        return self._suspect_reason

    def latch_suspect(self, reason: str) -> bool:
        """Enter SUSPECT. ``False`` = it was already latched.

        The return value is what keeps the log honest: the first pass that
        trips the threshold says so loudly, and the twenty passes after it stay
        quiet about a condition nobody has acted on yet.
        """
        with self._lock:
            if self._suspect:
                return False
            self._suspect = True
            self._suspect_reason = reason
            self._suspect_at = utc_now_iso8601()
            return True

    def clear_suspect(self) -> None:
        """Leave SUSPECT after an operator-confirmed repair."""
        with self._lock:
            self._suspect = False
            self._suspect_reason = None
            self._suspect_at = None

    # ---- deletion availability (§2) ---------------------------------------

    @property
    def delete_available(self) -> bool:
        return self._delete_reason is None

    @property
    def delete_unavailable_reason(self) -> str | None:
        return self._delete_reason

    def disable_deletes(self, reason: str) -> None:
        with self._lock:
            self._delete_reason = reason

    # ---- rebuild + reconcile reporting ------------------------------------

    def record_rebuild(self, report: RebuildReport) -> None:
        with self._lock:
            self._rebuild = report

    @property
    def rebuild(self) -> RebuildReport | None:
        return self._rebuild

    def record_reconcile(
        self,
        summary: dict[str, Any],
        *,
        corrupt: tuple[dict[str, Any], ...] | None = None,
    ) -> None:
        """Record what a reconciler pass concluded.

        *corrupt* is the pass's complete corrupt-sidecar observation, and
        ``None`` means "this pass made no valid observation" — a marker
        mismatch, or an unreadable ledger — which must NOT be mistaken for
        "nothing is corrupt any more". Only a real scan replaces what we hold.
        """
        with self._lock:
            self._last_reconcile = summary
            self._last_reconcile_at = utc_now_iso8601()
            if corrupt is not None:
                self._reconcile_corrupt = corrupt
                self._corrupt_observed_at = self._last_reconcile_at

    def snapshot(self) -> dict[str, Any]:
        """Everything ``GET /api/v1/store/health`` reports.

        ``corrupt`` is deliberately ONE list rather than a rebuild list beside
        a reconciler list. A client asking "what is broken?" wants one answer,
        and both passes are complete scans of the same directory — so the newer
        observation replaces the older rather than being merged with it. Merging
        would double-report a sidecar both passes saw, and keeping only the
        startup list would leave a manifest that went bad an hour ago invisible
        (§8 rule 4 requires corruption to be *reported*, and a report nobody can
        reach is not one).

        ``corrupt_source`` and ``corrupt_observed_at`` say which pass produced
        the list and when, so "no corruption" from a scan five seconds ago reads
        differently from the same answer at boot three days back.
        """
        with self._lock:
            rebuild = self._rebuild
            reconciled = self._reconcile_corrupt
            from_reconcile = reconciled is not None
            corrupt = list(
                reconciled if from_reconcile else (rebuild.corrupt if rebuild else ())
            )
            return {
                "corrupt_source": ("reconcile" if from_reconcile else "rebuild")
                if (from_reconcile or rebuild)
                else None,
                "corrupt_observed_at": (
                    self._corrupt_observed_at
                    if from_reconcile
                    else (rebuild.at if rebuild else None)
                ),
                "instance_id": self.instance_id or "",
                "state": "suspect" if self._suspect else "ok",
                "suspect_reason": self._suspect_reason,
                "suspect_at": self._suspect_at,
                "delete_available": self._delete_reason is None,
                "delete_unavailable_reason": self._delete_reason,
                "rebuilt_at": rebuild.at if rebuild else None,
                "rebuild_summary": rebuild.summary() if rebuild else None,
                "corrupt": corrupt,
                "warnings": list(rebuild.warnings) if rebuild else [],
                "last_reconcile_at": self._last_reconcile_at,
                "last_reconcile": self._last_reconcile,
            }


@dataclass
class SuspectGuardResult:
    """The §9-3 threshold decision for one reconciler pass."""

    applied: bool
    reason: str | None = None
    missing: int = 0
    denominator: int = 0
    threshold: int = 0
    details: dict[str, Any] = field(default_factory=dict)


def missing_threshold(denominator: int) -> int:
    """§9-3's ceiling: ``max(5, 10% of this instance's present replicas)``.

    The floor of 5 is what makes the rule usable on a small store: ten percent
    of four captures is zero, and a threshold of zero would refuse every
    ordinary single deletion. The percentage is what makes it usable on a large
    one, where five vanishing files really can be routine.
    """
    return max(5, denominator // 10)
