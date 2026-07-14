// Detail column: selected episode header, the REAL run inspection (detail rows,
// video_check, loss_report, fast_validation, JSON sidecars — RunInspection.tsx),
// the operator's local quality/task overrides (Phase 1, start from "—"), the
// adopt/keep/exclude decision (Phase 2 local), and cross-tab deep links. In a
// split deployment an un-transferred episode shows the transfer placeholder
// instead — its MCAP is still on the robot PC, so there's nothing to inspect.

import type { ReactNode } from 'react';
import { Badge, cn, type Tone } from '../../components/ui';
import { RunInspection } from './RunInspection';
import type { Quality, ReviewLane } from './types';
import type { ReviewState } from './useReviewState';

function qualityTone(q: Quality): Tone {
  if (q === 'Good') return 'green';
  if (q === 'Needs review') return 'amber';
  return 'red';
}

// Header badge: the exception-review lane (READY / NEEDS CHECK / EXCLUDED) — the
// same vocabulary as the row chip, so the detail header and the list agree.
function headerBadge(lane: ReviewLane): { label: string; tone: Tone } {
  if (lane === 'ready') return { label: 'READY', tone: 'green' };
  if (lane === 'excluded') return { label: 'EXCLUDED', tone: 'red' };
  return { label: 'NEEDS CHECK', tone: 'amber' };
}

// The Collect → Review → Datasets pipeline for this episode, so the operator can
// see where it is and what the next step is (the "adopt did nothing visible"
// complaint). Export / In dataset aren't observable from Review, so they stay
// upcoming; the current step is highlighted.
type StepState = 'done' | 'current' | 'todo' | 'off';
function PipelineStrip({ lane }: { lane: ReviewLane }) {
  const ready = lane === 'ready';
  const excluded = lane === 'excluded';
  const steps: { label: string; state: StepState }[] = [
    { label: 'Recorded', state: 'done' },
    // NEEDS CHECK is the current review step; READY/EXCLUDED are past it.
    { label: 'Reviewed', state: lane === 'needs_check' ? 'current' : 'done' },
    { label: 'Ready', state: ready ? 'done' : excluded ? 'off' : 'todo' },
    { label: 'Export', state: ready ? 'current' : 'todo' },
    { label: 'In dataset', state: 'todo' },
  ];
  const glyph: Record<StepState, string> = {
    done: '✓',
    current: '●',
    todo: '○',
    off: '✕',
  };
  const tone: Record<StepState, string> = {
    done: 'text-teal-700',
    current: 'text-teal-700 font-semibold',
    todo: 'text-gray-400',
    off: 'text-gray-300 line-through',
  };
  return (
    <div
      data-testid="review-pipeline-strip"
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-[10px] border border-gray-100 bg-gray-50 px-3 py-2 text-[11.5px]"
    >
      {steps.map((s, i) => (
        <span key={s.label} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-gray-300">·</span>}
          <span className={tone[s.state]}>
            {glyph[s.state]} {s.label}
          </span>
        </span>
      ))}
    </div>
  );
}

function DecisionButton({
  active = false,
  tone,
  onClick,
  children,
  testId,
}: {
  active?: boolean;
  tone: 'adopt' | 'review' | 'exclude';
  onClick: () => void;
  children: ReactNode;
  testId: string;
}) {
  const styles: Record<string, string> = {
    adopt: active
      ? 'bg-teal-600 text-white'
      : 'border border-gray-200 bg-white text-teal-700 hover:bg-teal-50',
    review: active
      ? 'border border-amber-200 bg-amber-100 text-amber-800'
      : 'border border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100',
    exclude: active
      ? 'border border-gray-300 bg-gray-100 text-gray-700'
      : 'border border-gray-200 bg-white text-gray-500 hover:bg-gray-50',
  };
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'h-[38px] flex-1 rounded-control text-[13px] font-semibold transition-colors',
        styles[tone],
      )}
    >
      {children}
    </button>
  );
}

/** A quality badge, or a muted "—" when unset (no automated quality model). */
function QualityValue({ quality }: { quality: Quality | null }) {
  if (!quality) return <span className="text-[12.5px] text-gray-400">—</span>;
  return (
    <Badge tone={qualityTone(quality)} className="w-fit">
      {quality}
    </Badge>
  );
}

export function DetailPanel({ rv }: { rv: ReviewState }) {
  const sel = rv.selected;

  if (!sel) {
    return (
      <div className="flex flex-col overflow-auto rounded-card border border-gray-200 bg-white shadow-card">
        <p className="p-[18px] text-sm text-gray-500">
          Select an episode to see details.
        </p>
      </div>
    );
  }

  const badge = headerBadge(sel.reviewLane);
  const showInspection = !rv.splitMode || sel.transferSlot.phase === 'transferred';

  return (
    // overflow-hidden + an inner scroll region: the header and the decision
    // bar (bottom) stay pinned; only the evidence (inspection / quality /
    // pipeline) scrolls. Previously the whole panel scrolled and the decision
    // buttons sat below the tall inspection — the operator had to scroll to
    // the very bottom for every Mark OK / Exclude (user-reported UX pain).
    <div className="flex flex-col overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
      <div
        data-testid="review-detail-header"
        className="flex items-center gap-2.5 border-b border-gray-100 px-[18px] py-3"
      >
        <span className="font-mono text-sm font-semibold text-gray-900">
          Episode #{sel.ep}
        </span>
        <span className="text-xs text-gray-400">Batch {sel.batch}</span>
        <div className="flex-1" />
        <span data-testid="review-detail-status">
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-[18px] py-3.5">
        {showInspection ? (
          <RunInspection runId={sel.runId} />
        ) : (
          <div className="flex flex-col items-center justify-center gap-2.5 rounded-[10px] border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center">
            <span className="text-sm font-medium text-gray-600">
              Data is on the robot PC
            </span>
            <span className="text-xs text-gray-400">
              This episode hasn&apos;t been transferred to the recording PC yet.
            </span>
            {sel.transferSlot.phase === 'transferring' ? (
              <div className="mt-1 flex w-full max-w-[220px] items-center gap-2">
                <div className="relative h-[5px] flex-1 rounded-[3px] bg-gray-200">
                  <span
                    className="absolute bottom-0 left-0 top-0 rounded-[3px] bg-teal-600"
                    style={{ width: `${sel.transferSlot.pct}%` }}
                  />
                </div>
                <span className="font-mono text-[11px] text-gray-500">
                  {sel.transferSlot.pct}%
                </span>
              </div>
            ) : (
              <button
                type="button"
                data-testid="review-transfer-button"
                onClick={() => rv.transferOne(sel.runId)}
                className="rounded-control bg-teal-600 px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-teal-700"
              >
                Transfer to recording PC
              </button>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 border-t border-gray-100 pt-3">
          <div className="flex flex-col gap-0.5 rounded-[10px] border border-gray-100 px-3 py-2.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400">
              Auto quality
            </span>
            <QualityValue quality={sel.quality} />
          </div>
          <div
            onClick={rv.cycleFinalQuality}
            title="Click to set: Good → Needs review → Not usable"
            data-testid="review-final-quality"
            className="flex cursor-pointer flex-col gap-0.5 rounded-[10px] border border-gray-100 px-3 py-2.5 transition-colors hover:border-teal-200 hover:bg-teal-50"
          >
            <div className="flex items-center gap-1.5">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400">
                Final quality
              </span>
              <span className="text-[10px] text-gray-400">✎</span>
            </div>
            <QualityValue quality={sel.effectiveQuality} />
          </div>
          <div
            onClick={rv.cycleTaskResult}
            title="Click to set: Success ↔ Failure"
            data-testid="review-task-result"
            className="flex cursor-pointer flex-col gap-0.5 rounded-[10px] border border-gray-100 px-3 py-2.5 transition-colors hover:border-teal-200 hover:bg-teal-50"
          >
            <div className="flex items-center gap-1.5">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400">
                Task result
              </span>
              <span className="text-[10px] text-gray-400">✎</span>
            </div>
            <span className="text-[12.5px] font-medium text-gray-700">
              {sel.effectiveTask ?? '—'}
            </span>
            {sel.effectiveTask === 'Failure' && sel.failReason && (
              <span
                data-testid="review-fail-reason"
                className="text-[11px] leading-snug text-red-700"
              >
                {sel.failReason}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-0.5 rounded-[10px] border border-gray-100 px-3 py-2.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400">
              Issues
            </span>
            <span
              className={cn(
                'text-[12.5px] font-medium',
                sel.issues ? 'text-amber-800' : 'text-gray-400',
              )}
            >
              {sel.issues ?? '—'}
            </span>
          </div>
        </div>

        <PipelineStrip lane={sel.reviewLane} />

        {sel.isArchived && (
          <div className="flex flex-col gap-1.5 rounded-[10px] border border-gray-200 bg-gray-50 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-semibold text-gray-600">
                Excluded — kept on disk
              </span>
              <div className="flex-1" />
              <button
                type="button"
                data-testid="review-delete-one"
                onClick={() => rv.requestDelete(sel.runId)}
                className="rounded-control border border-red-200 px-2.5 py-1 text-[11.5px] font-semibold text-red-700 transition-colors hover:bg-red-50"
              >
                Delete from disk…
              </button>
            </div>
            <span className="text-[11px] text-gray-400">
              Excluded from dataset use, but the recording still occupies disk. Deleting
              reclaims that storage and is permanent.
            </span>
          </div>
        )}

        <div className="flex items-center gap-3 border-t border-gray-100 pt-2.5">
          <button
            type="button"
            onClick={rv.goMonitor}
            className="text-[12.5px] font-semibold text-teal-700 hover:underline"
          >
            Open in Monitor →
          </button>
          <button
            type="button"
            onClick={rv.goValidation}
            className="text-[12.5px] font-semibold text-teal-700 hover:underline"
          >
            Open in Validation →
          </button>
          <div className="flex-1" />
          {/* Real local history: how many quality/task overrides the operator
              has applied to this episode this session. */}
          <span
            data-testid="review-override-history"
            className="text-[11.5px] text-gray-400"
          >
            {rv.selectedOverrideCount > 0
              ? `${rv.selectedOverrideCount} override${rv.selectedOverrideCount === 1 ? '' : 's'} this session`
              : 'no overrides yet'}
          </span>
        </div>
      </div>

      {/* Pinned decision bar — always visible, never behind a scroll. Exception-
          review actions: READY (good or confirmed) needs no click; you only
          resolve a NEEDS CHECK exception (Mark OK / Exclude). */}
      <div
        data-testid="review-decision-bar"
        className="flex flex-col gap-2 border-t border-gray-100 bg-gray-50/60 px-[18px] py-3"
      >
        <div className="flex flex-wrap gap-1.5">
          {sel.reviewLane === 'needs_check' && (
            <DecisionButton tone="adopt" testId="review-mark-ok" onClick={rv.markOk}>
              Mark OK — include
            </DecisionButton>
          )}
          {sel.reviewLane !== 'excluded' && (
            <DecisionButton
              tone="exclude"
              testId="review-decision-exclude"
              onClick={() => rv.decide('excluded')}
            >
              Exclude
            </DecisionButton>
          )}
          {/* Return to review (reversible, non-scary): an excluded item goes back
              to pending; a confirmed EXCEPTION (adopted but not good-quality) can
              be sent back to the queue. Hidden for good-quality READY (no-op). */}
          {(sel.reviewLane === 'excluded' ||
            (sel.effectiveReviewStatus === 'adopted' &&
              sel.effectiveQuality !== 'Good')) && (
            <DecisionButton
              tone="review"
              testId="review-return-to-review"
              onClick={() => rv.decide('review')}
            >
              {sel.reviewLane === 'excluded'
                ? '↩ Return to review'
                : '↩ Reset to needs check'}
            </DecisionButton>
          )}
        </div>

        {/* READY → the next pipeline step (export), right where the operator is. */}
        {sel.reviewLane === 'ready' && sel.state === 'completed' && (
          <button
            type="button"
            data-testid="review-export-cta"
            onClick={rv.requestExportReady}
            className="flex items-center justify-center gap-1.5 rounded-control bg-teal-600 px-3 py-2 text-[12.5px] font-bold text-white transition-colors hover:bg-teal-700"
          >
            Ready — Export now ({rv.readyExportable.length}) →
          </button>
        )}
      </div>
    </div>
  );
}
