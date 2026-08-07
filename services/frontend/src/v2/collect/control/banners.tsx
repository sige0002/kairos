// The banners and notes the phase cards raise above their own controls. All of
// them are driven by REAL recorder/orchestrator data — none of them invents a
// figure, and each says which moment it describes.

import { cn } from '../../../components/ui';
import type { RecordArming } from '../../../api/types';
import { readCaptureError } from '../../captures/errors';
import type { MachineError } from '../useBatchMachine';

// Operator-facing copy for known recorder error codes (D-8-1). Unknown codes
// fall through to the raw server message; the code is always shown muted below.
const ERROR_COPY: Record<string, string> = {
  already_recording:
    'A recording is already in progress — stop it before starting a new one.',
  not_recording: 'No recording is in progress.',
  recorder_unreachable: "Can't reach the recorder — check the robot connection.",
};

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
export function MachineErrorBanner({
  label,
  error,
}: {
  label: string;
  error: MachineError;
}) {
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
export function ArmingNote({ arming }: { arming: RecordArming }) {
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
export function IntegrityBanner({
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
export function QuickCheckReasons({ reasons }: { reasons: string[] }) {
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
export function SaveErrorBanner({
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
