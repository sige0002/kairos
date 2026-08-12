// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Maps a set of terminal job outcomes (one per target capture submitted
// together, e.g. "Run on selection" against "All captures on this host") onto
// the design mock's OK / WARNING / FAIL tiles + stacked ratio bar + per-capture
// rows.
//
// The mock's "per-episode" rows assume many results from one submission — that
// only exists here when a job was submitted per capture in a batch. A
// single-capture submission has exactly one outcome and one summary.json, which
// carries far richer pipeline-specific detail than three buckets can show, so
// the screen renders the generic SummaryResult for it instead (see
// ValidationScreen / ResultsPanel: `hasEpisodeBreakdown` gates the choice).
//
// This stays pipeline-agnostic on purpose (docs/specs/ja/dora_plugins.md's "UI
// non-dependent contract"): it only reads the loose `result` / `metrics.coverage`
// convention any summary.json may or may not provide, never a pipeline-specific
// field.
import type { Summary } from '../../features/validation/SummaryResult';

// CANCELED is deliberately its OWN tone rather than a shade of FAIL: the
// operator stopped the job, and reporting their own decision back to them as
// a failure is how a screen loses the right to be believed about real ones.
// It is counted in none of the three tiles (see tileCounts) — a job that was
// stopped produced no verdict to bucket.
export type OutcomeTone = 'OK' | 'WARNING' | 'FAIL' | 'CANCELED';

/** A required topic from a fast_validation template (name + optional msg type). */
export interface RequiredTopic {
  name: string;
  type?: string | null;
}

export interface ChecklistRow extends RequiredTopic {
  found: boolean;
}

export interface Checklist {
  rows: ChecklistRow[];
  found: number;
  total: number;
  extraCount: number;
  pass: boolean;
}

/** Read an array of `{name, type}` topics from a loose summary field. */
function topicsFrom(value: unknown): RequiredTopic[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (t): t is RequiredTopic => typeof t === 'object' && t !== null && 'name' in t,
  );
}

/**
 * Build the fast_validation required-topic checklist from a job summary and the
 * template's declared required topics. The summary only reports `missing`/`extra`
 * (see services/dora_runner/.../validation.py), so the full `required` list is
 * threaded in to render the found (✓) rows too; if the template couldn't be
 * resolved we degrade to just the missing rows.
 */
export function buildChecklist(
  summary: Summary | undefined,
  required: RequiredTopic[],
): Checklist {
  const missing = topicsFrom(summary?.missing);
  const missingNames = new Set(missing.map((m) => m.name));
  const base = required.length > 0 ? required : missing;
  const rows: ChecklistRow[] = base.map((t) => ({
    name: t.name,
    type: t.type,
    found: !missingNames.has(t.name),
  }));
  return {
    rows,
    found: Math.max(0, rows.length - missing.length),
    total: rows.length,
    extraCount: topicsFrom(summary?.extra).length,
    pass: summary?.result === 'pass',
  };
}

export interface EpisodeOutcome {
  /** The capture the job ran on — its report lives at
   *  `report/<pipeline>/<capture_id>/` (contract §10.5). */
  captureId: string;
  /** What to call that capture on screen. Absent when the capture is not in the
   *  loaded catalog page, in which case the row shows the capture_id itself. */
  label?: string;
  /** The job never produced a clean verdict (orchestration failure / errored
   *  fetching its result) — distinct from the pipeline itself reporting fail. */
  orchestrationFailed?: boolean;
  /** The operator cancelled this job. Takes precedence over every other signal:
   *  a cancelled job also fails to produce a result, and reading THAT as the
   *  outcome would report the cancellation as a fault. */
  canceled?: boolean;
  summary?: Summary;
}

export interface EpisodeRow {
  captureId: string;
  label?: string;
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
  if (outcome.canceled) return 'CANCELED';
  if (outcome.orchestrationFailed) return 'WARNING';
  const result = outcome.summary?.result;
  if (result === 'pass') return 'OK';
  if (result === 'fail') return 'FAIL';
  return 'WARNING';
}

/** Only a multi-capture batch has enough outcomes for a meaningful breakdown. */
export function hasEpisodeBreakdown(outcomes: EpisodeOutcome[]): boolean {
  return outcomes.length > 1;
}

export function mapEpisodeRows(outcomes: EpisodeOutcome[]): EpisodeRow[] {
  return outcomes.map((o) => ({
    captureId: o.captureId,
    label: o.label,
    tone: toneOf(o),
    coverage: coverageOf(o.summary),
  }));
}

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 1000) / 10;
}

/** How many of these rows were cancelled. Kept OUT of TileCounts so the three
 *  tiles keep meaning "of the jobs that produced a verdict"; the panel prints
 *  this beside them so the numbers still add up on screen. */
export function canceledCount(rows: EpisodeRow[]): number {
  return rows.filter((r) => r.tone === 'CANCELED').length;
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
