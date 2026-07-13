// Detail column: selected episode header, the REAL run inspection (detail rows,
// video_check, loss_report, fast_validation, JSON sidecars — RunInspection.tsx),
// the operator's local quality/task overrides (Phase 1, start from "—"), the
// adopt/keep/exclude decision (Phase 2 local), and cross-tab deep links. In a
// split deployment an un-transferred episode shows the transfer placeholder
// instead — its MCAP is still on the robot PC, so there's nothing to inspect.

import type { ReactNode } from 'react';
import { Badge, cn, type Tone } from '../../components/ui';
import { RunInspection } from './RunInspection';
import type { Decision, Quality } from './types';
import type { ReviewState } from './useReviewState';
import type { RunState } from '../../api/types';

function qualityTone(q: Quality): Tone {
  if (q === 'Good') return 'green';
  if (q === 'Needs review') return 'amber';
  return 'red';
}

function stateTone(state: RunState): Tone {
  if (state === 'failed' || state === 'interrupted') return 'red';
  if (state === 'completed') return 'gray';
  return 'gray';
}

// Header badge: the operator's decision wins, then their quality override /
// the real "Not usable" verdict, then the raw run state as an honest fallback.
function headerBadge(
  decision: Decision | null,
  quality: Quality | null,
  state: RunState,
): { label: string; tone: Tone } {
  if (decision) {
    const tone: Tone = decision === 'adopted' ? 'green' : decision === 'review' ? 'amber' : 'gray';
    return { label: decision.toUpperCase(), tone };
  }
  if (quality) return { label: quality.toUpperCase(), tone: qualityTone(quality) };
  return { label: state.toUpperCase(), tone: stateTone(state) };
}

function DecisionButton({
  active,
  tone,
  onClick,
  children,
  testId,
}: {
  active: boolean;
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
        <p className="p-[18px] text-sm text-gray-500">Select an episode to see details.</p>
      </div>
    );
  }

  const badge = headerBadge(sel.decision, sel.effectiveQuality, sel.state);
  const showInspection = !rv.splitMode || sel.transferSlot.phase === 'transferred';

  return (
    <div className="flex flex-col overflow-auto rounded-card border border-gray-200 bg-white shadow-card">
      <div
        data-testid="review-detail-header"
        className="flex items-center gap-2.5 border-b border-gray-100 px-[18px] py-3"
      >
        <span className="font-mono text-sm font-semibold text-gray-900">Episode #{sel.ep}</span>
        <span className="text-xs text-gray-400">Batch {sel.batch}</span>
        <div className="flex-1" />
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>

      <div className="flex flex-col gap-3 px-[18px] py-3.5">
        {showInspection ? (
          <RunInspection runId={sel.runId} />
        ) : (
          <div className="flex flex-col items-center justify-center gap-2.5 rounded-[10px] border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center">
            <span className="text-sm font-medium text-gray-600">Data is on the robot PC</span>
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
                <span className="font-mono text-[11px] text-gray-500">{sel.transferSlot.pct}%</span>
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
            <span className="text-[12.5px] font-medium text-gray-700">{sel.effectiveTask ?? '—'}</span>
          </div>
          <div className="flex flex-col gap-0.5 rounded-[10px] border border-gray-100 px-3 py-2.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400">
              Issues
            </span>
            <span className={cn('text-[12.5px] font-medium', sel.issues ? 'text-amber-800' : 'text-gray-400')}>
              {sel.issues ?? '—'}
            </span>
          </div>
        </div>

        <div className="flex gap-1.5">
          <DecisionButton
            active={sel.decision === 'adopted'}
            tone="adopt"
            testId="review-decision-adopt"
            onClick={() => rv.decide('adopted')}
          >
            Adopt
          </DecisionButton>
          <DecisionButton
            active={sel.decision === 'review'}
            tone="review"
            testId="review-decision-review"
            onClick={() => rv.decide('review')}
          >
            Keep in review
          </DecisionButton>
          <DecisionButton
            active={sel.decision === 'excluded'}
            tone="exclude"
            testId="review-decision-exclude"
            onClick={() => rv.decide('excluded')}
          >
            Exclude
          </DecisionButton>
        </div>

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
          <span data-testid="review-override-history" className="text-[11.5px] text-gray-400">
            {rv.selectedOverrideCount > 0
              ? `${rv.selectedOverrideCount} override${rv.selectedOverrideCount === 1 ? '' : 's'} this session`
              : 'no overrides yet'}
          </span>
        </div>
      </div>
    </div>
  );
}
