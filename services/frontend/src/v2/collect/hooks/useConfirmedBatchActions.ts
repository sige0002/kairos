// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Terminal batch mutations are deliberately serial: a recorder stop is
// confirmed first, then the server acknowledges the batch mutation, and only
// then may Collect change its local terminal/reset state or close its modal.

import { useCallback, useRef, type MutableRefObject } from 'react';
import { patchBatch } from '../../../api/batches';
import { i18n } from '../../../i18n';
import type { Action } from '../machine/reducer';
import type { MachineError, Phase } from '../machine/types';

type Dispatch = (action: Action) => void;

export function useConfirmedBatchActions({
  phase,
  currentCaptureId,
  batchId,
  targetEpisodes,
  endReason,
  startPromiseRef,
  cancelledStartRef,
  terminalStartCancellationRef,
  discardTerminalArmingTakeRef,
  terminalArmingCleanupRef,
  stopAndConfirm,
  dispatch,
  toMachineError,
  showToast,
  closeEnd,
  closeReset,
  onTargetConfirmed,
  ensureBatch,
}: {
  phase: Phase;
  currentCaptureId: string | null;
  batchId: string | null;
  targetEpisodes: number;
  endReason: string;
  startPromiseRef: MutableRefObject<Promise<unknown> | null>;
  cancelledStartRef: MutableRefObject<boolean>;
  terminalStartCancellationRef: MutableRefObject<boolean>;
  discardTerminalArmingTakeRef: MutableRefObject<boolean>;
  terminalArmingCleanupRef: MutableRefObject<Promise<void> | null>;
  stopAndConfirm: (captureId: string) => Promise<unknown>;
  dispatch: Dispatch;
  toMachineError: (error: unknown) => MachineError;
  showToast: (message: string) => void;
  closeEnd: () => void;
  closeReset: () => void;
  onTargetConfirmed: (target: number) => void;
  ensureBatch: () => Promise<string | null>;
}) {
  const inFlight = useRef(false);

  const stopBeforeTerminalAction = useCallback(
    async ({ discardArmingTake = false } = {}) => {
      const wasRecording = phase === 'recording';
      if (wasRecording) dispatch({ type: 'STOP_REQUESTED' });
      if (phase === 'arming') {
        const pendingStart = startPromiseRef.current;
        terminalStartCancellationRef.current = true;
        discardTerminalArmingTakeRef.current = discardArmingTake;
        terminalArmingCleanupRef.current = null;
        cancelledStartRef.current = true;
        let knownStart = false;
        try {
          const started = await pendingStart;
          // A start response is the proof that this screen owns the recorder
          // session. A rejected/unnamed start may still be another driver's
          // live take, so terminal actions must never follow it with a stop
          // request using an unverified capture identity.
          knownStart =
            !!started &&
            typeof started === 'object' &&
            'capture_id' in started &&
            typeof started.capture_id === 'string' &&
            started.capture_id.length > 0 &&
            'state' in started &&
            started.state !== 'failed';
        } catch {
          // An unknown start is not safe to stop. The batch action can still
          // proceed; a live recording will surface as the takeover state.
        }
        if (discardArmingTake) {
          // Reuse the cancelled-start reconciliation rather than issuing a blind
          // stop here: it first protects another driver's live capture, then
          // waits through the digest lease before discarding this late start.
          await terminalArmingCleanupRef.current;
          return;
        }
        if (!knownStart) return;
      }
      if (
        phase === 'arming' ||
        phase === 'recording' ||
        phase === 'saving' ||
        phase === 'quickcheck'
      ) {
        try {
          if (!currentCaptureId) throw new Error('No owned recording to stop.');
          await stopAndConfirm(currentCaptureId);
        } catch (error) {
          if (wasRecording) {
            dispatch({ type: 'STOP_FAILED', error: toMachineError(error) });
          }
          throw error;
        }
      }
      if (wasRecording) dispatch({ type: 'SAVED' });
    },
    [
      cancelledStartRef,
      discardTerminalArmingTakeRef,
      dispatch,
      phase,
      currentCaptureId,
      startPromiseRef,
      stopAndConfirm,
      terminalArmingCleanupRef,
      terminalStartCancellationRef,
      toMachineError,
    ],
  );

  const run = useCallback((work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    void work().finally(() => {
      terminalStartCancellationRef.current = false;
      discardTerminalArmingTakeRef.current = false;
      terminalArmingCleanupRef.current = null;
      inFlight.current = false;
    });
  }, []);

  const confirmEndBatch = useCallback(() => {
    if (!endReason) return;
    run(async () => {
      try {
        await stopBeforeTerminalAction({ discardArmingTake: true });
        if (batchId) {
          await patchBatch(batchId, { status: 'ended_early', ended_reason: endReason });
        }
        dispatch({ type: 'CONFIRM_END_BATCH' });
        closeEnd();
      } catch (error) {
        showToast(
          i18n.t('collect:endBatchNotCompleted', {
            error: toMachineError(error).message,
          }),
        );
      }
    });
  }, [
    batchId,
    closeEnd,
    dispatch,
    endReason,
    run,
    showToast,
    stopBeforeTerminalAction,
    toMachineError,
  ]);

  const resetBatch = useCallback(() => {
    run(async () => {
      try {
        await stopBeforeTerminalAction();
        if (batchId) {
          await patchBatch(batchId, { status: 'ended_early', ended_reason: 'reset' });
        }
        dispatch({ type: 'RESET_BATCH' });
        closeReset();
        showToast(
          batchId ? i18n.t('collect:setReset') : i18n.t('collect:setResetLocal'),
        );
      } catch (error) {
        showToast(
          i18n.t('collect:resetNotCompleted', { error: toMachineError(error).message }),
        );
      }
    });
  }, [
    batchId,
    closeReset,
    dispatch,
    run,
    showToast,
    stopBeforeTerminalAction,
    toMachineError,
  ]);

  const startNextBatch = useCallback(() => {
    if (phase !== 'ended' && phase !== 'completed') return;
    run(async () => {
      try {
        if (phase === 'completed' && batchId) {
          await patchBatch(batchId, { status: 'completed' });
        }
        dispatch({ type: 'START_NEXT_BATCH' });
        const newBatchId = await ensureBatch();
        showToast(
          newBatchId
            ? i18n.t('collect:nextSetReady', { count: targetEpisodes })
            : i18n.t('collect:nextSetLocalOnly'),
        );
      } catch (error) {
        showToast(
          i18n.t('collect:nextSetNotStarted', { error: toMachineError(error).message }),
        );
      }
    });
  }, [
    batchId,
    dispatch,
    ensureBatch,
    phase,
    run,
    showToast,
    targetEpisodes,
    toMachineError,
  ]);

  const changeTarget = useCallback(
    (target: number) => {
      const nextTarget = Math.max(1, Math.min(500, Math.floor(target)));
      if (!Number.isFinite(nextTarget)) return;
      run(async () => {
        try {
          if (batchId) await patchBatch(batchId, { target_episodes: nextTarget });
          onTargetConfirmed(nextTarget);
          showToast(i18n.t('collect:setTargetToast', { count: nextTarget }));
        } catch (error) {
          showToast(
            i18n.t('collect:setTargetNotSaved', {
              error: toMachineError(error).message,
            }),
          );
        }
      });
    },
    [batchId, onTargetConfirmed, run, showToast, toMachineError],
  );

  return {
    confirmEndBatch,
    resetBatch,
    startNextBatch,
    changeTarget,
  };
}
