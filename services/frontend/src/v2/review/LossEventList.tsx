// Compact loss-event table under the heatmap (signal_report v1.1). Lists every
// topic's inferred loss events (topic / time / duration / est. lost / severity),
// sorted by time; clicking a row seeks the same way a heatmap bin does. Below
// the events, nonzero per-topic edges (started late / ended early) render as two
// subtle rows, and a truncation note appears when any topic's list was capped.
// Honest empty state when no losses were detected.

import {
  type SignalReportExt,
  collectEdgeRows,
  collectLossRows,
  formatNsShort,
  formatSecondsShort,
  totalLossTruncated,
} from './signalReport';

const SEVERITY_CLASS: Record<'major' | 'minor', string> = {
  major: 'text-red-600',
  minor: 'text-amber-600',
};

export function LossEventList({
  report,
  onSeekGlobal,
}: {
  report: SignalReportExt;
  onSeekGlobal: (globalNs: number) => void;
}) {
  const rows = collectLossRows(report);
  const edges = collectEdgeRows(report);
  const truncated = totalLossTruncated(report);

  return (
    <div className="flex flex-col gap-1" data-testid="review-loss-events">
      {rows.length === 0 && (
        <p className="text-[11px] text-gray-500" data-testid="review-loss-empty">
          No losses detected — threshold 1.5× median interval.
        </p>
      )}

      {(rows.length > 0 || edges.length > 0) && (
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.03em] text-gray-400">
              <th className="py-0.5 pr-2 font-medium">Topic</th>
              <th className="py-0.5 pr-2 font-medium">Time</th>
              <th className="py-0.5 pr-2 font-medium">Duration</th>
              <th className="py-0.5 pr-2 font-medium">Est. lost</th>
              <th className="py-0.5 font-medium">Severity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`loss-${i}`}
                data-testid="review-loss-row"
                onClick={() => onSeekGlobal(r.start_ns)}
                className="cursor-pointer border-t border-gray-100 hover:bg-gray-50"
              >
                <td className="py-0.5 pr-2 font-mono text-gray-600">{r.topic}</td>
                <td className="py-0.5 pr-2 font-mono text-gray-500">
                  {formatSecondsShort(r.start_ns)}
                </td>
                <td className="py-0.5 pr-2 font-mono text-gray-500">
                  {formatNsShort(r.duration_ns)}
                </td>
                <td className="py-0.5 pr-2 font-mono text-gray-500">{r.estimated_lost}</td>
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
                className="cursor-pointer border-t border-gray-100 text-gray-400 hover:bg-gray-50"
              >
                <td className="py-0.5 pr-2 font-mono">{e.topic}</td>
                <td className="py-0.5 pr-2 font-mono">{formatSecondsShort(e.globalNs)}</td>
                <td className="py-0.5 pr-2 font-mono">{formatNsShort(e.durationNs)}</td>
                <td className="py-0.5 pr-2">—</td>
                <td className="py-0.5 italic">
                  {e.kind === 'start_delay' ? 'started late' : 'ended early'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {truncated > 0 && (
        <p className="text-[10.5px] text-gray-400" data-testid="review-loss-truncated">
          {truncated} more event{truncated === 1 ? '' : 's'} not shown (largest kept).
        </p>
      )}
    </div>
  );
}
