// Detail column: selected capture header, the REAL inspection (detail rows,
// video_check, loss_report, fast_validation, JSON sidecars —
// CaptureInspection.tsx), the quality/task edits, the adopt/keep/exclude
// decision, and cross-tab deep links.
//
// A capture whose bytes have not arrived shows the transfer placeholder instead
// of the inspection. That is a normal state on a split deployment, not an error:
// §12 requires a capture with review data and no local copy to render, because
// reviewing before the pull is the intended order there.

import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCapture } from '../../api/captures';
import { queryKeys } from '../../api/queryKeys';
import { Badge, cn, type Tone } from '../../components/ui';
import { AvailabilityChip } from '../captures/AvailabilityChip';
import { availabilityOf } from '../captures/availability';
import { CaptureInspection } from './CaptureInspection';
import { episodeLabel } from './types';
import type { DisplayQuality, ReviewLane } from './types';
import type { ReviewState } from './useReviewState';

function qualityTone(q: DisplayQuality): Tone {
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

// The Collect → Review → Datasets pipeline for this capture, so the operator can
// see where it is and what the next step is (the "adopt did nothing visible"
// complaint). The "In dataset" step reads REAL membership from the capture
// detail (the same query CaptureInspection uses, deduped by React Query) — it
// used to light up "●" for any READY capture, contradicting a Datasets tab
// with zero datasets (audit P1). Unknown (detail still loading) stays "○".
type StepState = 'done' | 'current' | 'todo' | 'off';
function PipelineStrip({ lane, inDataset }: { lane: ReviewLane; inDataset: boolean | null }) {
  const ready = lane === 'ready';
  const excluded = lane === 'excluded';
  const steps: { label: string; state: StepState }[] = [
    { label: 'Recorded', state: 'done' },
    // NEEDS CHECK is the current review step; READY/EXCLUDED are past it.
    { label: 'Reviewed', state: lane === 'needs_check' ? 'current' : 'done' },
    { label: 'Ready', state: ready ? 'done' : excluded ? 'off' : 'todo' },
    { label: 'In dataset', state: inDataset === true ? 'done' : 'todo' },
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
  disabled = false,
}: {
  active?: boolean;
  tone: 'adopt' | 'review' | 'exclude';
  onClick: () => void;
  children: ReactNode;
  testId: string;
  disabled?: boolean;
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
      disabled={disabled}
      className={cn(
        'h-[38px] flex-1 rounded-control text-[13px] font-semibold transition-colors',
        styles[tone],
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {children}
    </button>
  );
}

/** A quality badge, or a muted "—" when unset. */
function QualityValue({ quality }: { quality: DisplayQuality | null }) {
  if (!quality) return <span className="text-[12.5px] text-gray-400">—</span>;
  return (
    <Badge tone={qualityTone(quality)} className="w-fit">
      {quality}
    </Badge>
  );
}

export function DetailPanel({ rv }: { rv: ReviewState }) {
  const sel = rv.selected;
  // Same key CaptureInspection uses — React Query dedupes the request; this
  // just lets the pipeline strip read REAL dataset membership (see
  // PipelineStrip). null = detail not loaded yet.
  const detailQuery = useQuery({
    queryKey: queryKeys.capture(sel?.captureId ?? ''),
    queryFn: ({ signal }) => getCapture(sel!.captureId, signal),
    enabled: !!sel,
  });
  const inDataset = detailQuery.data
    ? (detailQuery.data.memberships?.length ?? 0) > 0
    : null;

  if (!sel) {
    return (
      <div className="flex flex-col overflow-auto rounded-card border border-gray-200 bg-white shadow-card">
        <p className="p-[18px] text-sm text-gray-500">
          Select an episode to see details.
        </p>
      </div>
    );
  }

  // A save for THIS capture is unanswered. Every control below spends
  // `sel.capture.review_revision`, and that value does not move until the save
  // lands, so a second decision taken now would carry a revision already
  // spent. The hook refuses to send it either way (useReviewSave); this is the
  // half the operator can see, so the refusal is not a click into silence.
  const saving = rv.reviewSave.savingCaptureIds.has(sel.captureId);
  const badge = headerBadge(sel.reviewLane);
  const availability = availabilityOf(sel.capture);
  // Whether this machine actually holds the bytes. `usable` is the same fact
  // the inspection gates on: present and readable.
  const bytesHere = availability.usable;
  // The inspection reads the local bag, so it needs the bytes to be here —
  // which is a fact about the replica, not about the deployment topology.
  const showInspection = availability.usable;

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
          Episode {episodeLabel(sel.ep)}
        </span>
        <span className="text-xs text-gray-400">Batch {sel.batch}</span>
        <AvailabilityChip capture={sel.capture} testId="review-detail-availability" />
        <div className="flex-1" />
        <span data-testid="review-detail-status">
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-[18px] py-3.5">
        {showInspection ? (
          <CaptureInspection captureId={sel.captureId} />
        ) : (
          <div
            data-testid="review-no-local-copy"
            data-availability={availability.kind}
            className="flex flex-col items-center justify-center gap-2.5 rounded-[10px] border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center"
          >
            <span className="text-sm font-medium text-gray-600">
              Nothing to inspect here
            </span>
            <span className="max-w-[320px] text-xs text-gray-400">
              {availability.detail}
            </span>
            {sel.transferSlot.phase === 'transferring' ? (
              // Indeterminate: rsync progress isn't observable through the pull
              // channel, so we show motion + honest words instead of a fake %.
              <div className="mt-1 flex w-full max-w-[220px] flex-col items-center gap-1.5">
                <div className="relative h-[5px] w-full overflow-hidden rounded-[3px] bg-gray-200">
                  <span className="absolute inset-0 animate-pulse rounded-[3px] bg-teal-600" />
                </div>
                <span data-testid="review-transferring" className="text-[11px] text-gray-500">
                  Transferring from the robot… a long episode can take a while
                </span>
              </div>
            ) : (
              // Only offered for a capture that is simply absent. Every other
              // replica state (trashed, removed, missing, corrupt) has a story
              // the chip already tells, and pulling would not be the answer.
              sel.transferSlot.phase === 'awaiting' && (
                <button
                  type="button"
                  data-testid="review-transfer-button"
                  onClick={() => rv.transferOne(sel.captureId)}
                  className="rounded-control bg-teal-600 px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-teal-700"
                >
                  Transfer to recording PC
                </button>
              )
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
            onClick={saving ? undefined : rv.cycleFinalQuality}
            aria-disabled={saving}
            title={
              saving
                ? 'Saving the last change…'
                : 'Click to set: Good → Needs review → Not usable'
            }
            data-testid="review-final-quality"
            className={cn(
              'flex flex-col gap-0.5 rounded-[10px] border border-gray-100 px-3 py-2.5 transition-colors',
              saving
                ? 'cursor-not-allowed opacity-50'
                : 'cursor-pointer hover:border-teal-200 hover:bg-teal-50',
            )}
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
            onClick={saving ? undefined : rv.cycleTaskResult}
            aria-disabled={saving}
            title={saving ? 'Saving the last change…' : 'Click to set: Success ↔ Failure'}
            data-testid="review-task-result"
            className={cn(
              'flex flex-col gap-0.5 rounded-[10px] border border-gray-100 px-3 py-2.5 transition-colors',
              saving
                ? 'cursor-not-allowed opacity-50'
                : 'cursor-pointer hover:border-teal-200 hover:bg-teal-50',
            )}
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

        <PipelineStrip lane={sel.reviewLane} inDataset={inDataset} />

        {sel.isExcluded && (
          <div className="flex flex-col gap-1.5 rounded-[10px] border border-gray-200 bg-gray-50 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-semibold text-gray-600">
                {bytesHere ? 'Excluded — still on disk' : 'Excluded'}
              </span>
              <div className="flex-1" />
              <button
                type="button"
                data-testid="review-discard-one"
                onClick={() => rv.requestDiscard([sel.captureId])}
                title="Never uploaded and not worth keeping. Irreversible; a reason is required."
                className="rounded-control border border-red-200 px-2.5 py-1 text-[11.5px] font-bold text-red-700 transition-colors hover:bg-red-50"
              >
                Discard (not uploaded)…
              </button>
              <button
                type="button"
                data-testid="review-delete-one"
                onClick={() => rv.requestDelete([sel.captureId])}
                title="Remove this recording from this machine. The catalog keeps a record of it."
                className="rounded-control border border-gray-300 px-2.5 py-1 text-[11.5px] font-semibold text-gray-700 transition-colors hover:bg-gray-100"
              >
                Delete…
              </button>
            </div>
            {/* Only claim there is space to reclaim when the bytes are actually
                here. Printing it directly under "The files vanished from this
                machine" told the operator to free space that is already gone. */}
            <span className="text-[11px] text-gray-400">
              {bytesHere
                ? 'Excluding is only a label — the recording still occupies disk. ' +
                  'Both removals free that space and neither can be undone.'
                : 'Excluding is only a label. This machine no longer holds the ' +
                  'files, so there is no space to reclaim — a removal records ' +
                  'the decision, and cannot be undone.'}
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
          {/* Validation reads the local MCAP — gated until it's on this PC. */}
          <button
            type="button"
            onClick={rv.goValidation}
            disabled={!showInspection}
            title={showInspection ? undefined : availability.detail}
            className={cn(
              'text-[12.5px] font-semibold',
              showInspection
                ? 'text-teal-700 hover:underline'
                : 'cursor-not-allowed text-gray-300',
            )}
          >
            Open in Validation →
          </button>
          <div className="flex-1" />
          {/* The CAS token. Shown because it is the thing a conflict is about:
              when another terminal saves first, this is the number that moved. */}
          <span data-testid="review-revision" className="text-[11.5px] text-gray-400">
            {sel.reviewRevision === 0
              ? 'not reviewed yet'
              : `revision ${sel.reviewRevision}`}
          </span>
        </div>
      </div>

      {/* Pinned decision bar — always visible, never behind a scroll. Exception-
          review actions: a NEEDS CHECK exception is resolved (Mark OK /
          Exclude); a READY capture needs no review, but it still needs to have
          been ADOPTED before Datasets will take it. */}
      <div
        data-testid="review-decision-bar"
        className="flex flex-col gap-2 border-t border-gray-100 bg-gray-50/60 px-[18px] py-3"
      >
        <div className="flex flex-wrap gap-1.5">
          {/* One control, two vocabularies. Adoption is what Datasets requires
              (data.ts: a capture Review has not adopted is refused), and it was
              reachable ONLY from the NEEDS CHECK lane — so a good take, which
              never visits that lane, could not enter a training set while a
              mediocre one could. It disappears once adopted: a READY, adopted
              capture genuinely needs no action.

              Captures saved from Collect as a good success now arrive adopted;
              this stays for everything recorded before that, and for anything
              written by something other than this screen. */}
          {sel.reviewLane !== 'excluded' && sel.effectiveReviewStatus !== 'adopted' && (
            <DecisionButton
              tone="adopt"
              testId="review-mark-ok"
              onClick={rv.markOk}
              disabled={saving}
            >
              {sel.reviewLane === 'needs_check'
                ? 'Mark OK — include'
                : 'Adopt — include in datasets'}
            </DecisionButton>
          )}
          {sel.reviewLane !== 'excluded' && (
            <DecisionButton
              tone="exclude"
              testId="review-decision-exclude"
              onClick={() => rv.decide('excluded')}
              disabled={saving}
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
              disabled={saving}
            >
              {sel.reviewLane === 'excluded'
                ? '↩ Return to review'
                : '↩ Reset to needs check'}
            </DecisionButton>
          )}
        </div>

        {/* Why the controls above are inert for a moment. Without it the
            operator's second click lands in silence, which reads as a screen
            that has stopped responding. */}
        {saving && (
          <span data-testid="review-saving" className="text-[11.5px] text-gray-500">
            Saving…
          </span>
        )}

        {/* A discoverable bin for a fumbled take (audit P1: delete only
            appeared AFTER excluding, so "get the disk space back" had no
            findable path). Muted on purpose — exclude stays the primary flow;
            the same reason-required, irreversible dialog does the guarding. */}
        {!sel.isExcluded && (
          <button
            type="button"
            data-testid="review-delete-direct"
            onClick={() => rv.requestDelete([sel.captureId])}
            title="Remove this recording from this machine. The catalog keeps a record. A dialog confirms first."
            className="self-start rounded-control px-2 py-1 text-[11.5px] font-medium text-gray-400 transition-colors hover:bg-red-50 hover:text-red-700"
          >
            🗑 Delete this recording…
          </button>
        )}

      </div>
    </div>
  );
}
