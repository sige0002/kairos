// Results column: renders the OK/WARNING/FAIL tiles + ratio bar + per-capture
// rows when the active submission was a batch (multiple target captures — see
// resultsMapping.ts for why that's the gate), otherwise falls back to the
// generic, pipeline-agnostic SummaryResult for a single-capture submission. That
// fallback is the point: a new plugin's summary.json renders here with no UI
// change required.
import { Card } from '../../components/ui';
import { SummaryResult, type Summary } from '../../features/validation/SummaryResult';
import { ChecklistCard } from './ChecklistCard';
import {
  hasEpisodeBreakdown,
  mapEpisodeRows,
  tileCounts,
  type EpisodeOutcome,
  type EpisodeRow,
  type RequiredTopic,
} from './resultsMapping';

const FAST_VALIDATION = 'fast_validation';

export interface ActiveOutcome {
  pipeline: string;
  outcomes: EpisodeOutcome[];
  allSettled: boolean;
  artifacts: string[];
  /** Present for fast_validation: the template's required topics, so the
   *  bespoke checklist can render found (✓) rows, not just the missing ones. */
  requiredTopics?: RequiredTopic[];
}

/**
 * fast_validation leads with its bespoke checklist — "are my required topics
 * there" is the question it exists to answer — but the generic card follows it
 * rather than replacing it. Since the port to bagflow, the summary also carries
 * the evidence behind that verdict (which node checked what, the bag's own
 * figures, the flow that ran), and hiding it meant a PASS was the least
 * inspectable outcome: exactly backwards, because a pass is what you most often
 * want to talk yourself into trusting.
 */
function DetailCard({
  pipeline,
  summary,
  artifacts,
  requiredTopics,
}: {
  pipeline: string;
  summary: Summary;
  artifacts?: string[];
  requiredTopics?: RequiredTopic[];
}) {
  if (pipeline === FAST_VALIDATION) {
    return (
      <div className="flex flex-col gap-3">
        <ChecklistCard summary={summary} required={requiredTopics ?? []} />
        <SummaryResult pipeline={pipeline} summary={summary} artifacts={artifacts} />
      </div>
    );
  }
  return <SummaryResult pipeline={pipeline} summary={summary} artifacts={artifacts} />;
}

/** Real client-side CSV of the per-capture rows (data already in the browser).
 *  Keyed by capture_id: that is what locates the report the row summarises
 *  (`report/<pipeline>/<capture_id>/`, §10.5), which a display name cannot. */
function exportRowsCsv(pipeline: string, rows: EpisodeRow[]) {
  const header = 'capture_id,result,coverage_pct';
  const body = rows.map((r) => `${r.captureId},${r.tone},${r.coverage ?? ''}`);
  const blob = new Blob([[header, ...body].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `validation-${pipeline}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const TILE_STYLES = {
  ok: 'border-green-200 bg-green-50 text-green-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-700',
  fail: 'border-red-200 bg-red-50 text-red-700',
} as const;

const ROW_TONE_CLASS: Record<string, string> = {
  OK: 'bg-green-100 text-green-700',
  WARNING: 'bg-amber-100 text-amber-700',
  FAIL: 'bg-red-50 text-red-700 border border-red-200',
};

const BAR_TONE_CLASS: Record<string, string> = {
  OK: 'bg-green-600',
  WARNING: 'bg-amber-500',
  FAIL: 'bg-red-600',
};

export function ResultsPanel({
  active,
  selectedCaptureId,
  onSelectCapture,
}: {
  active: ActiveOutcome | null;
  selectedCaptureId: string | null;
  onSelectCapture: (captureId: string) => void;
}) {
  if (!active) {
    return (
      <div className="flex min-h-0 flex-col gap-3 overflow-auto p-[18px]">
        <Card className="p-8 text-center text-sm text-gray-500">
          Run a pipeline on the left to see results here.
        </Card>
      </div>
    );
  }

  if (!active.allSettled) {
    return (
      <div className="flex min-h-0 flex-col gap-3 overflow-auto p-[18px]">
        <Card className="p-8 text-center text-sm text-gray-500">Running…</Card>
      </div>
    );
  }

  const isBatch = hasEpisodeBreakdown(active.outcomes);

  if (!isBatch) {
    const outcome = active.outcomes[0];
    if (!outcome || !outcome.summary) {
      return (
        <div className="flex min-h-0 flex-col gap-3 overflow-auto p-[18px]">
          <Card className="p-8 text-center text-sm text-gray-500">
            Nothing to run — every target is already validated.
          </Card>
        </div>
      );
    }
    return (
      <div className="flex min-h-0 flex-col gap-3 overflow-auto p-[18px]">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Latest run
          </span>
          <span className="font-mono text-xs text-gray-400">
            {outcome.label ?? outcome.captureId}
          </span>
        </div>
        <DetailCard
          pipeline={active.pipeline}
          summary={outcome.summary}
          artifacts={active.artifacts}
          requiredTopics={active.requiredTopics}
        />
        <FooterNote />
      </div>
    );
  }

  const rows = mapEpisodeRows(active.outcomes);
  const counts = tileCounts(rows);
  const selected = rows.find((r) => r.captureId === selectedCaptureId) ?? null;
  const selectedOutcome = active.outcomes.find((o) => o.captureId === selectedCaptureId);

  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-auto p-[18px]">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Latest run
        </span>
        <span className="font-mono text-xs text-gray-400">
          {counts.total} captures
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => exportRowsCsv(active.pipeline, rows)}
          className="text-xs font-semibold text-gray-700 hover:text-teal-700"
        >
          Export CSV →
        </button>
      </div>

      <div className="flex gap-2">
        <Tile tone="ok" count={counts.ok} pct={counts.okPct} label="OK" />
        <Tile tone="warning" count={counts.warning} pct={counts.warningPct} label="WARNING" />
        <Tile tone="fail" count={counts.fail} pct={counts.failPct} label="FAIL" />
      </div>

      <div className="flex h-2 overflow-hidden rounded-full bg-gray-100">
        <span className="bg-green-600" style={{ width: `${counts.okPct}%` }} />
        <span className="bg-amber-500" style={{ width: `${counts.warningPct}%` }} />
        <span className="bg-red-600" style={{ width: `${counts.failPct}%` }} />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_100px_90px_1fr_60px] gap-2 border-b border-gray-100 px-1 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400">
        <span>Capture</span>
        <span>Result</span>
        <span>Coverage</span>
        <span>Timeline</span>
        <span />
      </div>
      <div className="flex flex-col">
        {rows.map((row) => (
          <div
            key={row.captureId}
            className="grid grid-cols-[minmax(0,1fr)_100px_90px_1fr_60px] items-center gap-2 border-b border-gray-50 px-1 py-2"
          >
            <span
              className="truncate font-mono text-[13px] font-semibold text-gray-900"
              title={row.captureId}
            >
              {row.label ?? row.captureId}
            </span>
            <span
              className={`inline-flex w-fit items-center rounded-chip px-2 py-0.5 text-xs font-semibold ${ROW_TONE_CLASS[row.tone]}`}
            >
              {row.tone}
            </span>
            <span className="font-mono text-[12.5px] text-gray-700">
              {row.coverage != null ? `${row.coverage}%` : '—'}
            </span>
            <div className="flex h-[14px] overflow-hidden rounded-[5px] bg-gray-100">
              <span
                className={`opacity-75 ${BAR_TONE_CLASS[row.tone]}`}
                style={{ width: `${row.coverage ?? (row.tone === 'OK' ? 100 : row.tone === 'WARNING' ? 50 : 20)}%` }}
              />
            </div>
            <button
              type="button"
              onClick={() => onSelectCapture(row.captureId)}
              className="text-[11.5px] font-semibold text-gray-700 hover:text-teal-700"
            >
              detail
            </button>
          </div>
        ))}
      </div>

      {selected && selectedOutcome?.summary && (
        <DetailCard
          pipeline={active.pipeline}
          summary={selectedOutcome.summary}
          requiredTopics={active.requiredTopics}
        />
      )}

      <FooterNote />
    </div>
  );
}

function Tile({
  tone,
  count,
  pct,
  label,
}: {
  tone: 'ok' | 'warning' | 'fail';
  count: number;
  pct: number;
  label: string;
}) {
  return (
    <div className={`flex flex-1 flex-col gap-px rounded-[11px] border px-[14px] py-[10px] ${TILE_STYLES[tone]}`}>
      <span className="font-mono text-[19px] font-semibold">{count}</span>
      <span className="text-[11.5px]">
        {label} · {pct}%
      </span>
    </div>
  );
}

function FooterNote() {
  return (
    <div className="rounded-[10px] border border-gray-100 bg-gray-50 px-3 py-[9px] text-[11.5px] leading-relaxed text-gray-500">
      Raw JSON, artifacts and false-positive notes live in each capture&apos;s detail view.
    </div>
  );
}
