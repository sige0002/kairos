// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Results column: renders the OK/WARNING/FAIL tiles + ratio bar + per-capture
// rows when the active submission was a batch (multiple target captures — see
// resultsMapping.ts for why that's the gate), otherwise falls back to the
// generic, pipeline-agnostic SummaryResult for a single-capture submission. That
// fallback is the point: a new plugin's summary.json renders here with no UI
// change required.
import { Card } from '../../components/ui';
import { useTranslation } from 'react-i18next';
import type { JobState, LossEvent, LossTopic } from '../../api/types';
import { isCancellable } from './useJobCancel';
import { SummaryResult, type Summary } from '../../features/validation/SummaryResult';
import { LossEventTable, LossTable } from '../captures/inspect';
import { ChecklistCard } from './ChecklistCard';
import {
  canceledCount,
  hasEpisodeBreakdown,
  mapEpisodeRows,
  tileCounts,
  type EpisodeOutcome,
  type EpisodeRow,
  type RequiredTopic,
} from './resultsMapping';

const FAST_VALIDATION = 'fast_validation';

/** Stable default so an absent `cancelPending` does not remount on every render. */
const EMPTY_PENDING: ReadonlySet<string> = new Set();

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
/** loss_report leads with the same TOPIC/HZ/LOSS/MAX-GAP table Review renders
 *  (audit P1: the tab that RUNS the pipeline showed 300 lines of raw JSON while
 *  the good renderer sat ten lines away). Worst offenders first, flagged count
 *  as the headline; the generic card follows as the evidence trail. */
function LossReportCard({ summary }: { summary: Summary }) {
  const { t } = useTranslation('validation');
  const raw = (summary as Record<string, unknown>).topics;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const topics = [...(raw as LossTopic[])].sort(
    (a, b) => (b.loss_rate ?? 0) - (a.loss_rate ?? 0),
  );
  const flagged = (summary as Record<string, unknown>).flagged;
  const rawEvents = (summary as Record<string, unknown>).events;
  const events = Array.isArray(rawEvents) ? (rawEvents as LossEvent[]) : null;
  const flaggedCount = Array.isArray(flagged) ? flagged.length : null;
  const worst = topics[0];
  return (
    <div className="flex flex-col gap-2" data-testid="loss-report-table">
      {flaggedCount !== null && flaggedCount > 0 && worst && (
        <p className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12.5px] font-semibold text-status-warning-text">
          {t('lossGapWarning', {
            flagged: String(flaggedCount),
            total: String(topics.length),
          })}{' '}
          <span className="font-mono">{worst.name}</span>{' '}
          {worst.loss_rate != null ? `${(worst.loss_rate * 100).toFixed(1)}%` : ''}
        </p>
      )}
      <LossTable topics={topics} />
      {events && <LossEventTable events={events} />}
    </div>
  );
}

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
  if (pipeline === 'loss_report') {
    return (
      <div className="flex flex-col gap-3">
        <LossReportCard summary={summary} />
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
  ok: 'border-status-success-border bg-status-success-bg text-status-success-text',
  warning: 'border-status-warning-border bg-status-warning-bg text-status-warning-text',
  fail: 'border-status-danger-border bg-status-danger-bg text-status-danger-text',
} as const;

const ROW_TONE_CLASS: Record<string, string> = {
  OK: 'bg-status-success-bg text-status-success-text',
  WARNING: 'bg-status-warning-bg text-status-warning-text',
  FAIL: 'bg-status-danger-bg text-status-danger-text border border-status-danger-border',
  // Grey, like every other "this did not happen" in the console — a stopped job
  // is not a bad result, it is an absent one.
  CANCELED: 'bg-surface-muted text-text-secondary',
};

const BAR_TONE_CLASS: Record<string, string> = {
  OK: 'bg-status-success-accent',
  WARNING: 'bg-status-warning-accent',
  FAIL: 'bg-status-danger-accent',
  CANCELED: 'bg-surface-muted',
};

/** What each job state is called on screen while a run is in flight. */
const JOB_STATE_CLASS: Record<JobState, string> = {
  queued: 'bg-surface-muted text-text-secondary',
  running: 'bg-interaction-selected text-accent',
  succeeded: 'bg-status-success-bg text-status-success-text',
  failed: 'bg-status-danger-bg text-status-danger-text',
  canceled: 'bg-surface-muted text-text-secondary',
};

/** One job of the run in flight. */
export interface RunJobRow {
  jobId: string;
  captureId: string;
  label: string;
  state: JobState;
  /** Cancel accepted, work still stopping — the row shows "Cancelling…". */
  cancelRequested?: boolean;
}

/** The per-job view of a run that is still going: which capture, what state,
 *  and — while it can still be stopped — its own Cancel. Until this existed the
 *  screen said only "Running…", so an operator could not tell WHICH of twenty
 *  captures was holding things up, let alone stop just that one. */
function RunningJobs({
  jobs,
  onCancelJob,
  cancelPending,
}: {
  jobs: RunJobRow[];
  onCancelJob?: (jobId: string) => void;
  cancelPending: ReadonlySet<string>;
}) {
  const { t } = useTranslation('validation');
  if (jobs.length === 0) return null;
  return (
    <Card className="flex flex-col gap-1.5 p-4" data-testid="running-jobs">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
        {t('jobsInRun')}
      </h3>
      {jobs.map((job) => (
        <div
          key={job.jobId}
          data-testid={`running-job-${job.captureId}`}
          className="flex items-center gap-2 border-b border-border py-1.5 last:border-b-0"
        >
          <span
            className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-text-primary"
            title={job.captureId}
          >
            {job.label}
          </span>
          <span
            data-testid={`job-state-${job.captureId}`}
            className={`shrink-0 rounded-chip px-2 py-0.5 text-[11px] font-semibold ${JOB_STATE_CLASS[job.state]}`}
          >
            {job.state === 'queued'
              ? t('queued')
              : job.state === 'running'
                ? t('running')
                : job.state === 'succeeded'
                  ? t('done')
                  : job.state === 'failed'
                    ? t('failed')
                    : t('canceled')}
          </span>
          {isCancellable(job.state) && onCancelJob && (
            <button
              type="button"
              data-testid={`cancel-job-${job.captureId}`}
              disabled={cancelPending.has(job.jobId) || job.cancelRequested}
              onClick={() => onCancelJob(job.jobId)}
              className="shrink-0 rounded-chip border border-border bg-surface px-2 py-0.5 text-[11px] font-semibold text-text-secondary hover:border-status-danger-border hover:text-status-danger-text disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cancelPending.has(job.jobId) || job.cancelRequested
                ? t('canceling')
                : t('cancel')}
            </button>
          )}
        </div>
      ))}
    </Card>
  );
}

export function ResultsPanel({
  active,
  selectedCaptureId,
  onSelectCapture,
  runJobs = [],
  onCancelJob,
  cancelPending = EMPTY_PENDING,
}: {
  active: ActiveOutcome | null;
  selectedCaptureId: string | null;
  onSelectCapture: (captureId: string) => void;
  /** The run's jobs while it is still in flight. */
  runJobs?: RunJobRow[];
  onCancelJob?: (jobId: string) => void;
  cancelPending?: ReadonlySet<string>;
}) {
  const { t } = useTranslation('validation');
  if (!active) {
    return (
      <div className="flex min-h-0 flex-col gap-3 overflow-auto p-[18px]">
        <Card className="p-8 text-center text-sm text-text-muted">
          {t('runPipelineHint')}
        </Card>
      </div>
    );
  }

  if (!active.allSettled) {
    return (
      <div className="flex min-h-0 flex-col gap-3 overflow-auto p-[18px]">
        <Card className="p-8 text-center text-sm text-text-muted">{t('running')}</Card>
        <RunningJobs
          jobs={runJobs}
          onCancelJob={onCancelJob}
          cancelPending={cancelPending}
        />
      </div>
    );
  }

  const isBatch = hasEpisodeBreakdown(active.outcomes);

  if (!isBatch) {
    const outcome = active.outcomes[0];
    // Checked BEFORE the no-summary fallback below. A cancelled job has no
    // summary either, and that fallback would have told the operator their run
    // was unnecessary — "every target is already validated" — when in fact they
    // stopped it themselves and nothing was checked.
    if (outcome?.canceled) {
      return (
        <div className="flex min-h-0 flex-col gap-3 overflow-auto p-[18px]">
          <Card
            className="flex flex-col gap-1 p-8 text-center text-sm text-text-muted"
            data-testid="run-canceled"
          >
            <span className="font-semibold text-text-primary">{t('canceled')}</span>
            <span>
              {t('runCanceled', { capture: outcome.label ?? outcome.captureId })}
            </span>
          </Card>
        </div>
      );
    }
    if (!outcome || !outcome.summary) {
      return (
        <div className="flex min-h-0 flex-col gap-3 overflow-auto p-[18px]">
          <Card className="p-8 text-center text-sm text-text-muted">
            {t('nothingToRun')}
          </Card>
        </div>
      );
    }
    return (
      <div className="flex min-h-0 flex-col gap-3 overflow-auto p-[18px]">
        <div className="flex items-center gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
            {t('latestRun')}
          </h3>
          <span className="font-mono text-xs text-text-muted">
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
  // Cancelled jobs produced no verdict, so they are in none of the three tiles.
  // Without this line the tiles would simply not add up to the capture count.
  const canceled = canceledCount(rows);
  const selected = rows.find((r) => r.captureId === selectedCaptureId) ?? null;
  const selectedOutcome = active.outcomes.find(
    (o) => o.captureId === selectedCaptureId,
  );

  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-auto p-[18px]">
      <div className="flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          {t('latestRun')}
        </h3>
        <span className="font-mono text-xs text-text-muted">
          {t('captures', { count: counts.total })}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => exportRowsCsv(active.pipeline, rows)}
          className="text-xs font-semibold text-text-primary hover:text-accent"
        >
          {t('exportCsv')}
        </button>
      </div>

      <div className="flex gap-2">
        <Tile tone="ok" count={counts.ok} pct={counts.okPct} label="OK" />
        <Tile
          tone="warning"
          count={counts.warning}
          pct={counts.warningPct}
          label="WARNING"
        />
        <Tile tone="fail" count={counts.fail} pct={counts.failPct} label="FAIL" />
      </div>

      <div className="flex h-2 overflow-hidden rounded-full bg-surface-muted">
        <span
          className="bg-status-success-accent"
          style={{ width: `${counts.okPct}%` }}
        />
        <span
          className="bg-status-warning-accent"
          style={{ width: `${counts.warningPct}%` }}
        />
        <span
          className="bg-status-danger-accent"
          style={{ width: `${counts.failPct}%` }}
        />
      </div>

      {canceled > 0 && (
        <p data-testid="canceled-note" className="text-[11.5px] text-text-muted">
          {t('canceledSummary', {
            canceled: String(canceled),
            total: String(counts.total),
          })}
        </p>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_100px_90px_1fr_60px] gap-2 border-b border-border px-1 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-text-muted">
        <span>{t('capture')}</span>
        <span>{t('result')}</span>
        <span>{t('coverage')}</span>
        <span>{t('timeline')}</span>
        <span />
      </div>
      <div className="flex flex-col">
        {rows.map((row) => (
          <div
            key={row.captureId}
            className="grid grid-cols-[minmax(0,1fr)_100px_90px_1fr_60px] items-center gap-2 border-b border-border px-1 py-2"
          >
            <span
              className="truncate font-mono text-[13px] font-semibold text-text-primary"
              title={row.captureId}
            >
              {row.label ?? row.captureId}
            </span>
            <span
              className={`inline-flex w-fit items-center rounded-chip px-2 py-0.5 text-xs font-semibold ${ROW_TONE_CLASS[row.tone]}`}
            >
              {row.tone}
            </span>
            <span className="font-mono text-[12.5px] text-text-primary">
              {row.coverage != null ? `${row.coverage}%` : '—'}
            </span>
            <div className="flex h-[14px] overflow-hidden rounded-[5px] bg-surface-muted">
              <span
                className={`opacity-75 ${BAR_TONE_CLASS[row.tone]}`}
                style={{
                  width: `${row.coverage ?? (row.tone === 'OK' ? 100 : row.tone === 'WARNING' ? 50 : 20)}%`,
                }}
              />
            </div>
            <button
              type="button"
              onClick={() => onSelectCapture(row.captureId)}
              className="text-[11.5px] font-semibold text-text-primary hover:text-accent"
            >
              {t('detail')}
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
    <div
      className={`flex flex-1 flex-col gap-px rounded-[11px] border px-[14px] py-[10px] ${TILE_STYLES[tone]}`}
    >
      <span className="font-mono text-[19px] font-semibold">{count}</span>
      <span className="text-[11.5px]">
        {label} · {pct}%
      </span>
    </div>
  );
}

function FooterNote() {
  const { t } = useTranslation('validation');
  return (
    <div className="rounded-[10px] border border-border bg-surface-muted px-3 py-[9px] text-[11.5px] leading-relaxed text-text-muted">
      {t('rawEvidence')}
    </div>
  );
}
