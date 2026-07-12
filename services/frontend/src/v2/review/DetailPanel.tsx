// Detail column: selected episode header, camera tiles (or the split-mode
// transfer placeholder), fake player, quality/task/issues cells, decision
// buttons, the standard-pipelines mock action, and cross-tab deep links.

import type { ReactNode } from 'react';
import { Badge, cn, type Tone } from '../../components/ui';
import type { Decision, Quality } from './types';
import type { ReviewState } from './useReviewState';

const CAMERA_LABELS = ['top', 'left', 'right', 'wrist'];

function qualityTone(q: Quality): Tone {
  if (q === 'Good') return 'green';
  if (q === 'Needs review') return 'amber';
  return 'red';
}

function statusTone(decision: Decision | null, quality: Quality): Tone {
  if (decision === 'adopted') return 'green';
  if (decision === 'excluded') return 'gray';
  if (decision === 'review') return 'amber';
  return qualityTone(quality);
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

export function DetailPanel({ rv }: { rv: ReviewState }) {
  const sel = rv.selected;

  if (!sel) {
    return (
      <div className="flex flex-col overflow-auto rounded-card border border-gray-200 bg-white shadow-card">
        <p className="p-[18px] text-sm text-gray-500">Select an episode to see details.</p>
      </div>
    );
  }

  const showTiles = !rv.splitMode || sel.transferSlot.phase === 'transferred';

  return (
    <div className="flex flex-col overflow-auto rounded-card border border-gray-200 bg-white shadow-card">
      <div
        data-testid="review-detail-header"
        className="flex items-center gap-2.5 border-b border-gray-100 px-[18px] py-3"
      >
        <span className="font-mono text-sm font-semibold text-gray-900">Episode #{sel.ep}</span>
        <span className="text-xs text-gray-400">Batch {sel.batch}</span>
        <div className="flex-1" />
        <Badge tone={statusTone(sel.decision, sel.effectiveQuality)}>
          {(sel.decision ?? sel.effectiveQuality).toUpperCase()}
        </Badge>
      </div>

      <div className="flex flex-col gap-3 px-[18px] py-3.5">
        {showTiles ? (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              {CAMERA_LABELS.map((c) => (
                <div
                  key={c}
                  className="flex aspect-[16/10] items-center justify-center rounded-[10px] bg-[repeating-linear-gradient(45deg,#1f2937_0px,#1f2937_10px,#243042_10px,#243042_20px)]"
                >
                  <span className="font-mono text-[10.5px] text-gray-400">{c}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 rounded-control bg-gray-50 px-3 py-2">
              <button
                type="button"
                data-testid="review-play-toggle"
                onClick={rv.togglePlay}
                className="border-none bg-transparent p-0 text-xs font-bold text-teal-700"
              >
                {rv.playing ? '❚❚' : '▶'}
              </button>
              <div className="relative h-[5px] flex-1 rounded-[3px] bg-gray-200">
                <span
                  className="absolute bottom-0 left-0 top-0 rounded-[3px] bg-teal-600"
                  style={{ width: `${rv.playPct}%` }}
                />
              </div>
              <span className="font-mono text-[11px] text-gray-500">{rv.playTimeLabel}</span>
            </div>
          </>
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

        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-0.5 rounded-[10px] border border-gray-100 px-3 py-2.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400">
              Quick quality
            </span>
            <Badge tone={qualityTone(sel.quality)} className="w-fit">
              {sel.quality}
            </Badge>
          </div>
          <div
            onClick={rv.cycleFinalQuality}
            title="Click to override: Good → Needs review → Not usable"
            data-testid="review-final-quality"
            className="flex cursor-pointer flex-col gap-0.5 rounded-[10px] border border-gray-100 px-3 py-2.5 transition-colors hover:border-teal-200 hover:bg-teal-50"
          >
            <div className="flex items-center gap-1.5">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400">
                Final quality
              </span>
              <span className="text-[10px] text-gray-400">✎</span>
            </div>
            <Badge tone={qualityTone(sel.effectiveQuality)} className="w-fit">
              {sel.effectiveQuality}
            </Badge>
          </div>
          <div
            onClick={rv.cycleTaskResult}
            title="Click to override: Success ↔ Failure"
            data-testid="review-task-result"
            className="flex cursor-pointer flex-col gap-0.5 rounded-[10px] border border-gray-100 px-3 py-2.5 transition-colors hover:border-teal-200 hover:bg-teal-50"
          >
            <div className="flex items-center gap-1.5">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400">
                Task result
              </span>
              <span className="text-[10px] text-gray-400">✎</span>
            </div>
            <span className="text-[12.5px] font-medium text-gray-700">{sel.effectiveTask}</span>
          </div>
          <div className="flex flex-col gap-0.5 rounded-[10px] border border-gray-100 px-3 py-2.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400">
              Issues
            </span>
            <span className="text-[12.5px] font-medium text-amber-800">{sel.issues}</span>
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

        <div className="flex flex-col gap-1.5 border-t border-gray-100 pt-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
              Standard pipelines
            </span>
            <span className="text-[11px] text-gray-400">preset by engineers</span>
            <div className="flex-1" />
            {rv.rvRunning && (
              <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-teal-700">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-teal-100 border-t-teal-600" />
                running…
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <span className="rounded-[7px] bg-gray-100 px-2.5 py-1 font-mono text-[11.5px] font-semibold text-gray-500">
              camera_coverage_check v1.3.0
            </span>
            <span className="rounded-[7px] bg-gray-100 px-2.5 py-1 font-mono text-[11.5px] font-semibold text-gray-500">
              sync_drift_check v2.0.1
            </span>
          </div>
          <button
            type="button"
            data-testid="review-run-standard"
            onClick={rv.runStandardOnEp}
            disabled={rv.rvRunning}
            className={cn(
              'h-[38px] rounded-control border border-gray-200 text-[13px] font-semibold transition-colors',
              rv.rvRunning ? 'cursor-not-allowed bg-gray-100 text-gray-400' : 'bg-white text-teal-700 hover:bg-teal-50',
            )}
          >
            Run standard validation on #{sel.ep}
          </button>
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
        </div>
      </div>
    </div>
  );
}
