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
import { Button, Modal } from '../../components/ui';
import { readCaptureError } from './errors';
import type { Capture } from '../../api/types';

/** "1.2 GB" / "—" — the size figure the confirmation is obliged to show. */
export function formatBytes(n?: number | null): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kB`;
  return `${n} B`;
}

export function totalBytes(captures: Capture[]): number | null {
  const known = captures.filter((c) => typeof c.bytes === 'number');
  if (known.length === 0) return null;
  return known.reduce((sum, c) => sum + (c.bytes ?? 0), 0);
}

function countLabel(n: number): string {
  return `${n} recording${n === 1 ? '' : 's'}`;
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
  const [reason, setReason] = useState('');
  // A fresh dialog starts with an empty reason — carrying the previous one over
  // would let a stale explanation be attached to a different discard.
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const bytes = totalBytes(captures);
  const canConfirm = reason.trim().length > 0 && captures.length > 0 && !busy;

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
            onClick={() => onConfirm(reason.trim())}
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
        <label
          htmlFor="discard-reason"
          className="mt-3 block text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400"
        >
          Reason (required)
        </label>
        <input
          id="discard-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
          autoFocus
          maxLength={500}
          placeholder="e.g. gripper never closed — unusable takes"
          data-testid="discard-reason"
          className="mt-1 w-full rounded-control border border-gray-200 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
        />
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
