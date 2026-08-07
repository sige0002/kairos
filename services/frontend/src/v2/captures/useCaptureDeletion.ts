// The shared discard/delete flow (contract §7 + §12).
//
// Every screen that can remove a recording drives the SAME state machine, so
// the two intents cannot drift apart into per-screen wording or per-screen
// error handling. The hook owns which dialog is open, the in-flight progress of
// a bulk run, and the per-capture failures; the screens own only what they
// pass in as targets.
//
// Failures are never swallowed. A bulk run continues past a rejected capture
// and reports it by id, because a capture that could not be deleted is still
// there — dropping it from the report is how an operator ends up believing the
// disk is emptier than it is.

import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { deleteCapture } from '../../api/captures';
import { cancelJob } from '../../api/jobs';
import { queryKeys } from '../../api/queryKeys';
import { captureErrorText, readCaptureError, readLeaseHolders, type LeaseHolder } from './errors';
import type { CaptureListItem, DeleteKind } from '../../api/types';

export interface DeletionFailure {
  captureId: string;
  error: string;
}

export interface CaptureDeletionState {
  /** Which dialog is open, or null. The two are never the same dialog (§12). */
  kind: DeleteKind | null;
  targets: CaptureListItem[];
  busy: boolean;
  /** How many targets have been attempted so far in a bulk run. */
  done: number;
  failures: DeletionFailure[];
  /** The failure that stopped a single-capture attempt (drives the dialog's
   *  error block); null for a bulk run, whose failures are per-capture. */
  error: unknown;

  /** The jobs holding this capture, when the last refusal was `capture_busy`.
   *  Empty otherwise — so a screen can key the "cancel them" affordance on
   *  this alone rather than re-reading the error code itself. */
  blockers: LeaseHolder[];
  /** A cancel-and-retry is running. */
  clearingBlockers: boolean;
  /** Blocking jobs whose cancel was itself refused, named so the operator can
   *  see WHICH one is still holding the capture. */
  blockerFailures: DeletionFailure[];
  /**
   * Cancel every blocking job, then retry the removal ONCE.
   *
   * Once, deliberately: a retry that lost to a job which started in the
   * meantime would spin, and each turn of that loop cancels somebody's work.
   * The second refusal carries the new holders, so the operator sees who it is
   * now and decides again.
   */
  clearBlockersAndRetry: (reason: string) => Promise<void>;

  requestDiscard: (targets: CaptureListItem | CaptureListItem[]) => void;
  requestDelete: (targets: CaptureListItem | CaptureListItem[]) => void;
  cancel: () => void;
  confirm: (reason: string) => Promise<void>;

  /** One-click discard with no dialog (Collect's Discard buttons): the same
   *  per-capture loop, error voice and invalidations as `confirm`, but nothing
   *  opens and the caller supplies the ledger reason itself. A failure lands on
   *  the toast — the capture is still there, and so is the button the operator
   *  just pressed, so the retry path is the same press. Only ids are needed:
   *  there is no dialog left that would have to state sizes. */
  discardNow: (
    targets: Pick<CaptureListItem, 'capture_id'> | Pick<CaptureListItem, 'capture_id'>[],
    reason: string,
    successToast?: string,
  ) => Promise<void>;
}

export interface UseCaptureDeletionOptions {
  /** Called once with the ids that were actually removed, so a screen can drop
   *  its own local state for them. Never called with a failed id. */
  onDeleted?: (captureIds: string[], kind: DeleteKind) => void;
  /** Extra query keys to invalidate after a run (the capture list is always
   *  invalidated). */
  invalidate?: readonly (readonly unknown[])[];
  /** Message for the screen's toast. */
  onToast?: (message: string) => void;
}

export function useCaptureDeletion(
  options: UseCaptureDeletionOptions = {},
): CaptureDeletionState {
  const { onDeleted, invalidate, onToast } = options;
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<DeleteKind | null>(null);
  const [targets, setTargets] = useState<CaptureListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [failures, setFailures] = useState<DeletionFailure[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [clearingBlockers, setClearingBlockers] = useState(false);
  const [blockerFailures, setBlockerFailures] = useState<DeletionFailure[]>([]);

  const open = useCallback((next: DeleteKind, list: CaptureListItem | CaptureListItem[]) => {
    setKind(next);
    setTargets(Array.isArray(list) ? list : [list]);
    setDone(0);
    setFailures([]);
    setError(null);
    setBlockerFailures([]);
  }, []);

  const requestDiscard = useCallback(
    (list: CaptureListItem | CaptureListItem[]) => open('discard', list),
    [open],
  );
  const requestDelete = useCallback(
    (list: CaptureListItem | CaptureListItem[]) => open('delete', list),
    [open],
  );

  const cancel = useCallback(() => {
    // A run in flight cannot be abandoned mid-way: half the captures are
    // already gone and closing the dialog would hide which.
    if (busy) return;
    setKind(null);
    setTargets([]);
    setFailures([]);
    setError(null);
    setBlockerFailures([]);
    setDone(0);
  }, [busy]);

  const confirm = useCallback(
    async (reason: string) => {
      if (!kind || targets.length === 0) return;
      setBusy(true);
      setDone(0);
      setFailures([]);
      setError(null);
      const failed: DeletionFailure[] = [];
      const removed: string[] = [];
      for (const capture of targets) {
        try {
          await deleteCapture(capture.capture_id, { kind, reason: reason || null });
          removed.push(capture.capture_id);
        } catch (e) {
          failed.push({ captureId: capture.capture_id, error: captureErrorText(e, 'delete') });
          // A single target has one dialog-level error to show; a bulk run
          // shows the per-capture list instead.
          if (targets.length === 1) setError(e);
        }
        setDone((d) => d + 1);
        setFailures([...failed]);
      }
      if (removed.length > 0) onDeleted?.(removed, kind);
      await queryClient.invalidateQueries({ queryKey: queryKeys.captures });
      for (const key of invalidate ?? []) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
      setBusy(false);
      const verb = kind === 'discard' ? 'Discarded' : 'Deleted';
      if (failed.length === 0) {
        onToast?.(`${verb} ${removed.length} recording${removed.length === 1 ? '' : 's'}`);
        setKind(null);
        setTargets([]);
      } else {
        // Keep the dialog open so the failures stay readable.
        onToast?.(`${verb} ${removed.length}, ${failed.length} failed`);
      }
    },
    [kind, targets, queryClient, invalidate, onDeleted, onToast],
  );

  // Who is holding this capture, read off the refusal itself. Derived rather
  // than stored: it is a fact about the current error and cannot outlive it.
  const blockers = useMemo(
    () => (error ? readLeaseHolders(readCaptureError(error, 'delete').details) : []),
    [error],
  );

  const clearBlockersAndRetry = useCallback(
    async (reason: string) => {
      // Only jobs can be cancelled. A capture held by a transfer or the digest
      // queue keeps its holder, and the retry below will be refused again —
      // which is the honest outcome, not something to paper over.
      const jobIds = blockers
        .map((h) => h.jobId)
        .filter((id): id is string => id !== null);
      if (jobIds.length === 0) return;
      setClearingBlockers(true);
      setBlockerFailures([]);
      const failed: DeletionFailure[] = [];
      for (const jobId of jobIds) {
        try {
          await cancelJob(jobId);
        } catch (e) {
          // Keep going: one job refusing to stop is not a reason to leave the
          // others running, and the retry may still succeed without it.
          failed.push({ captureId: jobId, error: captureErrorText(e, 'job') });
        }
      }
      setBlockerFailures(failed);
      setClearingBlockers(false);
      // ONE retry. `confirm` republishes `error` (and with it `blockers`), so a
      // capture that is busy again shows its new holder instead of looping.
      await confirm(reason);
    },
    [blockers, confirm],
  );

  const discardNow = useCallback(
    async (
      list: Pick<CaptureListItem, 'capture_id'> | Pick<CaptureListItem, 'capture_id'>[],
      reason: string,
      successToast?: string,
    ) => {
      if (busy) return;
      const captures = Array.isArray(list) ? list : [list];
      if (captures.length === 0) return;
      setKind(null);
      setBusy(true);
      setDone(0);
      setFailures([]);
      setError(null);
      const failed: DeletionFailure[] = [];
      const removed: string[] = [];
      for (const capture of captures) {
        try {
          await deleteCapture(capture.capture_id, { kind: 'discard', reason });
          removed.push(capture.capture_id);
        } catch (e) {
          failed.push({
            captureId: capture.capture_id,
            error: captureErrorText(e, 'delete'),
          });
          if (captures.length === 1) setError(e);
        }
        setDone((d) => d + 1);
        setFailures([...failed]);
      }
      if (removed.length > 0) onDeleted?.(removed, 'discard');
      await queryClient.invalidateQueries({ queryKey: queryKeys.captures });
      for (const key of invalidate ?? []) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
      setBusy(false);
      if (failed.length === 0) {
        onToast?.(
          successToast ??
            `Discarded ${removed.length} recording${removed.length === 1 ? '' : 's'}`,
        );
      } else {
        // No dialog to keep the failure readable in, so the toast carries the
        // failure itself — the job-voiced capture_busy text included.
        onToast?.(failed[0]?.error ?? 'Discard failed');
      }
    },
    [busy, queryClient, invalidate, onDeleted, onToast],
  );

  return {
    kind,
    targets,
    busy,
    done,
    failures,
    error,
    blockers,
    clearingBlockers,
    blockerFailures,
    clearBlockersAndRetry,
    requestDiscard,
    requestDelete,
    cancel,
    confirm,
    discardNow,
  };
}
