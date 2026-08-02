// Pure helpers for the Monitor context strip's REAL recording-state chip (no
// fabricated episode numbering). Derives the chip from /record/status — the same
// source Collect uses. Kept separate from the component so the active/elapsed
// derivation is unit-testable.

import { liveCaptureIds, type RecordStatus } from '../../api/types';

// Only recording/stopping is a capture that is actually being WRITTEN, matching
// the recorder's own _ACTIVE_STATES. `armed` is deliberately excluded: a
// prepared session holds subscriptions but has written nothing, and showing REC
// for it would claim data that does not exist.
const ACTIVE_STATES = new Set(['recording', 'stopping']);

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
   * True when the status response carried `live_capture_ids` at all.
   *
   * §10 rev.2.4: a response WITHOUT that array is an unreachable or too-old
   * recorder, not an empty live set. The two must not render the same, because
   * "nothing is recording" is a claim, and we have not verified it.
   */
  liveKnown: boolean;
}

export function computeRecordContext(
  status: RecordStatus | undefined,
  nowMs: number,
): RecordContext {
  const liveKnown = liveCaptureIds(status) !== null;
  const recording = !!status && ACTIVE_STATES.has(status.state);
  if (!recording) {
    return { recording: false, captureId: null, runId: null, elapsedMs: null, liveKnown };
  }
  const startedAt = status?.started_at ? Date.parse(status.started_at) : NaN;
  const elapsedMs = Number.isNaN(startedAt) ? null : Math.max(0, nowMs - startedAt);
  // The singular capture_id is read only behind the live-state guard above: on
  // its own it is NOT a liveness signal (§10 — it keeps naming the last capture
  // after a stop), which is the same rule the orchestrator follows when it
  // pairs `_capture_id_of` with `_recorder_is_active`.
  return {
    recording: true,
    captureId: status?.capture_id ?? null,
    runId: status?.run_id ?? null,
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
