// The two deletion dialogs (contract §12). They deliberately do NOT share a
// component: the operator must be able to tell, from the dialog alone, which of
// the two they are about to do.
//
//   Discard (not uploaded) — for data that was never worth keeping. It is
//     irreversible, so the dialog states that plainly, shows exactly how many
//     recordings and how many bytes are going, and REQUIRES a reason: the
//     ledger line is the only surviving explanation of why the data is gone.
//     On a split deployment it also says, unprompted, that a copy may remain on
//     the robot — the discard only removes what is on THIS machine, and letting
//     an operator believe otherwise is the failure this line exists to prevent.
//
//   Delete — an ordinary removal, with its own testids and its own wording.
//
// Both surface a 409 `capture_busy` by naming the job holding the lease (§7.1),
// because "try again later" is not actionable without knowing what to wait for.

import { useEffect, useState } from 'react';
import { Button, Modal, cn } from '../../components/ui';
import { readCaptureError } from './errors';
import type { Capture } from '../../api/types';

// The size figure the confirmation is obliged to show — the shared decimal
// formatter (one convention everywhere; see review/format.ts).
export { formatBytes } from '../review/format';
import { formatBytes, formatWhen } from '../review/format';

export function totalBytes(captures: Capture[]): number | null {
  const known = captures.filter((c) => typeof c.bytes === 'number');
  if (known.length === 0) return null;
  return known.reduce((sum, c) => sum + (c.bytes ?? 0), 0);
}

/** Name what is being removed (audit P2: "1 recording · 249.2 MB" for an
 *  irreversible action identified nothing). Single capture → its run_id (or
 *  capture_id) + episode number + start time; small sets list run_ids. */
function identityLines(captures: Capture[]): string[] {
  if (captures.length === 0 || captures.length > 5) return [];
  return captures.map((c) => {
    const name = c.run_id ?? c.capture_id;
    const ep = c.index_in_batch != null ? ` · episode #${c.index_in_batch}` : '';
    const when = c.started_at ? ` · ${formatWhen(c.started_at)}` : '';
    return `${name}${ep}${when}`;
  });
}

function countLabel(n: number): string {
  return `${n} recording${n === 1 ? '' : 's'}`;
}

// ---- discard reasons -------------------------------------------------------
//
// The reason stays REQUIRED on the wire: once the files are gone the ledger
// line is the only surviving explanation, and that value is untouched here.
// What changed is the typing. During a collection session an operator discards
// obviously-bad takes constantly, and a free-text box every time taxes the
// honest path hardest — the operator who discards carefully pays the most.
// Presets make the common answers one click; "Other" keeps the open field for
// anything they do not cover.

export const DISCARD_REASONS = [
  { id: 'failed_take', label: 'Failed take' },
  { id: 'false_start', label: 'False start' },
  { id: 'sensor', label: 'Sensor or data issue' },
  { id: 'other', label: 'Other' },
] as const;

export type DiscardReasonId = (typeof DISCARD_REASONS)[number]['id'];

function reasonLabel(id: DiscardReasonId): string {
  return DISCARD_REASONS.find((r) => r.id === id)!.label;
}

/**
 * What the captures themselves already say about why they are being discarded.
 *
 * A take the operator has ALREADY marked as failed does not need them to say so
 * a second time — the review carries `task_result: 'failure'` and often a
 * specific `failure_reason`. Pre-selecting from that is not a guess: it is the
 * operator's own earlier answer, and it still has to be confirmed by pressing
 * Discard.
 *
 * `detail` is only offered when every target agrees on it. Two captures with
 * different failure reasons have no single detail to append, and picking one of
 * them would attach the wrong explanation to the other.
 */
export function prefillDiscardReason(captures: Capture[]): {
  chip: DiscardReasonId | null;
  detail: string | null;
} {
  if (captures.length === 0) return { chip: null, detail: null };
  const allFailed = captures.every(
    (c) => c.task_result === 'failure' || !!c.failure_reason,
  );
  if (!allFailed) return { chip: null, detail: null };
  const reasons = new Set(
    captures.map((c) => (c.failure_reason ?? '').trim()).filter((r) => r.length > 0),
  );
  const detail = reasons.size === 1 ? [...reasons][0]! : null;
  return { chip: 'failed_take', detail };
}

/**
 * The string that goes on the wire, and into the ledger.
 *
 * A preset carries its label plus whatever specific detail was already known,
 * so "Failed take — gripper never closed" reads as well months later as the
 * free text it replaces. "Other" is the operator's own words and nothing else.
 * Whitespace-only input composes to an empty string, which is what keeps the
 * confirm button disabled rather than sending a blank the server would reject.
 */
export function composeDiscardReason(
  chip: DiscardReasonId | null,
  detail: string | null,
  otherText: string,
): string {
  if (chip === null) return '';
  if (chip === 'other') return otherText.trim();
  const label = reasonLabel(chip);
  const extra = (detail ?? '').trim();
  return extra ? `${label} — ${extra}` : label;
}

/** The error block both dialogs render. Kept identical on purpose: the codes
 *  and what to do about them do not differ between discard and delete. */
function DialogError({ error, testId }: { error: unknown; testId: string }) {
  if (!error) return null;
  const reading = readCaptureError(error, 'delete');
  return (
    <div
      data-testid={testId}
      data-error-code={reading.code}
      className="mt-3 rounded-control border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700"
    >
      <p className="font-semibold">{reading.message}</p>
      {reading.guidance && <p className="mt-1">{reading.guidance}</p>}
    </div>
  );
}

export interface DeleteDialogProps {
  open: boolean;
  captures: Capture[];
  /** True on a split deployment: the robot keeps its own copy (§0). */
  splitDeploy?: boolean;
  busy?: boolean;
  error?: unknown;
  /** Progress during a multi-capture run ("3 of 12"). */
  done?: number;
  failures?: { captureId: string; error: string }[];
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

/**
 * "Discard (not uploaded)" — irreversible, reason REQUIRED.
 *
 * The confirm button stays disabled until a reason is typed rather than
 * validating after the click: the backend rejects a blank reason with
 * `reason_required` anyway, and making that round-trip the way an operator
 * discovers the field is a worse way to learn it.
 */
export function DiscardDialog({
  open,
  captures,
  splitDeploy = false,
  busy = false,
  error,
  done = 0,
  failures = [],
  onCancel,
  onConfirm,
}: DeleteDialogProps) {
  const [chip, setChip] = useState<DiscardReasonId | null>(null);
  // The detail belongs to the chip it was prefilled FOR. "object dropped"
  // explains a failed take; appending it to "Sensor or data issue" because the
  // operator changed their mind would record a reason nobody gave.
  const [detail, setDetail] = useState<{ chip: DiscardReasonId; text: string } | null>(
    null,
  );
  const [otherText, setOtherText] = useState('');
  // A fresh dialog re-seeds from THESE captures — carrying the previous
  // selection over would let one take's explanation be attached to another's
  // discard, which is the whole failure the required reason exists to prevent.
  useEffect(() => {
    if (!open) return;
    const seed = prefillDiscardReason(captures);
    setChip(seed.chip);
    setDetail(
      seed.chip && seed.detail ? { chip: seed.chip, text: seed.detail } : null,
    );
    setOtherText('');
    // `captures` is intentionally not a dependency: re-seeding mid-dialog would
    // overwrite a choice the operator had already made if the list refetched.
  }, [open]);

  const bytes = totalBytes(captures);
  const activeDetail = detail && detail.chip === chip ? detail.text : null;
  const reason = composeDiscardReason(chip, activeDetail, otherText);
  const canConfirm = reason.length > 0 && captures.length > 0 && !busy;

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onCancel}
      title="Discard (not uploaded)"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy} data-testid="discard-cancel">
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => onConfirm(reason)}
            disabled={!canConfirm}
            data-testid="discard-confirm"
          >
            {busy ? `Discarding… ${done}/${captures.length}` : 'Discard permanently'}
          </Button>
        </>
      }
    >
      <div data-testid="discard-dialog">
        <p className="font-semibold text-red-700" data-testid="discard-irreversible">
          This cannot be undone. The recordings are removed from this machine and
          there is no restore.
        </p>
        <p className="mt-2" data-testid="discard-scope">
          {countLabel(captures.length)} · {formatBytes(bytes)}
          {bytes === null && ' (size unknown)'}
        </p>
        {identityLines(captures).map((line) => (
          <p key={line} className="mt-1 font-mono text-[12px] text-gray-600" data-testid="discard-identity">
            {line}
          </p>
        ))}
        {splitDeploy && (
          <p
            className="mt-2 rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800"
            data-testid="discard-split-note"
          >
            This deployment records on a separate robot. Discarding removes the
            copy on this recording PC — a copy may still exist on the robot, and
            kairos does not delete it.
          </p>
        )}
        <span className="mt-3 block text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400">
          Reason (required)
        </span>
        <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="discard-reason-chips">
          {DISCARD_REASONS.map((r) => {
            const on = chip === r.id;
            return (
              <button
                key={r.id}
                type="button"
                disabled={busy}
                aria-pressed={on}
                data-testid={`discard-reason-${r.id}`}
                onClick={() => setChip(r.id)}
                className={cn(
                  'rounded-chip border px-2.5 py-1 text-[12.5px] font-semibold transition-colors disabled:opacity-50',
                  on
                    ? 'border-red-300 bg-red-50 text-red-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50',
                )}
              >
                {r.label}
              </button>
            );
          })}
        </div>
        {/* The specific reason the operator already gave in Review, carried
            through rather than asked for again. Shown so they can see exactly
            what will be recorded. */}
        {chip !== null && chip !== 'other' && activeDetail && (
          <p className="mt-1.5 text-[11.5px] text-gray-500" data-testid="discard-reason-detail">
            Recorded as: <span className="font-mono text-gray-700">{reason}</span>
          </p>
        )}
        {chip === 'other' && (
          <input
            id="discard-reason"
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            disabled={busy}
            autoFocus
            maxLength={500}
            placeholder="e.g. gripper never closed — unusable takes"
            data-testid="discard-reason"
            aria-label="Reason"
            className="mt-1.5 w-full rounded-control border border-gray-200 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
          />
        )}
        <p className="mt-1 text-[11.5px] text-gray-500">
          Kept in the lifecycle ledger. Once the files are gone this line is the
          only record of why.
        </p>
        <FailureList failures={failures} testId="discard-failures" />
        <DialogError error={error} testId="discard-error" />
      </div>
    </Modal>
  );
}

/** "Delete" — the ordinary removal. Separate modal, separate testids (§12). */
export function DeleteDialog({
  open,
  captures,
  splitDeploy = false,
  busy = false,
  error,
  done = 0,
  failures = [],
  onCancel,
  onConfirm,
}: DeleteDialogProps) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const bytes = totalBytes(captures);

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onCancel}
      title="Delete recordings"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy} data-testid="delete-cancel">
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => onConfirm(reason.trim())}
            disabled={busy || captures.length === 0}
            data-testid="delete-confirm"
          >
            {busy ? `Deleting… ${done}/${captures.length}` : 'Delete'}
          </Button>
        </>
      }
    >
      <div data-testid="delete-dialog">
        <p data-testid="delete-scope">
          {countLabel(captures.length)} · {formatBytes(bytes)}
          {bytes === null && ' (size unknown)'}
        </p>
        {identityLines(captures).map((line) => (
          <p key={line} className="mt-1 font-mono text-[12px] text-gray-600" data-testid="delete-identity">
            {line}
          </p>
        ))}
        <p className="mt-2 text-gray-600">
          The files are removed from this machine. The catalog keeps a record of
          the capture, so it stays answerable where the recording went.
        </p>
        {splitDeploy && (
          <p
            className="mt-2 rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800"
            data-testid="delete-split-note"
          >
            A copy may still exist on the robot; kairos does not delete it.
          </p>
        )}
        <label
          htmlFor="delete-reason"
          className="mt-3 block text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400"
        >
          Reason (optional)
        </label>
        <input
          id="delete-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
          maxLength={500}
          placeholder="e.g. superseded by a re-run"
          data-testid="delete-reason"
          className="mt-1 w-full rounded-control border border-gray-200 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
        />
        <FailureList failures={failures} testId="delete-failures" />
        <DialogError error={error} testId="delete-error" />
      </div>
    </Modal>
  );
}

/** Per-capture failures from a bulk run. They stay on screen: a capture that
 *  could not be deleted is still there, and silently dropping it from the
 *  report would leave the operator believing it went. */
function FailureList({
  failures,
  testId,
}: {
  failures: { captureId: string; error: string }[];
  testId: string;
}) {
  if (failures.length === 0) return null;
  return (
    <ul
      data-testid={testId}
      className="mt-3 flex flex-col gap-1 rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800"
    >
      {failures.map((f) => (
        <li key={f.captureId}>
          <span className="font-mono">{f.captureId.slice(0, 8)}</span> — {f.error}
        </li>
      ))}
    </ul>
  );
}
