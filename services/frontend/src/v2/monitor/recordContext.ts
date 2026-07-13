// Pure helpers for the Monitor context strip's REAL recording-state chip (no
// fabricated episode numbering). Derives the chip from /record/status — the same
// source the Live tab's RecordHero uses. Kept separate from the component so the
// active/elapsed derivation is unit-testable.

import type { RecordStatus } from '../../api/types';

// Only recording/stopping is an actually-running session — matching the
// recorder's _ACTIVE_STATES (and LiveTab's ACTIVE_STATES). `created`/`completed`/
// `failed` are idle → STANDBY.
const ACTIVE_STATES = new Set(['recording', 'stopping']);

export interface RecordContext {
  recording: boolean;
  runId: string | null;
  /** ms since capture start (recorder-stamped started_at), or null when idle /
   *  no baseline reported. */
  elapsedMs: number | null;
}

export function computeRecordContext(
  status: RecordStatus | undefined,
  nowMs: number,
): RecordContext {
  const recording = !!status && ACTIVE_STATES.has(status.state);
  if (!recording) return { recording: false, runId: null, elapsedMs: null };
  const startedAt = status?.started_at ? Date.parse(status.started_at) : NaN;
  const elapsedMs = Number.isNaN(startedAt) ? null : Math.max(0, nowMs - startedAt);
  return { recording: true, runId: status?.run_id ?? null, elapsedMs };
}

export function formatElapsed(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
