// Maps a set of terminal job outcomes (one per target run submitted together,
// e.g. "Run on selection" against "All completed runs") onto the design mock's
// OK / WARNING / FAIL tiles + stacked ratio bar + per-run rows.
//
// The mock's "per-episode" rows assume many results from one submission — that
// only exists here when a job was submitted per target run in a batch. A
// single-run submission has exactly one outcome and one summary.json, which
// carries far richer pipeline-specific detail than three buckets can show, so
// the screen renders the generic SummaryResult for it instead (see
// ValidationScreen / ResultsPanel: `hasEpisodeBreakdown` gates the choice).
//
// This stays pipeline-agnostic on purpose (docs/specs/ja/dora_plugins.md's "UI
// non-dependent contract"): it only reads the loose `result` / `metrics.coverage`
// convention any summary.json may or may not provide, never a pipeline-specific
// field.
import type { Summary } from '../../features/validation/SummaryResult';

export type OutcomeTone = 'OK' | 'WARNING' | 'FAIL';

export interface EpisodeOutcome {
  runId: string;
  /** The job never produced a clean verdict (orchestration failure / errored
   *  fetching its result) — distinct from the pipeline itself reporting fail. */
  orchestrationFailed?: boolean;
  summary?: Summary;
}

export interface EpisodeRow {
  runId: string;
  tone: OutcomeTone;
  /** 0-100, when the summary exposes a coverage-like metric; else null. */
  coverage: number | null;
}

export interface TileCounts {
  ok: number;
  warning: number;
  fail: number;
  total: number;
  okPct: number;
  warningPct: number;
  failPct: number;
}

/** Pull a 0-100 coverage number from the loose summary contract, if present. */
function coverageOf(summary: Summary | undefined): number | null {
  if (!summary) return null;
  const metrics = summary.metrics;
  const candidate =
    typeof summary.coverage === 'number'
      ? summary.coverage
      : typeof metrics === 'object' && metrics !== null && 'coverage' in metrics
        ? (metrics as Record<string, unknown>).coverage
        : undefined;
  return typeof candidate === 'number' ? candidate : null;
}

function toneOf(outcome: EpisodeOutcome): OutcomeTone {
  if (outcome.orchestrationFailed) return 'WARNING';
  const result = outcome.summary?.result;
  if (result === 'pass') return 'OK';
  if (result === 'fail') return 'FAIL';
  return 'WARNING';
}

/** Only a multi-run batch has enough outcomes for a meaningful breakdown. */
export function hasEpisodeBreakdown(outcomes: EpisodeOutcome[]): boolean {
  return outcomes.length > 1;
}

export function mapEpisodeRows(outcomes: EpisodeOutcome[]): EpisodeRow[] {
  return outcomes.map((o) => ({
    runId: o.runId,
    tone: toneOf(o),
    coverage: coverageOf(o.summary),
  }));
}

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 1000) / 10;
}

export function tileCounts(rows: EpisodeRow[]): TileCounts {
  const ok = rows.filter((r) => r.tone === 'OK').length;
  const warning = rows.filter((r) => r.tone === 'WARNING').length;
  const fail = rows.filter((r) => r.tone === 'FAIL').length;
  const total = rows.length;
  return {
    ok,
    warning,
    fail,
    total,
    okPct: pct(ok, total),
    warningPct: pct(warning, total),
    failPct: pct(fail, total),
  };
}
