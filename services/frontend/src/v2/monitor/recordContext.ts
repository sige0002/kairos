// Pure helpers for the Monitor context strip's REAL recording-state chip (no
// fabricated episode numbering). Derives the chip from /record/status — the same
// source Collect uses. Kept separate from the component so the active/elapsed
// derivation is unit-testable.

import type { RecordStatusView } from '../captures/useRecordStatus';

export interface RecordContext {
  recording: boolean;
  /** The live capture's identity — the key every other surface uses (§1). */
  captureId: string | null;
  /** `run_YYYYMMDD_HHMMSS`, DISPLAY ONLY (§1): never used as a key, and the
   *  orchestrator may even rewrite it to break a collision. */
  runId: string | null;
  /** ms since capture start (recorder-stamped started_at), or null when idle /
   *  no baseline reported. */
  elapsedMs: number | null;
  /**
   * True when we actually KNOW what is live — the recorder answered and named
   * its live set.
   *
   * False covers both an answer without `live_capture_ids` (§10 rev.2.4) and a
   * poll that failed outright. Neither may render as "nothing is recording":
   * that is a claim, and we have not verified it.
   */
  liveKnown: boolean;
}

export function computeRecordContext(
  view: RecordStatusView,
  nowMs: number,
): RecordContext {
  // A stale payload proves nothing, so an unreachable recorder yields the same
  // "we cannot tell" shape as an answer with no live set — never a REC chip
  // counting up from a start that ended long ago.
  const liveKnown = view.reachable && view.live !== null;
  if (!view.recording) {
    return { recording: false, captureId: null, runId: null, elapsedMs: null, liveKnown };
  }
  const startedAt = view.status?.started_at ? Date.parse(view.status.started_at) : NaN;
  const elapsedMs = Number.isNaN(startedAt) ? null : Math.max(0, nowMs - startedAt);
  return {
    recording: true,
    captureId: view.captureId,
    runId: view.status?.run_id ?? null,
    elapsedMs,
    liveKnown,
  };
}

export function formatElapsed(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
