// The phase-driven control card (left column, top): READY / ARMING /
// RECORDING / SAVING+QUICK-CHECK / EPISODE RESULT / PAUSED / ENDED / COMPLETED.
// Exactly one renders at a time, keyed off `machine.phase`.

import { Card, cn } from '../../components/ui';
import {
  describeQuality,
  describeTaskOutcome,
  EPISODES_PER_BATCH,
  FAIL_REASONS,
  MB_PER_S,
  type BatchMachine,
} from './useBatchMachine';

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `00:${mm}:${ss}`;
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="rounded-control border border-red-200 bg-red-50/70 px-3 py-2 text-[12px] text-red-800">
      {children}
    </div>
  );
}

export function ControlCard({ machine }: { machine: BatchMachine }) {
  const { phase, stats } = machine;

  if (phase === 'ready') {
    return (
      <Card className="flex shrink-0 flex-col gap-2.5 border-2 border-teal-200 p-4">
        <div className="flex items-center gap-2">
          <span className="h-[9px] w-[9px] animate-recpulse rounded-sm bg-teal-600" />
          <span data-testid="phase-title" className="text-[17px] font-bold text-teal-700">READY</span>
          <div className="flex-1" />
          <span className="font-mono text-xs text-gray-500">Ep {stats.epNext} / {EPISODES_PER_BATCH}</span>
        </div>
        <span className="text-xs text-gray-500">Start gate passed — 12/12 required topics live</span>
        <button
          type="button"
          onClick={machine.startRecording}
          className="flex h-[52px] items-center justify-center gap-2 rounded-control bg-teal-600 text-[15px] font-bold text-white shadow-btn hover:bg-teal-700"
        >
          <span className="h-2.5 w-2.5 rounded-full bg-white" />
          Start recording
        </button>
        {machine.startError && (
          <ErrorBanner>
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em]">Start failed</span>{' '}
            <span className="font-mono text-[11px] opacity-80">{machine.startError}</span>
          </ErrorBanner>
        )}
      </Card>
    );
  }

  if (phase === 'arming') {
    return (
      <Card className="flex shrink-0 flex-col gap-2.5 border-2 border-amber-200 p-4">
        <div className="flex items-center gap-2">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-100 border-t-amber-600" />
          <span data-testid="phase-title" className="text-[17px] font-bold text-amber-700">ARMING…</span>
        </div>
        <span className="text-[12.5px] leading-relaxed text-amber-800">
          Hold still. Recording starts automatically once the recorder confirms.
        </span>
        <button
          type="button"
          onClick={machine.cancelArming}
          className="h-10 rounded-control border border-gray-200 bg-white text-[13px] font-semibold text-gray-500 hover:bg-gray-50"
        >
          Cancel
        </button>
      </Card>
    );
  }

  if (phase === 'recording') {
    const elapsedText = formatElapsed(machine.elapsedMs);
    const mbText = `${((machine.elapsedMs / 1000) * MB_PER_S).toFixed(1)} MB written`;
    return (
      <Card className="flex shrink-0 flex-col gap-2.5 border-2 border-red-200 p-4">
        <div className="flex items-center gap-2">
          <span className="h-[9px] w-[9px] animate-recpulse rounded-sm bg-red-600" />
          <span data-testid="phase-title" className="text-[17px] font-bold text-red-700">RECORDING</span>
          <div className="flex-1" />
          <span className="font-mono text-xs text-gray-500">Ep {stats.epNext} / {EPISODES_PER_BATCH}</span>
        </div>
        <div className="flex items-baseline gap-2.5">
          <span data-testid="elapsed" className="font-mono text-[34px] font-semibold text-gray-900">
            {elapsedText}
          </span>
          <span className="font-mono text-xs text-gray-400">{mbText}</span>
        </div>
        <button
          type="button"
          onClick={machine.stopRecording}
          className="flex h-[52px] items-center justify-center gap-2 rounded-control bg-red-600 text-[15px] font-bold text-white shadow-btn-red hover:bg-red-700"
        >
          <span className="h-[11px] w-[11px] rounded-sm bg-white" />
          Stop recording
        </button>
      </Card>
    );
  }

  if (phase === 'saving' || phase === 'quickcheck') {
    const saving = phase === 'saving';
    const mb = ((machine.elapsedMs / 1000) * MB_PER_S).toFixed(0);
    return (
      <Card className="flex shrink-0 flex-col gap-2.5 border-2 border-gray-200 p-4">
        <div className="flex items-center gap-2">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-100 border-t-teal-600" />
          <span data-testid="phase-title" className="text-[17px] font-bold text-gray-700">{saving ? 'SAVING…' : 'QUICK CHECK…'}</span>
        </div>
        <span className="text-[12.5px] leading-relaxed text-gray-500">
          {saving
            ? `Writing MCAP and verifying integrity (${mb} MB).`
            : 'Checking required topics, gaps and camera coverage. Provisional result in seconds.'}
        </span>
        <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
          <span
            className="block h-full rounded-full bg-teal-600 transition-[width] duration-[1200ms] ease-out"
            style={{ width: saving ? '45%' : '85%' }}
          />
        </div>
        {machine.stopError && (
          <ErrorBanner>
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em]">Stop failed</span>{' '}
            <span className="font-mono text-[11px] opacity-80">{machine.stopError}</span>
          </ErrorBanner>
        )}
      </Card>
    );
  }

  if (phase === 'result') {
    const quickGood = !machine.recWarning;
    const canConfirm =
      machine.pendingTask === 'ok' || (machine.pendingTask === 'fail' && !!machine.failReason);
    const willComplete = stats.nRecorded + 1 >= EPISODES_PER_BATCH;
    const nextBtnText = willComplete ? 'Save & finish batch' : `Save & ready for #${stats.epNext + 1}`;
    return (
      <Card className="flex shrink-0 flex-col gap-3 border-2 border-teal-200 p-4">
        <div className="flex items-center gap-2">
          <span data-testid="phase-title" className="text-[15px] font-bold text-gray-900">
            Episode {stats.epNext} result
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
        <span className="text-xs text-gray-500">
          {quickGood
            ? 'No issues detected. Final quality follows after full validation.'
            : 'Right camera rate dropped during recording — flagged for review. Final quality follows after full validation.'}
        </span>
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
              {FAIL_REASONS.map((reason) => (
                <button
                  key={reason}
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
            <span>
              <span className="font-semibold text-gray-700">Recording quality:</span>{' '}
              {describeQuality(machine.recWarning)}
            </span>
            <span className="text-gray-500">Saved safely — visible in Review either way.</span>
          </div>
        )}
        <button
          type="button"
          onClick={machine.confirmEpisode}
          disabled={!canConfirm}
          className={cn(
            'h-[46px] rounded-control text-sm font-bold',
            canConfirm ? 'bg-teal-600 text-white shadow-btn' : 'cursor-not-allowed bg-gray-200 text-gray-400',
          )}
        >
          {nextBtnText}
        </button>
        <button
          type="button"
          onClick={machine.retryEpisode}
          className="h-9 rounded-control border border-gray-200 bg-white text-[12.5px] font-semibold text-gray-500 hover:bg-gray-50"
        >
          Discard &amp; re-record this episode
        </button>
      </Card>
    );
  }

  if (phase === 'paused') {
    return (
      <Card className="flex shrink-0 flex-col gap-2.5 border-2 border-gray-200 p-4">
        <div className="flex items-center gap-2">
          <span className="h-[9px] w-[9px] rounded-sm bg-gray-400" />
          <span data-testid="phase-title" className="text-[17px] font-bold text-gray-500">PAUSED</span>
        </div>
        <span className="text-[12.5px] text-gray-500">Batch is paused. Recorded episodes are safe.</span>
        <button
          type="button"
          onClick={machine.resumeBatch}
          className="h-[46px] rounded-control bg-teal-600 text-sm font-bold text-white hover:bg-teal-700"
        >
          Resume batch
        </button>
      </Card>
    );
  }

  const endSummary = `${stats.nRecorded} recorded (${stats.nGood} good · ${stats.nReview} review · ${stats.nTaskFailed} task failed), ${stats.nRemaining} not recorded`;

  if (phase === 'ended') {
    return (
      <Card className="flex shrink-0 flex-col gap-2.5 border-2 border-amber-200 p-4">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-bold text-gray-900">Batch {machine.batchNum} ended early</span>
          <div className="flex-1" />
          <span className="rounded-chip bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">
            INCOMPLETE
          </span>
        </div>
        <span className="text-[12.5px] leading-relaxed text-gray-500">
          {endSummary}. All recorded episodes are saved and visible in Review.
        </span>
        <span className="text-xs text-gray-400">Reason: {machine.endReason}</span>
        <button
          type="button"
          onClick={machine.startNextBatch}
          className="h-[46px] rounded-control bg-teal-600 text-sm font-bold text-white hover:bg-teal-700"
        >
          Set up next batch
        </button>
      </Card>
    );
  }

  // phase === 'completed'
  return (
    <Card className="flex shrink-0 flex-col gap-2.5 border-2 border-green-200 p-4">
      <div className="flex items-center gap-2">
        <span className="text-[15px] font-bold text-gray-900">Batch {machine.batchNum} completed 🎉</span>
        <div className="flex-1" />
        <span className="rounded-chip bg-green-100 px-2 py-0.5 text-[11px] font-bold text-green-700">
          COMPLETE
        </span>
      </div>
      <span className="text-[12.5px] leading-relaxed text-gray-500">
        {endSummary}. Nice work — all {EPISODES_PER_BATCH} episodes recorded.
      </span>
      <button
        type="button"
        onClick={machine.startNextBatch}
        className="h-[46px] rounded-control bg-teal-600 text-sm font-bold text-white hover:bg-teal-700"
      >
        Set up next batch
      </button>
    </Card>
  );
}
