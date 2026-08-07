// EPISODE RESULT: the one card where the operator decides something. The
// quick-check verdict is the server's; the task outcome is theirs; and nothing
// is written until Save.

import { Card, cn } from '../../../components/ui';
import { formatTimeOfDay } from '../../review/format';
import { CARD_PAD } from '../compact';
import {
  describeTaskOutcome,
  QUALITY_LABEL,
  type BatchMachine,
  type QualityOverride,
} from '../useBatchMachine';
import { IntegrityBanner, QuickCheckReasons, SaveErrorBanner } from './banners';

export function ResultCard({
  machine,
  failReasons,
  qualityOpen,
  onToggleQuality,
  saveRef,
  failReasonRef,
}: {
  machine: BatchMachine;
  failReasons: string[];
  qualityOpen: boolean;
  onToggleQuality: () => void;
  saveRef: React.Ref<HTMLButtonElement>;
  failReasonRef: React.Ref<HTMLButtonElement>;
}) {
  const { stats } = machine;
  const quickGood = machine.autoQuality === 'good';
  const isFail = machine.pendingTask === 'fail';
  const saving = machine.isSavingReview;
  const canConfirm =
    !saving && (machine.pendingTask === 'ok' || (isFail && !!machine.failReason));
  const willComplete = stats.nRecorded + 1 >= machine.targetEpisodes;
  const saveLabel = saving
    ? 'Saving…'
    : isFail
      ? 'Save — failure'
      : willComplete
        ? 'Save — success · finishes set'
        : 'Save — success';
  const effectiveQuality: QualityOverride =
    machine.qualityOverride ?? machine.autoQuality;
  const qualityAuto = machine.qualityOverride == null;
  const qualityChips: QualityOverride[] = ['good', 'review', 'notusable'];
  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-3 border-2 border-teal-200',
        '[@media(max-height:860px)]:gap-1.5',
        CARD_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <span data-testid="phase-title" className="text-[15px] font-bold text-gray-900">
          Episode {stats.epNext} result
        </span>
        {/* WHICH take this panel is about. The recovery banner above can be
            describing a DIFFERENT unsaved take at the same time, each with its
            own Discard — so both have to name themselves or the two Discards
            are indistinguishable. Start time is the thing an operator can
            actually match against the banner; the run name follows for the
            on-disk identity (§1: display only — every call keys on
            capture_id). */}
        <span
          data-testid="result-take-identity"
          className="truncate font-mono text-[11px] text-gray-400"
          title={machine.currentRunLabel ?? undefined}
        >
          {machine.currentTakeStartedAt
            ? `started ${formatTimeOfDay(machine.currentTakeStartedAt)}`
            : 'start time unknown'}
          {machine.currentRunLabel ? ` · ${machine.currentRunLabel}` : ''}
        </span>
        <div className="flex-1" />
        <span
          className={cn(
            'rounded-chip px-2 py-0.5 text-[11px] font-bold',
            quickGood ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-800',
          )}
        >
          {quickGood ? 'QUICK: GOOD' : 'QUICK: NEEDS REVIEW'}
        </span>
      </div>
      {(machine.integrity === 'dropped' || machine.integrity === 'failed') && (
        <IntegrityBanner
          integrity={machine.integrity}
          dropped={machine.droppedMessages}
        />
      )}
      {/* Settled quick-check reasons (F1): the server's verdict "why", shown
          verbatim when it flagged the run for review. */}
      {machine.quickCheck.verdict && machine.quickCheck.verdict.reasons.length > 0 && (
        <QuickCheckReasons reasons={machine.quickCheck.verdict.reasons} />
      )}
      {/* Honest quality line (D-2): the effective quality + its provenance, with
          an override affordance — no fabricated "camera rate dropped". */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-600">
            Quality:{' '}
            <span
              className={cn(
                'font-semibold',
                quickGood ? 'text-green-700' : 'text-amber-700',
              )}
            >
              {QUALITY_LABEL[effectiveQuality]}
            </span>
            {qualityAuto && <span className="text-gray-400"> · auto</span>}
          </span>
          <button
            type="button"
            onClick={onToggleQuality}
            className="text-teal-700 hover:underline"
          >
            change
          </button>
        </div>
        {/* Honest settlement status (F1): a subtle "running…" note while the
            server verdict is still settling; once it lands the chip + reasons
            carry the call, so nothing lingers here. Never a fabricated value,
            and saving is never blocked on it. */}
        {machine.quickCheck.pending && (
          <span data-testid="quickcheck-pending" className="text-[11px] text-gray-400">
            Quick check running…
          </span>
        )}
        {qualityOpen && (
          <div data-testid="quality-chips" className="flex flex-wrap gap-1.5">
            {qualityChips.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => machine.setQuality(q)}
                className={cn(
                  'rounded-chip border px-2.5 py-1 text-[11px] font-semibold',
                  effectiveQuality === q
                    ? 'border-teal-600 bg-teal-50 text-teal-700'
                    : 'border-gray-200 bg-white font-medium text-gray-500',
                )}
              >
                {QUALITY_LABEL[q]}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Task result — your call
        </span>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={machine.pickSuccess}
            className={cn(
              'h-[42px] flex-1 rounded-control text-[13px] font-bold',
              machine.pendingTask === 'ok'
                ? 'bg-green-600 text-white'
                : 'border border-gray-200 bg-white text-gray-500',
            )}
          >
            ✓ Success
          </button>
          <button
            type="button"
            onClick={machine.pickFailure}
            className={cn(
              'h-[42px] flex-1 rounded-control text-[13px] font-bold',
              machine.pendingTask === 'fail'
                ? 'bg-red-600 text-white'
                : 'border border-gray-200 bg-white text-gray-500',
            )}
          >
            ✕ Failure
          </button>
        </div>
      </div>
      {machine.pendingTask === 'fail' && (
        <div className="flex flex-col gap-1.5 rounded-control border border-red-200 bg-red-50 px-3 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-red-700">
            What failed? (required)
          </span>
          <div className="flex flex-wrap gap-1.5">
            {failReasons.map((reason, i) => (
              <button
                key={reason}
                ref={i === 0 ? failReasonRef : undefined}
                type="button"
                onClick={() => machine.pickFailReason(reason)}
                className={cn(
                  'rounded-chip border px-2.5 py-1.5 text-xs font-semibold',
                  reason === machine.failReason
                    ? 'border-red-600 bg-white text-red-700'
                    : 'border-red-200 bg-white font-medium text-gray-500',
                )}
              >
                {reason}
              </button>
            ))}
          </div>
        </div>
      )}
      {machine.pendingTask && (
        <div
          data-testid="episode-summary"
          className="flex flex-col gap-1 rounded-control border border-gray-200 bg-gray-50 px-3 py-2.5 text-xs leading-relaxed text-gray-600"
        >
          <span>
            <span className="font-semibold text-gray-700">Task outcome:</span>{' '}
            {describeTaskOutcome(machine.pendingTask, machine.failReason)}
          </span>
          <span className="text-gray-500">
            Saved onto the recording itself — visible in Review either way.
          </span>
        </div>
      )}
      {machine.saveError != null && (
        <SaveErrorBanner
          error={machine.saveError}
          onDismiss={machine.dismissSaveError}
        />
      )}
      <button
        ref={saveRef}
        type="button"
        onClick={machine.confirmEpisode}
        disabled={!canConfirm}
        data-testid="save-episode"
        className={cn(
          'h-[46px] rounded-control text-sm font-bold [@media(max-height:860px)]:h-[40px]',
          canConfirm
            ? 'bg-teal-600 text-white shadow-btn'
            : 'cursor-not-allowed bg-gray-200 text-gray-400',
        )}
      >
        {saveLabel}
      </button>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={machine.retakeEpisode}
          disabled={saving || machine.episodeDiscard.busy}
          data-testid="retake-episode"
          title="Discards this take (ledger reason: superseded by retake) and immediately starts recording again under the same labels."
          className="h-9 flex-1 rounded-control border border-teal-200 bg-teal-50 text-[12.5px] font-semibold text-teal-700 hover:bg-teal-100 disabled:cursor-not-allowed disabled:opacity-50 [@media(max-height:860px)]:h-8"
        >
          ⟲ Retake — discard &amp; record again
        </button>
        <button
          type="button"
          onClick={machine.discardEpisode}
          disabled={saving || machine.episodeDiscard.busy}
          data-testid="discard-episode"
          className="h-9 flex-1 rounded-control border border-gray-200 bg-white text-[12.5px] font-semibold text-gray-500 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 [@media(max-height:860px)]:h-8"
        >
          Discard only
        </button>
      </div>
    </Card>
  );
}
