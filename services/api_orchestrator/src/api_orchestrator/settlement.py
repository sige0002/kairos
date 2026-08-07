"""The quick check settled once at stop, off the request path.

Contract §9-5 is what shapes this: stop must not depend on the ledger, a digest
or a rebuild, and it must not wait for anything slow. So the verdict is computed
*after* the response goes out, as a background task, and every input degrades
rather than failing — an unreachable monitor or an unreadable MCAP summary
narrows what the verdict can vouch for instead of withholding it.

Two layers, assembled by ``quick_check.py``. Layer 0 reads no bag at all: the
monitor's counters at stop minus the baseline taken at start, the incident ring
filtered to the recording's window, and the recorder's own integrity call. Layer
1 opens the MCAP for its *summary* only — per-channel counts, no message scan —
under a hard timeout, because a multi-GB bag on a busy disk must never hold a
settlement open.

The baseline is the reason this owns state rather than being a pure function.
The monitor reports counters cumulative since *it* started, so the only honest
per-recording figure is stop minus start — which means something has to hold the
start snapshot across the whole recording. It is taken at start, spent by the
settlement at stop, and dropped; a baseline left behind is one recording's worth
of per-topic counters held until the process exits.

Nothing here may raise. A settlement that crashed would take out the task that
owns it and leave a capture permanently without a verdict, so the whole body is
wrapped and reported to the log instead.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from kairos_common import ApiError, RecordingConfig
from kairos_common.time import parse_iso8601

from api_orchestrator.captures import CaptureService
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, Quality, ReviewSaveRequest
from api_orchestrator.monitor_client import MonitorClient
from api_orchestrator.quick_check import (
    assemble_quick_check,
    build_layer0,
    build_layer1,
    incidents_in_window,
    read_mcap_summary,
)
from api_orchestrator.store import CaptureStore

logger = logging.getLogger("kairos")

# ---- stop-time quick-check settlement budget ------------------------------
QUICK_CHECK_BUDGET_S = 4.0
_SETTLE_MONITOR_TIMEOUT_S = 1.2
_SETTLE_MCAP_TIMEOUT_S = 1.5
_BASELINE_TIMEOUT_S = 1.0


@dataclass
class MonitorBaseline:
    """Per-topic monitor counters snapshotted at record START.

    The monitor's ``dds_samples_lost``/``messages_total`` are cumulative since
    the monitor started, so the honest per-recording figure is stop minus this.
    Best-effort: absent when the monitor was unreachable, and the quick check
    then reports the raw cumulative value rather than a wrong difference.
    """

    captured_ns: int
    dds_samples_lost: dict[str, int] = field(default_factory=dict)
    messages_total: dict[str, int] = field(default_factory=dict)


class SettlementRunner:
    """Owns the baselines, the background tasks and the settlement itself.

    Three collaborators are passed as callables rather than taken from the
    objects they live on, and all three are resolved **at call time**:

    * *monitor_metric_topics* and *reconcile* route back through
      :class:`RecordService`'s own methods. Both are part of that object's
      surface — one is a monitor accessor it shares with the status path, the
      other ends in ``CaptureService.save_review`` — and a caller that replaces
      either on the instance must see it honoured here, which a bound method
      captured at construction would not do.
    * *write_quick_check* is resolved through ``record_service``'s module
      namespace for the same reason: that is where the name is patched, and
      importing it directly here would silently escape the substitution.
    """

    def __init__(
        self,
        store: CaptureStore,
        layout: DataLayout,
        captures: CaptureService,
        *,
        monitor: MonitorClient | None,
        config: Callable[[], RecordingConfig | None],
        monitor_metric_topics: Callable[[], Awaitable[list[dict[str, Any]] | None]],
        reconcile: Callable[..., Awaitable[None]],
        write_quick_check: Callable[[Path, dict[str, Any]], None],
    ) -> None:
        self._store = store
        self._layout = layout
        self._captures = captures
        self._monitor = monitor
        self._config = config
        self._monitor_metric_topics = monitor_metric_topics
        self._reconcile = reconcile
        self._write_quick_check = write_quick_check
        self.baselines: dict[str, MonitorBaseline] = {}
        self.tasks: set[asyncio.Task[None]] = set()

    # ---- baseline (taken at start) -----------------------------------------

    async def capture_baseline(self, capture_id: str) -> None:
        """Snapshot cumulative monitor counters at record start (best-effort)."""
        baseline = await self._read_baseline()
        if baseline is not None:
            self.baselines[capture_id] = baseline

    async def _read_baseline(self) -> MonitorBaseline | None:
        if self._monitor is None:
            return None
        try:
            body = await self._monitor.metrics(timeout=_BASELINE_TIMEOUT_S, retries=0)
        except ApiError:
            return None
        dds: dict[str, int] = {}
        msgs: dict[str, int] = {}
        for topic in body.get("topics") or []:
            if not isinstance(topic, dict):
                continue
            name = topic.get("name")
            if not isinstance(name, str):
                continue
            if (value := _coerce_int(topic.get("dds_samples_lost"))) is not None:
                dds[name] = value
            if (value := _coerce_int(topic.get("messages_total"))) is not None:
                msgs[name] = value
        return MonitorBaseline(
            captured_ns=time.time_ns(), dds_samples_lost=dds, messages_total=msgs
        )

    # ---- the settlement (fired at stop) ------------------------------------

    def schedule(
        self,
        capture: Capture,
        *,
        integrity: str | None,
        backstop: str | None,
        stop_ns: int | None,
    ) -> None:
        """Fire the quick-check settlement as a background task (never blocks)."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        task = loop.create_task(
            self.settle(
                capture, integrity=integrity, backstop=backstop, stop_ns=stop_ns
            )
        )
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def settle(
        self,
        capture: Capture,
        *,
        integrity: str | None,
        backstop: str | None,
        stop_ns: int | None,
    ) -> None:
        """Compute the two-layer quick check and persist it on the capture.

        ``stop_ns`` is ``None`` only when the end stamp could not be read; the
        incident window then keeps every incident instead of filtering on a
        bound nobody knows.
        """
        started = time.monotonic()
        capture_id = capture.capture_id
        config = self._config()
        try:
            baseline = self.baselines.pop(capture_id, None)
            topic_names = [t.name for t in capture.topics]
            start_ns = iso_to_ns(capture.started_at)

            monitor_topics = await self._monitor_metric_topics()
            incidents = await self._monitor_incidents()
            incidents_window = (
                incidents_in_window(incidents, start_ns, stop_ns)
                if incidents is not None
                else None
            )
            layer0 = build_layer0(
                integrity=integrity,
                backstop=backstop,
                monitor_topics=monitor_topics,
                baseline_dds=baseline.dds_samples_lost if baseline else None,
                incidents=incidents_window,
                topic_names=topic_names,
                config=config,
            )

            capture_dir = self._layout.capture_dir(capture_id)
            try:
                summary = await asyncio.wait_for(
                    asyncio.to_thread(read_mcap_summary, capture_dir),
                    timeout=_SETTLE_MCAP_TIMEOUT_S,
                )
            except (TimeoutError, OSError):
                summary = None
            required = topic_names or (list(config.default_topics) if config else [])
            layer1 = build_layer1(
                summary=summary, config=config, required_topics=required
            )

            elapsed_ms = int((time.monotonic() - started) * 1000)
            quick = assemble_quick_check(
                layer0=layer0,
                layer1=layer1,
                elapsed_ms=elapsed_ms,
                config=config,
            )
            # Which review, if any, already existed when this verdict landed.
            # Read immediately before the verdict becomes visible and with no
            # await in between, so it is exactly "the review that was saved
            # without a verdict in hand" — the only one this settlement is
            # entitled to second-guess (see reconcile_quality).
            existing = self._store.get_capture(capture_id)
            revision_at_verdict = existing.review_revision if existing else 0
            # Sidecar first, then the row — §8's ordering, because the row is an
            # index of what is on disk. Without the file this verdict was the
            # one thing in the store that "delete kairos.db and restart" could
            # not bring back (E-17), and its absence renders as an empty space
            # rather than as a loss.
            try:
                await asyncio.to_thread(
                    self._write_quick_check, capture_dir, quick.model_dump(mode="json")
                )
            except OSError as exc:
                # Not fatal and not silent. The verdict still reaches the row,
                # so this session is unaffected; what is lost is durability
                # across a rebuild, and that is worth a line in the log rather
                # than withholding a verdict the operator is waiting for.
                logger.warning(
                    "quick_check settled but its sidecar could not be written; "
                    "this verdict will not survive a catalog rebuild",
                    extra={"capture_id": capture_id, "error": str(exc)},
                )
            self._store.update_capture(capture_id, quick_check=quick)
            logger.info(
                "quick_check settled",
                extra={
                    "capture_id": capture_id,
                    "quality": quick.verdict.quality,
                    "elapsed_ms": elapsed_ms,
                },
            )
            await self._reconcile(
                capture_id,
                quick.verdict.quality,
                revision_at_verdict=revision_at_verdict,
            )
        except Exception:  # noqa: BLE001 - settlement must never crash the app
            logger.exception(
                "quick_check settlement failed", extra={"capture_id": capture_id}
            )

    # ---- the follow-up correction ------------------------------------------

    async def reconcile_quality(
        self,
        capture_id: str,
        quality: Quality,
        *,
        revision_at_verdict: int | None = None,
    ) -> None:
        """Correct a review that was saved before this verdict landed.

        A review saved during settlement derives its quality from a verdict that
        does not exist yet and falls back to a conservative ``needs_review``.
        Once the real verdict is in, that value is corrected — but only when the
        quality is still ``quick_check``-sourced: an operator's own call is a
        human decision and is never overwritten.

        The STATUS is corrected with it, but ONLY for a review that predates the
        verdict. Collect stamps ``adopted`` from the quality its result panel was
        showing, and with no verdict to show that is the fallback good — so a
        Save that beat the settlement adopted data this server then called
        ``needs_review``. Correcting only the quality left the two halves of one
        row contradicting each other, and the status is the half that has
        consequences: ``adopted`` puts the capture in Review's READY lane, which
        is by design the lane nobody looks at, and makes it dataset-eligible.
        Such a capture goes back to ``pending`` — NEEDS CHECK, where "Mark OK —
        include" is the deliberate human confirmation.

        *revision_at_verdict* is what keeps that from eating a real decision.
        Review's "Mark OK — include" sends ``{review_status: adopted}`` and
        nothing else, so it arrives looking exactly like Collect's fast save:
        same fields, same ``quick_check`` quality source. The one thing that
        differs is WHEN it was written — before this verdict existed (a guess)
        or after it landed (a judgement about a verdict the operator could
        actually see). Only the settlement knows where that line falls, so it
        passes the review revision as of the moment the verdict became visible;
        a review written after it, or touched since, is left alone. Without that
        evidence — any other caller — nothing is ever demoted, because demoting
        a decision nobody can prove was a guess is the worse mistake.

        The correction goes through the ordinary §4.1 path, revision bump and
        all. A client that then sees a 409 is seeing the truth: the review it
        was holding is no longer current.
        """
        try:
            capture = self._store.get_capture(capture_id)
            if capture is None or capture.review_revision == 0:
                return
            if capture.quality_source != "quick_check":
                return
            # Not `elif`: the status can need correcting even when the quality
            # does not. The conservative fallback IS ``needs_review``, so a
            # verdict confirming it changes no quality at all — and that is
            # exactly the case where an ``adopted`` was banked on a guess.
            fields: dict[str, Any] = {
                "base_revision": capture.review_revision,
                "quality": quality,
                "quality_source": "quick_check",
            }
            predates_verdict = (
                revision_at_verdict is not None
                and revision_at_verdict > 0
                and capture.review_revision == revision_at_verdict
            )
            demote = (
                predates_verdict
                and quality != "good"
                and capture.review_status == "adopted"
            )
            if demote:
                fields["review_status"] = "pending"
            if capture.quality == quality and not demote:
                return
            await self._captures.save_review(
                capture_id, ReviewSaveRequest(**fields), system=True
            )
            logger.info(
                "review re-derived from the settled quick_check",
                extra={
                    "capture_id": capture_id,
                    "quality": quality,
                    "review_status": fields.get("review_status", capture.review_status),
                },
            )
        except ApiError as exc:
            # A 409 here means an operator edited the review while we settled.
            # Their call wins; nothing to repair.
            logger.info(
                "quality reconcile skipped",
                extra={"capture_id": capture_id, "code": exc.code},
            )
        except Exception:  # noqa: BLE001 - never crash the settlement
            logger.exception(
                "quality reconcile failed", extra={"capture_id": capture_id}
            )

    # ---- monitor reads ------------------------------------------------------

    async def monitor_metric_topics(self) -> list[dict[str, Any]] | None:
        if self._monitor is None:
            return None
        try:
            body = await self._monitor.metrics(
                timeout=_SETTLE_MONITOR_TIMEOUT_S, retries=0
            )
        except ApiError:
            return None
        topics = body.get("topics")
        return topics if isinstance(topics, list) else None

    async def _monitor_incidents(self) -> list[dict[str, Any]] | None:
        """The whole incident ring, filtered to the window on this side.

        ``since_ns=0`` deliberately: the monitor's own filter is one-sided, so
        scoping the fetch to the recording start would MISS an incident that
        fired before the recording began and stayed open across the whole
        window — exactly the incident that matters most.
        """
        if self._monitor is None:
            return None
        try:
            body = await self._monitor.incidents(
                0, timeout=_SETTLE_MONITOR_TIMEOUT_S, retries=0
            )
        except ApiError:
            return None
        items = body.get("incidents")
        return items if isinstance(items, list) else None

    # ---- shutdown -----------------------------------------------------------

    async def drain(self) -> None:
        """Await in-flight settlements (shutdown / test determinism)."""
        tasks = list(self.tasks)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def _coerce_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return None


def iso_to_ns(value: str | None) -> int | None:
    parsed = parse_iso8601(value)
    if parsed is None:
        return None
    return int(parsed.timestamp() * 1_000_000_000)
