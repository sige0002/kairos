// The phase-driven control card (left column, top): READY / ARMING /
// RECORDING / SAVING+QUICK-CHECK / EPISODE RESULT / PAUSED / ENDED / COMPLETED —
// or, when a recording is running that this screen isn't driving, the takeover
// card (D-1). Exactly one renders at a time, keyed off `machine`.

import { useEffect, useRef, useState } from 'react';
import { Card, cn } from '../../components/ui';
import type { RecordArming } from '../../api/types';
import { readCaptureError } from '../captures/errors';
import { formatBytes, formatTimeOfDay } from '../review/format';
import { CARD_PAD } from './compact';
import {
  describeTaskOutcome,
  QUALITY_LABEL,
  type BatchMachine,
  type MachineError,
  type QualityOverride,
} from './useBatchMachine';
import { useFailReasons } from '../plans';

// Card gap that tightens on short viewports (see compact.ts).
const CARD_GAP_COMPACT = '[@media(max-height:860px)]:gap-1.5';

// Operator-facing copy for known recorder error codes (D-8-1). Unknown codes
// fall through to the raw server message; the code is always shown muted below.
const ERROR_COPY: Record<string, string> = {
  already_recording:
    'A recording is already in progress — stop it before starting a new one.',
  not_recording: 'No recording is in progress.',
  recorder_unreachable: "Can't reach the recorder — check the robot connection.",
};

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `00:${mm}:${ss}`;
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-control border border-red-200 bg-red-50/70 px-3 py-2 text-[12px] text-red-800"
    >
      {children}
    </div>
  );
}

// A recorder error, shown operator-first: a friendly line (mapped from the code,
// or the raw server message when unknown) plus a muted mono `(code)` line so the
// raw code is available without leaking into the primary message (D-8-1).
function MachineErrorBanner({ label, error }: { label: string; error: MachineError }) {
  const line = (error.code && ERROR_COPY[error.code]) || error.message;
  return (
    <ErrorBanner>
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em]">
        {label}
      </span>{' '}
      <span>{line}</span>
      {error.code && (
        <span className="mt-0.5 block font-mono text-[11px] opacity-70">
          ({error.code})
        </span>
      )}
    </ErrorBanner>
  );
}

// Real arming matched/missing note (OL-①.4): a live, non-persisted aid read
// straight from /record/status — NOT a mock hold. A non-empty `missing` is the
// useful signal: the readiness gate resumed with those target topics still not
// matched. Mirrors v1 LiveTab's ArmingNote wording.
function ArmingNote({ arming }: { arming: RecordArming }) {
  const matched = arming.matched_topics ?? [];
  // Both not-captured causes (no publisher / not subscribed yet) — this note
  // counts what the gate is still waiting on, and the Active warnings card is
  // where the two are told apart.
  const missing = [
    ...(arming.missing_topics ?? []),
    ...(arming.unsubscribed_topics ?? []),
  ];
  if (matched.length === 0 && missing.length === 0) return null;
  const ok = missing.length === 0;
  const shown = missing.slice(0, 4);
  return (
    <div
      data-testid="arming-note"
      className={cn(
        'flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-control border px-3 py-2 text-[12px]',
        ok
          ? 'border-teal-200 bg-teal-50/60 text-teal-800'
          : 'border-amber-200 bg-amber-50/70 text-amber-800',
      )}
    >
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em]">
        Armed
      </span>
      <span className="font-mono">{matched.length} matched</span>
      {missing.length > 0 && (
        <>
          <span className="opacity-40">·</span>
          <span className="font-mono font-semibold">{missing.length} missing</span>
          <span
            className="truncate font-mono text-[11px] opacity-80"
            title={missing.join('\n')}
          >
            {shown.join(', ')}
            {missing.length > shown.length ? ' …' : ''}
          </span>
        </>
      )}
    </div>
  );
}

// Real recording-integrity banner (OL-①): shown in the episode result when the
// just-finished run lost messages to the recorder cache (`dropped`) or failed
// verification (`failed`). Driven by the REAL /record/status integrity — it
// carries the recorder's own wording (matches v1 LiveTab IntegrityNote).
function IntegrityBanner({
  integrity,
  dropped,
}: {
  integrity: 'dropped' | 'failed';
  dropped: number | null;
}) {
  const failed = integrity === 'failed';
  return (
    <div
      role="alert"
      data-testid="integrity-banner"
      className={cn(
        'flex flex-col gap-0.5 rounded-control border-2 px-3 py-2.5',
        failed
          ? 'border-red-300 bg-red-50 text-red-800'
          : 'border-amber-300 bg-amber-50 text-amber-900',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'h-2 w-2 shrink-0 rounded-sm',
            failed ? 'bg-red-600' : 'bg-amber-600',
          )}
        />
        <span className="text-[13px] font-bold">
          {failed
            ? 'Recording failed — bag unreadable'
            : `Data dropped — ${dropped != null ? dropped.toLocaleString() : '?'} messages lost`}
        </span>
      </div>
      <span className="pl-4 text-xs">
        {failed
          ? 'The bag could not be verified or read back.'
          : 'Recorder cache overflowed — raise max_cache_size_mb.'}
      </span>
    </div>
  );
}

// The orchestrator's SETTLED quick-check reasons (F1): the plain-language "why
// needs_review" list, shown verbatim so the operator sees exactly what the
// server flagged (e.g. "/hsrb/hand_camera/image_raw/compressed avg 9.982Hz <
// expected 30Hz") without opening JSON. Only rendered when the verdict is in.
function QuickCheckReasons({ reasons }: { reasons: string[] }) {
  return (
    <div
      data-testid="quickcheck-reasons"
      className="flex flex-col gap-1 rounded-control border border-amber-200 bg-amber-50/60 px-3 py-2 text-amber-800"
    >
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em]">
        Quick check flagged
      </span>
      <ul className="flex flex-col gap-0.5">
        {reasons.map((reason, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="opacity-50">·</span>
            <span className="font-mono text-[11px] leading-snug">{reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// A refused review save (contract §12). It is never a passing note: a 500 means
// NOTHING was saved, and an operator who read "Saved" and walked away would lose
// the take's labels entirely. The destructive codes get the loud treatment and
// both stay until dismissed. The block carries the backend's own message plus
// what to do next, because "409" alone is not actionable.
function SaveErrorBanner({
  error,
  onDismiss,
}: {
  error: unknown;
  onDismiss: () => void;
}) {
  const reading = readCaptureError(error, 'review');
  const destructive = reading.severity === 'destructive';
  return (
    <div
      role="alert"
      data-testid="save-error"
      data-error-code={reading.code}
      className={cn(
        'flex flex-col gap-1 rounded-control px-3 py-2.5 text-[12px]',
        destructive
          ? 'border-2 border-red-400 bg-red-50 text-red-900'
          : 'border border-amber-300 bg-amber-50 text-amber-900',
      )}
    >
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em]">
        {destructive ? 'Not saved' : 'Save refused'}
      </span>
      <span className="font-semibold">{reading.message}</span>
      {reading.guidance && <span>{reading.guidance}</span>}
      <button
        type="button"
        onClick={onDismiss}
        data-testid="save-error-dismiss"
        className="self-start text-[11.5px] font-semibold underline"
      >
        Dismiss
      </button>
    </div>
  );
}

// One "Label : value" row in the takeover card (D-1). Values are real recorder
// data; missing ones render "—" (never fabricated).
function FieldRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        {label}
      </span>
      <div className="flex-1" />
      <span className={cn('text-[13px] text-gray-800', mono && 'font-mono text-xs')}>
        {value}
      </span>
    </div>
  );
}

export function ControlCard({ machine }: { machine: BatchMachine }) {
  const { phase, stats } = machine;
  const takeover = machine.takeover;
  // Live fail-reason vocabulary (Settings > Failure reasons; shared store).
  const failReasons = useFailReasons();

  // Two-step confirm for "Start next set": one click used to silently clear
  // the finished set's panel (episodes stay in Review, but the operator can't
  // know that) — the first press now asks, the second acts. Auto-reverts.
  const [confirmNextSet, setConfirmNextSet] = useState(false);
  useEffect(() => {
    if (!confirmNextSet) return;
    const t = setTimeout(() => setConfirmNextSet(false), 5000);
    return () => clearTimeout(t);
  }, [confirmNextSet]);
  const onStartNextSet = () => {
    if (!confirmNextSet) {
      setConfirmNextSet(true);
      return;
    }
    setConfirmNextSet(false);
    machine.startNextBatch();
  };

  // Focus targets for each phase (D-4): re-target on every phase change so the
  // flow stays keyboard-operable and focus never falls to <body>.
  const startRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const savingTitleRef = useRef<HTMLSpanElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const failReasonRef = useRef<HTMLButtonElement>(null);
  const takeoverStopRef = useRef<HTMLButtonElement>(null);
  const hasTakeover = !!takeover;
  useEffect(() => {
    if (hasTakeover) {
      takeoverStopRef.current?.focus();
      return;
    }
    switch (phase) {
      case 'ready':
        startRef.current?.focus();
        break;
      case 'arming':
        cancelRef.current?.focus();
        break;
      case 'recording':
        stopRef.current?.focus();
        break;
      case 'saving':
      case 'quickcheck':
        savingTitleRef.current?.focus();
        break;
      case 'result':
        if (machine.pendingTask === 'fail') failReasonRef.current?.focus();
        else saveRef.current?.focus();
        break;
    }
    // `machine.canStop` is a dependency because focus() on a DISABLED button is
    // a no-op: Stop is disabled for the first STOP_FLOOR_MS of every take, so
    // the recording branch above fired while there was nothing to focus, and
    // without re-running when Stop becomes enabled focus stayed on <body> for
    // the WHOLE take. (Second effect-dependency bug of this shape: the logic was
    // right and the deps made it read a stale world.)
  }, [phase, machine.pendingTask, hasTakeover, machine.canStop]);

  // Takeover card's own once-a-second elapsed ticker (the recording card uses
  // the machine's own timer instead).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasTakeover) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [hasTakeover]);

  // Quality override expander (D-2): collapsed by default; opening it reveals the
  // three chips. Auto-open once the operator has already overridden.
  const [qualityOpen, setQualityOpen] = useState(false);

  if (takeover) {
    const elapsedMs = takeover.startedAt
      ? Math.max(0, Date.now() - Date.parse(takeover.startedAt))
      : null;
    return (
      <Card
        className={cn(
          'flex shrink-0 flex-col gap-2.5 border-2 border-red-200',
          CARD_GAP_COMPACT,
          CARD_PAD,
        )}
      >
        <div className="flex items-center gap-2">
          <span className="h-[9px] w-[9px] animate-recpulse rounded-sm bg-red-600" />
          <span
            data-testid="phase-title"
            className="text-[15px] font-bold text-red-700"
          >
            RECORDING IN PROGRESS
          </span>
        </div>
        <span className="text-[12.5px] leading-relaxed text-gray-600">
          {machine.takeoverResumedOwn
            ? 'Recording resumed — this was started here earlier.'
            : "A recording is running on this robot — it wasn't started from this screen."}
        </span>
        <div className="flex flex-col gap-1.5 rounded-control border border-gray-200 bg-gray-50 px-3 py-2.5">
          {/* The run_id is the name the operator recognises on disk; it is shown
              and never used as a key (§1). "—" until the capture loads. */}
          <FieldRow label="Run" value={takeover.runLabel ?? '—'} mono />
          <div className="flex items-baseline gap-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
              Elapsed
            </span>
            <div className="flex-1" />
            <span
              data-testid="takeover-elapsed"
              className="font-mono text-[34px] font-semibold text-gray-900"
            >
              {elapsedMs != null ? formatElapsed(elapsedMs) : '—'}
            </span>
          </div>
          <FieldRow
            label="Written"
            value={takeover.bytes != null ? formatBytes(takeover.bytes) : '—'}
            mono
          />
          <FieldRow label="Operator" value={takeover.operator || '—'} />
          <FieldRow
            label="Topics"
            value={
              takeover.topicsCount != null ? `${takeover.topicsCount} topics` : '—'
            }
          />
        </div>
        <button
          ref={takeoverStopRef}
          type="button"
          onClick={machine.openTakeoverStopModal}
          className="flex h-[52px] items-center justify-center gap-2 rounded-control bg-red-600 text-[15px] font-bold text-white shadow-btn-red hover:bg-red-700 [@media(max-height:860px)]:h-[44px]"
        >
          <span className="h-[11px] w-[11px] rounded-sm bg-white" />
          Stop recording
        </button>
        <button
          type="button"
          onClick={machine.goMonitor}
          className="self-start text-[12.5px] font-semibold text-teal-700 hover:underline"
        >
          Open in Monitor →
        </button>
      </Card>
    );
  }

  if (phase === 'ready') {
    return (
      <Card
        className={cn(
          'flex shrink-0 flex-col gap-2.5 border-2 border-teal-200',
          CARD_GAP_COMPACT,
          CARD_PAD,
        )}
      >
        <div className="flex items-center gap-2">
          <span className="h-[9px] w-[9px] animate-recpulse rounded-sm bg-teal-600" />
          <span
            data-testid="phase-title"
            className="text-[17px] font-bold text-teal-700"
          >
            READY
          </span>
          <div className="flex-1" />
          <span className="font-mono text-xs text-gray-500">
            Ep {stats.epNext} / {machine.targetEpisodes}
          </span>
        </div>
        {/* Real next-start summary (was a fabricated "12/12 topics live"). */}
        <span className="text-xs text-gray-500">
          Next recording captures{' '}
          {machine.selection.customized
            ? `${machine.selection.count} selected topic${machine.selection.count === 1 ? '' : 's'}`
            : machine.selection.topics === 'all'
              ? 'all topics'
              : `${machine.selection.count} configured topics`}
          {/* Server-reported pre-armed (two-phase start): the recorder is
              spawned + subscribed, so this Start is a near-instant resume.
              Shown only when the recorder actually says so. */}
          {machine.preArmed && (
            <span
              data-testid="prearmed-note"
              className="ml-1.5 inline-flex items-center gap-1 font-medium text-teal-700"
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-teal-500" />
              pre-armed · instant start
            </span>
          )}
        </span>
        <button
          ref={startRef}
          type="button"
          data-testid="start-recording"
          onClick={machine.startRecording}
          disabled={machine.noSelection || machine.operatorMissing}
          className={cn(
            'flex h-[52px] items-center justify-center gap-2 rounded-control text-[15px] font-bold shadow-btn [@media(max-height:860px)]:h-[44px]',
            machine.noSelection || machine.operatorMissing
              ? 'cursor-not-allowed bg-gray-200 text-gray-400'
              : 'bg-teal-600 text-white hover:bg-teal-700',
          )}
        >
          <span className="h-2.5 w-2.5 rounded-full bg-white" />
          Start recording
          <span className="text-[11px] font-medium opacity-70">· R</span>
        </button>
        {machine.noSelection && (
          <span className="text-[11px] font-medium text-amber-600">
            Every topic is cleared — select at least one in Monitor to record.
          </span>
        )}
        {machine.operatorMissing && (
          <span data-testid="operator-gate-note" className="text-[11px] font-medium text-amber-600">
            Pick your name first (OP chip, top right) — recordings must say who
            made them.
          </span>
        )}
        {machine.startError && (
          <MachineErrorBanner label="Start failed" error={machine.startError} />
        )}
      </Card>
    );
  }

  if (phase === 'arming') {
    return (
      <Card
        className={cn(
          'flex shrink-0 flex-col gap-2.5 border-2 border-amber-200',
          CARD_GAP_COMPACT,
          CARD_PAD,
        )}
      >
        <div className="flex items-center gap-2">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-100 border-t-amber-600" />
          <span
            data-testid="phase-title"
            className="text-[17px] font-bold text-amber-700"
          >
            ARMING…
          </span>
        </div>
        <span className="text-[12.5px] leading-relaxed text-amber-800">
          Hold still. Recording starts automatically once the recorder confirms.
        </span>
        <button
          ref={cancelRef}
          type="button"
          onClick={machine.cancelArming}
          className="h-10 rounded-control border border-gray-200 bg-white text-[13px] font-semibold text-gray-500 hover:bg-gray-50"
        >
          Cancel
        </button>
        {machine.arming && <ArmingNote arming={machine.arming} />}
      </Card>
    );
  }

  if (phase === 'recording') {
    const elapsedText = formatElapsed(machine.elapsedMs);
    // B1: the recorder has stopped answering. We do NOT know that the recording
    // is still running, so the card stops asserting that it is — the pulsing
    // dot, the red RECORDING word and the live timer are all claims about a
    // thing we can no longer see. The last known values stay, labelled as such.
    const unreachable = machine.recorderUnreachable;
    const staleText =
      machine.recorderStaleMs != null
        ? `${Math.round(machine.recorderStaleMs / 1000)}s ago`
        : 'unknown';
    // Real bytes written for this run (from /record/status), not elapsed×rate.
    const writtenText =
      machine.recordingBytes != null
        ? `${formatBytes(machine.recordingBytes)} written`
        : '—';
    return (
      <Card
        className={cn(
          'flex shrink-0 flex-col gap-2.5 border-2 border-red-200',
          CARD_GAP_COMPACT,
          CARD_PAD,
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'h-[9px] w-[9px] rounded-sm',
              unreachable ? 'bg-amber-500' : 'animate-recpulse bg-red-600',
            )}
          />
          <span
            data-testid="phase-title"
            className={cn(
              'text-[17px] font-bold',
              unreachable ? 'text-amber-700' : 'text-red-700',
            )}
          >
            {unreachable ? 'RECORDER UNREACHABLE' : 'RECORDING'}
          </span>
          <div className="flex-1" />
          <span className="font-mono text-xs text-gray-500">
            Ep {stats.epNext} / {machine.targetEpisodes}
          </span>
        </div>
        {unreachable && (
          <p
            data-testid="recorder-unreachable-note"
            className="rounded-control border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] leading-relaxed text-amber-900"
          >
            The recorder is not answering. Last known:{' '}
            <span className="font-semibold">recording</span>, {staleText}. Whether
            it is still running cannot be confirmed from here — the figures below
            are the last ones it reported, not current.
          </p>
        )}
        <div className="flex items-baseline gap-2.5">
          <span
            data-testid="elapsed"
            className={cn(
              'font-mono text-[34px] font-semibold',
              unreachable ? 'text-gray-400' : 'text-gray-900',
            )}
            title={unreachable ? `Frozen at the last confirmed reading (${staleText})` : undefined}
          >
            {elapsedText}
          </span>
          <span className="font-mono text-xs text-gray-400">{writtenText}</span>
        </div>
        {/* Stop occupies the position Start just vacated, so the second half
            of a double-click lands here. Refused for the first moment of a
            take — see STOP_FLOOR_MS. */}
        <button
          ref={stopRef}
          type="button"
          data-testid="stop-recording"
          onClick={machine.stopRecording}
          disabled={!machine.canStop}
          title={
            machine.stopBlockedReason === 'floor'
              ? 'Just started — Stop is available a moment from now, so a ' +
                'double-click on Start cannot end the take it just began.'
              : undefined
          }
          className={cn(
            'flex h-[52px] items-center justify-center gap-2 rounded-control text-[15px] font-bold shadow-btn-red [@media(max-height:860px)]:h-[44px]',
            machine.canStop
              ? 'bg-red-600 text-white hover:bg-red-700'
              : 'cursor-not-allowed bg-red-300 text-white/80',
          )}
        >
          <span className="h-[11px] w-[11px] rounded-sm bg-white" />
          Stop recording
          <span className="text-[11px] font-medium opacity-70">· S</span>
        </button>
        {machine.arming && <ArmingNote arming={machine.arming} />}
      </Card>
    );
  }

  if (phase === 'saving' || phase === 'quickcheck') {
    const saving = phase === 'saving';
    return (
      <Card
        className={cn(
          'flex shrink-0 flex-col gap-2.5 border-2 border-gray-200',
          CARD_GAP_COMPACT,
          CARD_PAD,
        )}
      >
        <div className="flex items-center gap-2">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-100 border-t-teal-600" />
          <span
            ref={savingTitleRef}
            data-testid="phase-title"
            tabIndex={-1}
            aria-live="polite"
            className="text-[17px] font-bold text-gray-700 outline-none"
          >
            {saving ? 'SAVING…' : 'QUICK CHECK…'}
          </span>
        </div>
        <span className="text-[12.5px] leading-relaxed text-gray-500">
          {saving
            ? 'Finalizing the recording…'
            : 'Reading recorded counts, gaps and integrity.'}
        </span>
        {/* Indeterminate progress — the real duration isn't known, so no fake %. */}
        <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
          <span className="block h-full w-1/3 animate-pulse rounded-full bg-teal-500" />
        </div>
        {machine.stopError && (
          <>
            <MachineErrorBanner label="Stop failed" error={machine.stopError} />
            <button
              type="button"
              onClick={machine.retryStop}
              className="h-10 rounded-control bg-red-600 text-[13px] font-bold text-white hover:bg-red-700"
            >
              Retry stop
            </button>
          </>
        )}
      </Card>
    );
  }

  if (phase === 'result') {
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
          <span
            data-testid="phase-title"
            className="text-[15px] font-bold text-gray-900"
          >
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
        {machine.quickCheck.verdict &&
          machine.quickCheck.verdict.reasons.length > 0 && (
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
              onClick={() => setQualityOpen((v) => !v)}
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
            <span
              data-testid="quickcheck-pending"
              className="text-[11px] text-gray-400"
            >
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

  if (phase === 'paused') {
    return (
      <Card
        className={cn(
          'flex shrink-0 flex-col gap-2.5 border-2 border-gray-200',
          CARD_GAP_COMPACT,
          CARD_PAD,
        )}
      >
        <div className="flex items-center gap-2">
          <span className="h-[9px] w-[9px] rounded-sm bg-gray-400" />
          <span
            data-testid="phase-title"
            className="text-[17px] font-bold text-gray-500"
          >
            PAUSED
          </span>
        </div>
        <span className="text-[12.5px] text-gray-500">
          Set is paused. Recorded episodes are safe.
        </span>
        <button
          type="button"
          onClick={machine.resumeBatch}
          className="h-[46px] rounded-control bg-teal-600 text-sm font-bold text-white hover:bg-teal-700"
        >
          Resume set
        </button>
      </Card>
    );
  }

  const endSummary = `${stats.nRecorded} recorded (${stats.nGood} good · ${stats.nReview} review · ${stats.nTaskFailed} task failed), ${stats.nRemaining} not recorded`;

  if (phase === 'ended') {
    return (
      <Card
        className={cn(
          'flex shrink-0 flex-col gap-2.5 border-2 border-amber-200',
          CARD_GAP_COMPACT,
          CARD_PAD,
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-bold text-gray-900">
            Batch {machine.batchSeq ?? '—'} ended early
          </span>
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
          data-testid="start-next-set"
          onClick={onStartNextSet}
          className={cn(
            'h-[46px] rounded-control text-sm font-bold text-white',
            confirmNextSet
              ? 'bg-amber-600 hover:bg-amber-700'
              : 'bg-teal-600 hover:bg-teal-700',
          )}
        >
          {confirmNextSet ? 'Press again to start the next set' : 'Start next set'}
        </button>
        {confirmNextSet && (
          <span data-testid="next-set-note" className="text-[11.5px] text-gray-500">
            This panel starts a fresh set — the recorded episodes stay saved in
            Review.
          </span>
        )}
      </Card>
    );
  }

  // phase === 'completed'
  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2.5 border-2 border-green-200',
        CARD_GAP_COMPACT,
        CARD_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[15px] font-bold text-gray-900">
          Batch {machine.batchSeq ?? '—'} completed 🎉
        </span>
        <div className="flex-1" />
        <span className="rounded-chip bg-green-100 px-2 py-0.5 text-[11px] font-bold text-green-700">
          COMPLETE
        </span>
      </div>
      <span className="text-[12.5px] leading-relaxed text-gray-500">
        {endSummary}. Nice work — all {machine.targetEpisodes} episodes recorded.
      </span>
      <button
        type="button"
        data-testid="start-next-set"
        onClick={onStartNextSet}
        className={cn(
          'h-[46px] rounded-control text-sm font-bold text-white',
          confirmNextSet
            ? 'bg-amber-600 hover:bg-amber-700'
            : 'bg-teal-600 hover:bg-teal-700',
        )}
      >
        {confirmNextSet ? 'Press again to start the next set' : 'Start next set'}
      </button>
      {confirmNextSet && (
        <span data-testid="next-set-note" className="text-[11.5px] text-gray-500">
          This panel starts a fresh set — the recorded episodes stay saved in
          Review.
        </span>
      )}
    </Card>
  );
}
