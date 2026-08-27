// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Ranked loss-event table under the integrity timeline (signal_report v1.1).
// Lists every topic's inferred loss events (topic / time / duration / est. lost
// / severity) RANKED worst-first — majors before minors, longer before shorter —
// so the reviewer reads the events that matter without wading through dozens of
// near-identical minor hiccups; beyond the first few, the rest fold behind an
// explicit "Show all" (the count stays visible — nothing is silently hidden).
// Clicking a row seeks the synced video the same way a timeline bin does. Below
// the events, nonzero per-topic edges (started late / ended early) render as two
// subtle rows, and a truncation note appears when any topic's list was capped.
// Honest empty state when no losses were detected.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type LossRow,
  type SignalReportExt,
  collectEdgeRows,
  collectLossRows,
  formatNsShort,
  formatSecondsShort,
  totalLossTruncated,
} from './signalReport';

const SEVERITY_CLASS: Record<'major' | 'minor', string> = {
  major: 'text-status-danger-text',
  minor: 'text-status-warning-text',
};

// Events shown before the fold: enough to read every major on a typical run
// without letting a flood of minors bury the table.
const ROWS_SHOWN = 8;

/** Worst first: majors before minors, longer duration first within a severity. */
export function rankLossRows(rows: LossRow[]): LossRow[] {
  return [...rows].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'major' ? -1 : 1;
    return b.duration_ns - a.duration_ns;
  });
}

export function LossEventList({
  report,
  onSeekGlobal,
}: {
  report: SignalReportExt;
  onSeekGlobal: (globalNs: number) => void;
}) {
  const { t } = useTranslation('review');
  const [showAll, setShowAll] = useState(false);
  const allRows = rankLossRows(collectLossRows(report));
  const rows = showAll ? allRows : allRows.slice(0, ROWS_SHOWN);
  const folded = allRows.length - rows.length;
  const edges = collectEdgeRows(report);
  const truncated = totalLossTruncated(report);

  return (
    <div className="flex flex-col gap-1" data-testid="review-loss-events">
      {rows.length === 0 && (
        <p className="text-[11px] text-text-muted" data-testid="review-loss-empty">
          {t('lossNone')}
        </p>
      )}

      {(rows.length > 0 || edges.length > 0) && (
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.03em] text-text-muted">
              <th className="py-0.5 pr-2 font-medium">{t('lossTopic')}</th>
              <th className="py-0.5 pr-2 font-medium">{t('lossTime')}</th>
              <th className="py-0.5 pr-2 font-medium">{t('lossDuration')}</th>
              <th className="py-0.5 pr-2 font-medium">{t('lossEstimated')}</th>
              <th className="py-0.5 font-medium">{t('lossSeverity')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`loss-${i}`}
                data-testid="review-loss-row"
                onClick={() => onSeekGlobal(r.start_ns)}
                className="cursor-pointer border-t border-border hover:bg-surface-muted"
              >
                <td className="py-0.5 pr-2 font-mono text-text-secondary">{r.topic}</td>
                <td className="py-0.5 pr-2 font-mono text-text-muted">
                  {formatSecondsShort(r.start_ns)}
                </td>
                <td className="py-0.5 pr-2 font-mono text-text-muted">
                  {formatNsShort(r.duration_ns)}
                </td>
                <td className="py-0.5 pr-2 font-mono text-text-muted">
                  {r.estimated_lost}
                </td>
                <td className={`py-0.5 font-semibold ${SEVERITY_CLASS[r.severity]}`}>
                  {r.severity}
                </td>
              </tr>
            ))}
            {edges.map((e, i) => (
              <tr
                key={`edge-${i}`}
                data-testid="review-loss-edge"
                onClick={() => onSeekGlobal(e.globalNs)}
                className="cursor-pointer border-t border-border text-text-muted hover:bg-surface-muted"
              >
                <td className="py-0.5 pr-2 font-mono">{e.topic}</td>
                <td className="py-0.5 pr-2 font-mono">
                  {formatSecondsShort(e.globalNs)}
                </td>
                <td className="py-0.5 pr-2 font-mono">{formatNsShort(e.durationNs)}</td>
                <td className="py-0.5 pr-2">—</td>
                <td className="py-0.5 italic">
                  {e.kind === 'start_delay'
                    ? t('lossStartedLate')
                    : t('lossEndedEarly')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(folded > 0 || showAll) && (
        <button
          type="button"
          data-testid="review-loss-show-all"
          aria-expanded={showAll}
          onClick={() => setShowAll((v) => !v)}
          className="self-start text-[11px] text-text-muted underline decoration-dotted transition-colors hover:text-text-secondary"
        >
          {showAll
            ? t('lossShowFewer')
            : t('lossShowAll', {
                total: String(allRows.length),
                folded: String(folded),
              })}
        </button>
      )}

      {truncated > 0 && (
        <p
          className="text-[10.5px] text-text-muted"
          data-testid="review-loss-truncated"
        >
          {t('lossTruncated', { count: truncated })}
        </p>
      )}
    </div>
  );
}
