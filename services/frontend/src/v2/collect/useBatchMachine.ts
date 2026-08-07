// Collect screen state machine: batch -> episode -> phase. The batch grouping
// and the per-take flow are frontend-local; everything that touches data is
// real. startRecording()/stopRecording() call the orchestrator's /record/start
// and /record/stop, Save is a compare-and-swap review write on the capture
// (PATCH /captures/{id}/review), and Discard is the shared capture-store
// discard (POST /captures/{id}/delete). The saving/quick-check transitions are
// gated on REAL recorder events (the stop mutation resolving and the
// /record/status integrity landing), not fixed demo timers — so the operator
// never advances past a stop that hasn't finished.
//
// One capture IS one episode (contract §8): the review the operator types here
// lands on the capture itself, which is why there is no browser-local mirror of
// it any more and no separate episode object to keep in step.
//
// The reducer below is the "batch machine" proper — pure, exported for direct
// unit testing. Everything else in the hook (real API calls, event gates, toast,
// modal/picker visibility) wraps it.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { getRecordStatus, startRecord, stopRecord } from '../../api/record';
import { getTransferStatus } from '../../api/transfer';
import { patchBatch } from '../../api/batches';
import { getCapture, listCaptures, saveReview } from '../../api/captures';
import { queryKeys } from '../../api/queryKeys';
import { useUiStore } from '../../store/uiStore';
import { useOperators } from '../plans';
import { useCaptureDeletion } from '../captures/useCaptureDeletion';
import { needsReload } from '../captures/errors';
import { useRecordStatus } from '../captures/useRecordStatus';
import {
  ACTIVE_RECORD_STATES,
  liveCaptureIds,
  type CaptureDetail,
  type Quality as ServerQuality,
  type QuickCheckVerdict,
  type RecordArming,
  type RecordIntegrity,
  type RecordStartRequest,
  type RecordState,
  type ReviewSaveRequest,
} from '../../api/types';
import { useToast } from '../shared/useToast';

// Public surface: everything Collect (and the tests) imported from this module
// before the machine/ split keeps resolving here.
export * from './machine/types';
export {
  batchMachineReducer,
  createBatchMachineState,
} from './machine/reducer';
export {
  __resetBatchStore,
  __rehydrateBatchStore,
  __resetStopFloorMs,
  __setStopFloorMs,
} from './machine/store';
export * from './machine/contract';

import {
  COLLECT_DISCARD_REASON,
  COLLECT_UNSAVED_DISCARD_REASON,
  RETAKE_DISCARD_REASON,
  SAVED_FLASH_MS,
  UNSAVED_MAX_AGE_MS,
  collectReviewStatus,
  type MachineError,
  type Quality,
  type QualityOverride,
} from './machine/types';
import {
  dismissedUnsavedCaptures,
  dispatch,
  getStoreSnapshot,
  persistDismissed,
  useBatchState,
} from './machine/store';
import type {
  BatchMachine,
  BatchStats,
  RecordSelection,
  UseBatchMachineArgs,
} from './machine/contract';
import { useCollectOverlays } from './hooks/useCollectOverlays';
import { useCollectShortcuts } from './hooks/useCollectShortcuts';
import { usePreArm } from './hooks/usePreArm';
import { useTakeClock } from './hooks/useTakeClock';
import { useBatchLifecycle } from './hooks/useBatchLifecycle';
import { useCollectContext } from './hooks/useCollectContext';

/** Normalise a thrown error to a MachineError. A backend code passes through; a
 *  5xx or a transport failure (no code) is treated as an unreachable recorder so
 *  ControlCard can show the friendly connection copy. */
function toMachineError(err: unknown): MachineError {
  if (err instanceof ApiError) {
    if (err.code) return { code: err.code, message: err.message };
    if (err.status >= 500)
      return { code: 'recorder_unreachable', message: err.message };
    return { code: null, message: err.message };
  }
  return {
    code: 'recorder_unreachable',
    message: err instanceof Error ? err.message : String(err),
  };
}

/** The operator's quality override mapped to the server vocabulary. */
const SERVER_QUALITY: Record<QualityOverride, ServerQuality> = {
  good: 'good',
  review: 'needs_review',
  notusable: 'not_usable',
};

export function useBatchMachine({ defaultTopics }: UseBatchMachineArgs): BatchMachine {
  // State lives in the module-level store above (survives tab-switch unmounts);
  // `dispatch` is the module dispatch, `state` is this component's subscription.
  const state = useBatchState();
  const queryClient = useQueryClient();
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const goMonitor = useCallback(() => setActiveTab('monitor'), [setActiveTab]);

  // ---- next-recording selection (config defaults + uiStore Monitor picker) --
  // Resolves exactly like v1 LiveTab.tsx:940-948. The picker checkboxes live in
  // the Monitor screen (another agent) — Collect only READS the store values.
  const operator = useUiStore((s) => s.recordOperator);
  // Attribution gate: once Settings holds a roster, a recording may not start
  // without a picked name (that is the roster's entire point — no more
  // unknown_operator shifts). An empty roster gates nothing.
  const roster = useOperators();
  const operatorMissing = roster.length > 0 && !operator.trim();
  const recordSelected = useUiStore((s) => s.recordSelected);
  const recordCustomized = useUiStore((s) => s.recordCustomized);
  const selection: RecordSelection = useMemo(() => {
    if (recordCustomized) {
      return {
        topics: [...recordSelected],
        count: recordSelected.size,
        customized: true,
      };
    }
    if (defaultTopics.length > 0) {
      return { topics: defaultTopics, count: defaultTopics.length, customized: false };
    }
    return { topics: 'all', count: 0, customized: false };
  }, [recordCustomized, recordSelected, defaultTopics]);
  // Disable Start only when the operator explicitly cleared every topic.
  const noSelection =
    selection.customized &&
    Array.isArray(selection.topics) &&
    selection.topics.length === 0;

  // ---- real recorder status (arming + integrity) --------------------------
  // Polls /record/status on the SAME query key LiveTab uses, so react-query
  // dedupes it (no extra network). Two honest, non-persisted live signals ride
  // this poll: the arming matched/missing summary (OL-①.4) and the post-stop
  // recording integrity (OL-①) — both read straight from the recorder, never
  // synthesized and never the mock quality flag (recWarning). The stop mutation
  // already invalidates this key, so the integrity surfaces once the recorder
  // finalises the bag.
  const recordStatus = useRecordStatus();
  // A failed poll leaves react-query serving the LAST successful response, so
  // reading `.data` alone keeps a dead recorder's "recording" on screen for
  // ever. Everything derived below therefore reads the payload only while the
  // recorder is answering; when it is not, the machine falls back to knowing
  // nothing rather than to knowing something false.
  const recorderReachable = recordStatus.reachable;
  const status = recorderReachable ? recordStatus.status : undefined;
  const arming: RecordArming | null = status?.arming ?? null;
  // Gate integrity to THIS episode's capture so a previous capture's
  // `dropped`/`failed` can't leak into the current result while the poll catches
  // up. The singular `capture_id` is the right field here: it keeps naming the
  // last capture after a stop (§10), which is exactly the one being labeled.
  const captureMatches =
    state.currentCaptureId == null ||
    (status?.capture_id ?? null) === state.currentCaptureId;
  const integrity: RecordIntegrity | null = captureMatches
    ? (status?.integrity ?? null)
    : null;
  const droppedMessages: number | null = captureMatches
    ? (status?.dropped_messages ?? null)
    : null;
  // Finalised/live bag size for the current capture (the recording card's real
  // "MB written", replacing a fabricated elapsed×rate).
  const currentCaptureBytes: number | null = captureMatches
    ? (status?.bytes ?? null)
    : null;
  // The recorder's SERVER state — the one source the SYSTEM STATUS Recorder row
  // and the takeover card both read (D-1), so they can never disagree.
  const recorderState: RecordState | null = status?.state ?? null;
  // Never `?? []`: null means "we do not know what is live" — the recorder
  // answered without the array (§10 rev.2.4) or is not answering at all — and
  // reading that as an empty live set is how a UI ends up telling an operator
  // their running recording does not exist.
  const liveCaptures = recordStatus.live;

  // ---- settled quick-check verdict (F1) ------------------------------------
  // After stop the orchestrator settles a quick_check verdict on the capture
  // (good/needs_review + human-readable reasons). While the operator is on the
  // result panel, poll the capture gently so the panel shows the SERVER's
  // verdict — the same value the server derives on save — instead of a client
  // re-derivation. Bounded to ~3 fetches (~5s): settlement is sub-second in
  // practice, and saving is never blocked on it (the operator may save before it
  // lands; the server corrects a quick_check-sourced review when it does, §4.1).
  const resultCaptureId =
    state.phase === 'result' && state.currentCaptureId ? state.currentCaptureId : null;
  const resultCaptureQuery = useQuery({
    queryKey: queryKeys.capture(resultCaptureId ?? ''),
    queryFn: ({ signal }) => getCapture(resultCaptureId ?? '', signal),
    enabled: !!resultCaptureId,
    refetchInterval: (query) => {
      if (query.state.data?.quick_check?.verdict) return false; // settled -> stop
      if (query.state.dataUpdateCount >= 3) return false; // bounded backstop
      return 2000;
    },
  });
  const resultCapture: CaptureDetail | null = resultCaptureId
    ? (resultCaptureQuery.data ?? null)
    : null;
  const settledVerdict: QuickCheckVerdict | null =
    resultCapture?.quick_check?.verdict ?? null;
  // True while the operator is on the result panel and the verdict has not
  // settled yet — drives an honest "Quick check running…" note, never a value.
  const quickCheckPending = !!resultCaptureId && settledVerdict == null;

  // ---- auto quality (D-2 / F1) ---------------------------------------------
  // Prefer the orchestrator's SETTLED verdict when available (the same value the
  // server derives on save); fall back to the recorder's real integrity while it
  // is still unsettled. Never a fabricated value — `null` integrity with no
  // verdict stays 'good' and the panel notes the check was unavailable.
  const autoQuality: Quality = settledVerdict
    ? settledVerdict.quality === 'good'
      ? 'good'
      : 'review'
    : integrity === 'dropped' || integrity === 'failed'
      ? 'review'
      : 'good';
  const setQuality = useCallback(
    (q: QualityOverride | null) => dispatch({ type: 'SET_QUALITY', quality: q }),
    [],
  );

  // ---- takeover detection (D-1) --------------------------------------------
  // A recording is running server-side that THIS screen isn't driving (another
  // tab/session started it, or this is a reload of our own).
  //
  // Which capture is answered by `live_capture_ids`, never by the singular
  // `capture_id` — that one keeps naming the last capture long after it stopped
  // (§10), so keying on it would resurrect a finished recording as a takeover.
  // `armed` also puts a capture in the live set, so the recorder STATE decides
  // whether anything is actually being written; ACTIVE_RECORD_STATES excludes
  // armed for exactly that reason.
  const localActive =
    state.phase === 'arming' ||
    state.phase === 'recording' ||
    state.phase === 'saving' ||
    state.phase === 'quickcheck';
  const recorderActive = recorderState != null && ACTIVE_RECORD_STATES.has(recorderState);
  const takeoverCaptureId =
    recorderActive && !localActive ? (liveCaptures?.[0] ?? null) : null;
  // The capture supplies the run_id, operator and topic count (RecordStatus
  // carries none of them); only fetched while a takeover is showing.
  const takeoverDetailQuery = useQuery({
    queryKey: queryKeys.capture(takeoverCaptureId ?? ''),
    queryFn: ({ signal }) => getCapture(takeoverCaptureId ?? '', signal),
    enabled: !!takeoverCaptureId,
  });
  const takeover = takeoverCaptureId
    ? {
        captureId: takeoverCaptureId,
        runLabel: takeoverDetailQuery.data?.run_id ?? null,
        startedAt: status?.started_at ?? null,
        bytes: status?.bytes ?? null,
        topicsCount: takeoverDetailQuery.data?.topics?.length ?? null,
        operator: takeoverDetailQuery.data?.operator ?? null,
      }
    : null;
  const takeoverResumedOwn = !!takeover && takeover.captureId === state.lastCaptureId;

  // ---- pre-arm (two-phase start) -------------------------------------------
  // The engine lives in hooks/usePreArm.ts (config gate, visibility pause,
  // keep-alive re-prepares); only the armed flag comes back.
  const { preArmed } = usePreArm({
    phase: state.phase,
    recorderState,
    noSelection,
    takeoverCaptureId,
    operator,
    task: state.task,
    selectionTopics: selection.topics,
    armingDisarmAt: arming?.disarm_at ?? null,
  });

  // ---- unsaved-take scan (D-3) ---------------------------------------------
  // A completed capture that has never been reviewed, is recent, and is not the
  // one we're already labeling, is a take the operator stopped but never saved
  // (e.g. a reload between Stop and Save). `review_revision === 0` is the server
  // truth for "never reviewed" (§4.1) — the browser-local mirror that used to
  // answer this is gone, and a capture now carries the answer itself.
  // Shares the ['captures'] cache prefix, so a save or a discard refreshes it.
  const captureScanQuery = useQuery({
    queryKey: queryKeys.captureList('collect-unsaved'),
    queryFn: ({ signal }) => listCaptures({ limit: 10 }, signal),
    refetchInterval: 15000,
  });
  // A bump to recompute the (module-set-backed) dismissed filter without state.
  const [dismissNonce, setDismissNonce] = useState(0);
  // EVERY recoverable take, not just the first. Two can be pending at once —
  // the banner's and the one on the result panel — and the operator needs to
  // know that a second exists rather than meeting it the moment they dismiss
  // the first, which reads as the dismissal not working.
  const unsavedCaptures = useMemo(() => {
    void dismissNonce; // recompute when takes are dismissed
    const items = captureScanQuery.data?.items ?? [];
    const now = Date.now();
    return items.filter((capture) => {
      // `interrupted` counts as recoverable: a recording the recorder lost
      // mid-take still wrote whatever bytes it managed, and the operator is the
      // only one who can say whether they are worth keeping. Leaving it out is
      // why an interrupted take never appeared here at all.
      if (capture.state !== 'completed' && capture.state !== 'interrupted') return false;
      if (capture.review_revision !== 0) return false;
      if (!capture.started_at) return false;
      const startedMs = Date.parse(capture.started_at);
      if (Number.isNaN(startedMs) || now - startedMs > UNSAVED_MAX_AGE_MS) return false;
      if (capture.capture_id === state.currentCaptureId) return false;
      if (dismissedUnsavedCaptures.has(capture.capture_id)) return false;
      return true;
    });
  }, [captureScanQuery.data, state.currentCaptureId, dismissNonce]);
  // The list arrives newest-first, so the banner always describes the most
  // recent one — the take the operator is most likely thinking of.
  const unsavedCapture = unsavedCaptures[0] ?? null;
  const unsavedTake = useMemo(() => {
    if (!unsavedCapture) return null;
    const startedMs = Date.parse(unsavedCapture.started_at ?? '');
    const endedMs = unsavedCapture.ended_at ? Date.parse(unsavedCapture.ended_at) : NaN;
    return {
      captureId: unsavedCapture.capture_id,
      runLabel: unsavedCapture.run_id ?? null,
      startedAt: unsavedCapture.started_at ?? null,
      bytes: unsavedCapture.bytes ?? null,
      durationMs:
        Number.isNaN(endedMs) || Number.isNaN(startedMs)
          ? null
          : Math.max(0, endedMs - startedMs),
      // A take that ENDED ON ITS OWN needs to say why, and the banner is the
      // only durable place to say it: a toast is gone in seconds, and the
      // operator meets this take minutes later. The recorder's own account is
      // preferred where it wrote one (a restart records a specific reason);
      // otherwise the orchestrator's generic note stands.
      interrupted: unsavedCapture.state === 'interrupted',
      reason: unsavedCapture.error?.message ?? null,
    };
  }, [unsavedCapture]);

  // ---- toast --------------------------------------------------------------
  const { toast, showToast } = useToast();

  // ---- save flash ----------------------------------------------------------
  // Briefly mark the just-saved episode's strip chip (a teal ring) so the save
  // receipt is visible on the strip, not only the toast.
  const [lastSavedIndex, setLastSavedIndex] = useState<number | null>(null);
  const savedFlashRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashSaved = useCallback((index: number) => {
    setLastSavedIndex(index);
    if (savedFlashRef.current) clearTimeout(savedFlashRef.current);
    savedFlashRef.current = setTimeout(() => setLastSavedIndex(null), SAVED_FLASH_MS);
  }, []);
  useEffect(
    () => () => {
      if (savedFlashRef.current) clearTimeout(savedFlashRef.current);
    },
    [],
  );

  // ---- batch lifecycle (server API) ----------------------------------------
  // Lazy batch creation + the once-per-load server reconcile live in
  // hooks/useBatchLifecycle.ts.
  const { ensureBatch } = useBatchLifecycle();

  // ---- real recording API (mirrors LiveTab's start/stop wiring) -----------
  // Tracks a Cancel (during arming) or an end-batch-early confirmed while
  // arming/recording, so a start that lands late — or a stop that fails — is
  // reconciled instead of leaving an orphaned recorder session running.
  const cancelledStartRef = useRef(false);
  // Synchronous double-start guard. The phase check inside startRecording reads
  // the CLOSURE's `state.phase`, which does not update until the next render —
  // so two clicks (or two keypresses) landing in the same tick both saw
  // `ready` and both fired /record/start, and the second capture was whatever
  // few milliseconds the recorder managed before the first stop caught up. A
  // ref changes on assignment, so it closes the window the phase cannot.
  const startInFlightRef = useRef(false);

  const startMutation = useMutation({
    mutationFn: (body: RecordStartRequest) => startRecord(body),
    onSuccess: (capture) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
      if (cancelledStartRef.current) {
        cancelledStartRef.current = false;
        // The operator already backed out locally. If the recorder actually
        // started server-side despite that, stop it now (best-effort) so it
        // doesn't keep running unnoticed.
        if (capture && capture.state !== 'failed') {
          void stopRecord().catch(() => {});
        }
        return;
      }
      if (!capture || capture.state === 'failed') {
        dispatch({
          type: 'START_FAILED',
          error: capture?.error
            ? { code: capture.error.code, message: capture.error.message }
            : { code: null, message: 'the recorder rejected the start' },
        });
        return;
      }
      dispatch({
        type: 'START_SUCCEEDED',
        captureId: capture.capture_id ?? null,
        runLabel: capture.run_id ?? null,
      });
    },
    onError: (err) => {
      if (cancelledStartRef.current) {
        cancelledStartRef.current = false;
        return;
      }
      dispatch({ type: 'START_FAILED', error: toMachineError(err) });
    },
    // Released however the start ended. Leaving it set on a failure would make
    // Start permanently dead for the rest of the session.
    onSettled: () => {
      startInFlightRef.current = false;
    },
  });

  const stopMutation = useMutation({
    mutationFn: async () => {
      const capture = await stopRecord();
      // A 200 does not on its own prove the recorder stopped. /record/stop is
      // idempotent and answers with the last capture when it finds nothing
      // active, so a recorder still holding the bag can look like success — and
      // then this screen walks on to labelling a take that is still being
      // written, with nothing to end it but the MAX_RECORD_SECONDS backstop.
      // Confirm against the recorder before advancing; a still-running recorder
      // routes to onError -> STOP_FAILED, which keeps the operator on SAVING
      // with the Retry-stop button instead of pretending the take is done.
      //
      // `live_capture_ids` is read as a POSITIVE liveness signal only: an absent
      // array means the recorder is unreachable, not that nothing is live (§10
      // rev.2.4), so it can never be the thing that says "stopped" — the state
      // field is.
      const after = await getRecordStatus();
      const stillLive =
        ACTIVE_RECORD_STATES.has(after.state) ||
        (capture?.capture_id != null &&
          liveCaptureIds(after)?.includes(capture.capture_id) === true);
      if (stillLive) {
        throw new ApiError(
          409,
          {
            error: {
              code: 'stop_not_confirmed',
              message: `The recorder is still ${after.state}. The recording was not stopped — retry.`,
              details: {},
            },
          },
          'the recorder did not stop',
        );
      }
      return capture;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
      // The stop returned the finalised capture: advance SAVING → QUICK CHECK on
      // the real event, and refresh the capture cache (the just-stopped capture
      // is now completed — it feeds the unsaved-take scan if the operator
      // navigates away before labelling it).
      void queryClient.invalidateQueries({ queryKey: queryKeys.captures });
      dispatch({ type: 'SAVED' });
    },
    onError: (err) => {
      dispatch({ type: 'STOP_FAILED', error: toMachineError(err) });
    },
  });

  const startRecording = useCallback(() => {
    if (state.phase !== 'ready' || noSelection) return;
    if (operatorMissing) {
      showToast('Pick your name first — OP chip, top right');
      return;
    }
    if (startInFlightRef.current) return;
    startInFlightRef.current = true;
    cancelledStartRef.current = false;
    // Lazily create the server batch (never blocks the recording; the save
    // awaits the same promise).
    void ensureBatch();
    dispatch({ type: 'START_REQUESTED' });
    // Mirror v1 LiveTab.tsx:345-350: topics from the resolved selection, plus
    // operator (from the header input, via uiStore) and task when non-empty.
    const body: RecordStartRequest = { topics: selection.topics };
    if (operator.trim()) body.operator = operator.trim();
    if (state.task?.trim()) body.task = state.task.trim();
    startMutation.mutate(body);
  }, [
    state.phase,
    state.task,
    noSelection,
    operatorMissing,
    showToast,
    selection.topics,
    operator,
    startMutation,
    ensureBatch,
  ]);

  const cancelArming = useCallback(() => {
    if (state.phase !== 'arming') return;
    cancelledStartRef.current = true;
    dispatch({ type: 'CANCEL_ARMING' });
  }, [state.phase]);

  // ---- take clock + lifecycle gates (E-28 / E-32 / B1) ---------------------
  // The monotonic baseline, Stop floor, frozen elapsed timer, B1 recovery,
  // healthy-end detection and the SAVING / QUICK CHECK gates live in
  // hooks/useTakeClock.ts; the machine keeps only the values the controls read.
  const { stopBlockedReason, canStop, recorderStaleMs } = useTakeClock({
    phase: state.phase,
    currentCaptureId: state.currentCaptureId,
    recorderReachable,
    live: recordStatus.live,
    lastGoodAt: recordStatus.lastGoodAt,
    statusCaptureId: status?.capture_id,
    statusState: status?.state,
    liveCaptures,
    integrity,
    showToast,
  });

  const stopRecording = useCallback(() => {
    if (state.phase !== 'recording') return;
    // Guarded here as well as on the control, so the S / Space shortcuts cannot
    // walk around the button's disabled state.
    if (!canStop) return;
    dispatch({ type: 'STOP_REQUESTED' });
    stopMutation.mutate();
  }, [state.phase, canStop, stopMutation]);

  const retryStop = useCallback(() => {
    if (getStoreSnapshot().phase !== 'saving') return;
    dispatch({ type: 'RETRY_STOP' });
    stopMutation.mutate();
  }, [stopMutation]);

  // ---- episode result / confirm --------------------------------------------
  const pickSuccess = useCallback(
    () => dispatch({ type: 'PICK_RESULT', result: 'ok' }),
    [],
  );
  const pickFailure = useCallback(
    () => dispatch({ type: 'PICK_RESULT', result: 'fail' }),
    [],
  );
  const pickFailReason = useCallback(
    (reason: string) => dispatch({ type: 'PICK_FAIL_REASON', reason }),
    [],
  );

  // The save is a compare-and-swap on the capture (§4.1), so it can genuinely be
  // refused. The local episode is therefore recorded only AFTER the server
  // accepted it: a strip chip or a receipt for a save that did not happen is the
  // one thing this screen must never show (§12).
  const [saveError, setSaveError] = useState<unknown>(null);
  const [isSavingReview, setIsSavingReview] = useState(false);
  const dismissSaveError = useCallback(() => setSaveError(null), []);

  const confirmEpisode = useCallback(() => {
    if (state.phase !== 'result' || !state.pendingTask) return;
    if (state.pendingTask === 'fail' && !state.failReason) return;
    if (isSavingReview) return;
    // Monotone: the new episode's number follows the recorded count, so a prior
    // Review delete never causes a reused index_in_batch on the server.
    const nextIndex = state.recordedCount + 1;
    const willComplete = nextIndex >= state.targetEpisodes;
    const isFail = state.pendingTask === 'fail';
    const reason = state.failReason;
    // Quality (D-2 / F1): the operator's override if any, else the auto value.
    // `localQuality` drives the LOCAL strip chip ('notusable' has no local axis,
    // so it shows as 'review'). The REQUEST carries a quality only on an
    // override, stamped `quality_source: 'operator'` — that provenance is what
    // stops the orchestrator's quick_check reconciliation from later overwriting
    // a human decision (§4.1). With no override both fields are OMITTED so the
    // server derives the value from the settled verdict: one place derives it,
    // and a save made before settlement gets corrected rather than frozen at a
    // guess. Claiming 'operator' for a value the operator never chose would
    // fabricate that provenance and disable the correction for good.
    const override = state.qualityOverride;
    const effective: QualityOverride = override ?? autoQuality;
    const localQuality: Quality = effective === 'good' ? 'good' : 'review';
    const captureId = state.currentCaptureId;
    const baseRevision = state.currentReviewRevision;
    const op = operator.trim();

    if (!captureId) {
      // The recorder named no capture, so there is nothing to write a review to.
      // Record the take locally and say exactly that — never a bare "Saved".
      dispatch({ type: 'CONFIRM_EPISODE', quality: localQuality });
      flashSaved(nextIndex);
      showToast(
        `Episode ${nextIndex} labeled on screen only — the recorder named no capture`,
      );
      return;
    }

    setIsSavingReview(true);
    setSaveError(null);
    void (async () => {
      try {
        // A batch still being created has to land first: a batch_id that arrived
        // after the save would leave this capture ungrouped for good.
        const batchId = await ensureBatch();
        const body: ReviewSaveRequest = {
          base_revision: baseRevision,
          task_result: isFail ? 'failure' : 'success',
          failure_reason: isFail ? reason || null : null,
          review_status: collectReviewStatus(isFail ? 'fail' : 'ok', effective),
          batch_id: batchId,
          // An index inside no batch means nothing, so it is only sent with one.
          index_in_batch: batchId ? nextIndex : null,
        };
        if (override != null) {
          body.quality = SERVER_QUALITY[override];
          body.quality_source = 'operator';
        }
        const saved = await saveReview(captureId, body);
        // E-7: the number we sent was a PROPOSAL. The orchestrator renumbers on
        // collision and answers with what it actually wrote, and the spec says
        // to adopt that. Nothing else corrects it — the strip places chips by
        // this local number, and the only path that reads server indices is the
        // once-per-page-load hydrate, which the invalidations below do not
        // re-run. Keeping the proposal parks a chip on a slot belonging to a
        // different take until the next reload.
        const storedIndex =
          typeof saved?.index_in_batch === 'number' ? saved.index_in_batch : nextIndex;
        dispatch({ type: 'CONFIRM_EPISODE', quality: localQuality, index: storedIndex });
        if (willComplete && batchId)
          void patchBatch(batchId, { status: 'completed' }).catch(() => {});
        // The capture now carries a review, so it is no longer an unsaved take.
        void queryClient.invalidateQueries({ queryKey: queryKeys.captures });
        // The FIRST review save for a capture is what moves the batch's
        // `episodes_recorded` server-side (§4.1), and Coverage is read from
        // that counter. Without this the figure sat on its own 30s refetch and
        // silently disagreed with the strip the operator had just watched
        // update.
        void queryClient.invalidateQueries({ queryKey: queryKeys.batches });
        flashSaved(storedIndex);
        const batchSeq = getStoreSnapshot().batchSeq;
        const seqPart = batchSeq != null ? ` of Batch ${batchSeq}` : '';
        showToast(
          batchId
            ? `Saved — Episode ${storedIndex}${seqPart}${op ? ` · ${op}` : ''}`
            : `Saved — Episode ${storedIndex}, not grouped into a set (no batch)`,
        );
        // Say what validation makes of the take while the operator can still
        // act on it — a needs_review verdict discovered days later in Review
        // is a re-setup, not a retake. Best effort: a failed read says nothing
        // rather than claiming a verdict.
        void getCapture(captureId)
          .then((detail) => {
            if (detail.verdict === 'needs_review') {
              showToast(
                `Episode ${storedIndex}: validation failed — Review can override it with a reason`,
              );
            }
          })
          .catch(() => {});
      } catch (err) {
        // Never swallowed and never retried behind the operator's back (§12).
        // The result panel stays put with their values intact, so a re-apply is
        // their decision.
        setSaveError(err);
        if (needsReload(err)) {
          // The capture moved under us. Refetch it so a re-apply is a
          // compare-and-swap against what is actually stored — never a merge.
          try {
            const fresh = await queryClient.fetchQuery({
              queryKey: queryKeys.capture(captureId),
              queryFn: ({ signal }: { signal: AbortSignal }) =>
                getCapture(captureId, signal),
            });
            dispatch({ type: 'SET_REVIEW_BASE', revision: fresh.review_revision });
          } catch {
            // The refetch failed too. The operator still sees the original
            // failure, and the stale base_revision is simply refused again.
          }
        }
      } finally {
        setIsSavingReview(false);
      }
    })();
  }, [
    state.phase,
    state.pendingTask,
    state.failReason,
    state.qualityOverride,
    state.recordedCount,
    state.targetEpisodes,
    state.currentCaptureId,
    state.currentReviewRevision,
    isSavingReview,
    autoQuality,
    operator,
    ensureBatch,
    showToast,
    flashSaved,
    queryClient,
  ]);

  // ---- discard this take (§7 + §12) -----------------------------------------
  // "Discard & re-record" is a DISCARD, not a delete: the take was never worth
  // keeping. It runs through the SHARED dialog and the shared flow so the
  // wording, the required reason and the error codes (capture_busy naming the
  // lease holder, capture_recording, capture_in_dataset, delete_unavailable) are
  // identical everywhere a recording can be removed. A Collect-only modal would
  // be a second place for all of that to drift.
  // On a robot + recording-PC split, a discard removes only the copy on THIS
  // machine, and the dialog is obliged to say so unprompted (§12) — letting an
  // operator believe the robot's copy went too is the failure that line exists
  // to prevent. `/transfer/status` answers `available` only where the pull
  // channel exists, which IS the split-mode signal (§10.6).
  const transferQuery = useQuery({
    queryKey: queryKeys.transferStatus,
    queryFn: ({ signal }) =>
      getTransferStatus({ signal }),
    staleTime: 60_000,
  });
  const splitDeploy = transferQuery.data?.available === true;

  const episodeDiscard = useCaptureDeletion({
    onDeleted: () => {
      // The take is gone, so is anything the operator typed about it.
      setSaveError(null);
      dispatch({ type: 'RETRY_EPISODE' });
    },
    onToast: showToast,
  });
  // Discarding an unlabeled take (the recovery banner) is the same §7 discard,
  // so it uses the same shared flow and dialog rather than a second
  // confirmation of its own. It lives here, beside the other, because opening
  // either has to close the other.
  const unsavedDiscard = useCaptureDeletion({ onToast: showToast });

  // ONE CLICK, no dialog (user decision 2026-08-03). The operator is standing
  // at the take they just made — the press IS the consent. The reason prompt
  // was first softened to chips and then, on the same feedback, removed
  // outright for Collect; the ledger still gets a true answer: that the
  // discard came from Collect and no reason was asked. Review keeps its dialog
  // — there the capture is history, not the take in hand, and §12's wording
  // obligations still apply.
  const discardEpisode = useCallback(() => {
    const snapshot = getStoreSnapshot();
    if (snapshot.phase !== 'result') return;
    const captureId = snapshot.currentCaptureId;
    if (!captureId) {
      // Nothing was persisted for this take, so there is nothing to discard.
      dispatch({ type: 'RETRY_EPISODE' });
      showToast('Nothing was recorded for this take — re-record when ready');
      return;
    }
    // §12's split-mode disclosure (a discard removes only THIS machine's copy)
    // moves from the dialog into the success toast.
    void episodeDiscard.discardNow(
      { capture_id: captureId },
      COLLECT_DISCARD_REASON,
      splitDeploy
        ? "Take discarded from this machine — the robot's own copy is untouched"
        : 'Take discarded — ready to re-record',
    );
  }, [episodeDiscard, splitDeploy, showToast]);

  // Retake = the discard above + an immediate restart once the machine is back
  // at READY. The restart is queued through state (not called inline) because
  // startRecording guards on its CLOSURE's phase, which is stale inside the
  // discard promise's .then.
  const [retakeQueued, setRetakeQueued] = useState(false);
  const retakeEpisode = useCallback(() => {
    const snapshot = getStoreSnapshot();
    if (snapshot.phase !== 'result') return;
    const captureId = snapshot.currentCaptureId;
    if (!captureId) {
      dispatch({ type: 'RETRY_EPISODE' });
      setRetakeQueued(true);
      return;
    }
    void episodeDiscard
      .discardNow(
        { capture_id: captureId },
        RETAKE_DISCARD_REASON,
        'Take discarded — recording the retake',
      )
      .then(() => setRetakeQueued(true))
      .catch(() => {
        // Discard failed (toast already shown) — do NOT auto-start on top of
        // a take that still exists.
      });
  }, [episodeDiscard]);
  useEffect(() => {
    if (!retakeQueued) return;
    if (state.phase === 'ready') {
      setRetakeQueued(false);
      startRecording();
    } else if (state.phase !== 'result') {
      // The machine went somewhere else (ended, takeover…) — drop the queue
      // rather than fire a surprise recording later.
      setRetakeQueued(false);
    }
  }, [retakeQueued, state.phase, startRecording]);

  // ---- takeover stop (D-1) -------------------------------------------------
  // Stop a recording this screen isn't driving (another session, or a resumed
  // own). A confirmation modal guards against knocking over someone else's take;
  // the stop then joins the normal completion path (the stopped capture surfaces
  // as an unsaved take for labeling).
  const [takeoverStopModalOpen, setTakeoverStopModalOpen] = useState(false);
  const takeoverStopMutation = useMutation({
    mutationFn: () => stopRecord(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
      void queryClient.invalidateQueries({ queryKey: queryKeys.captures });
      setTakeoverStopModalOpen(false);
    },
  });
  const openTakeoverStopModal = useCallback(() => setTakeoverStopModalOpen(true), []);
  const confirmTakeoverStop = useCallback(
    () => takeoverStopMutation.mutate(),
    [takeoverStopMutation],
  );

  // ---- unsaved-take recovery (D-3) -----------------------------------------
  const labelUnsavedTake = useCallback(() => {
    const capture = unsavedCapture;
    if (!capture) return;
    dispatch({
      type: 'RESUME_TAKE',
      captureId: capture.capture_id,
      runLabel: capture.run_id ?? null,
      // The capture's own revision is the compare-and-swap token; a recovered
      // take was scanned as never-reviewed, so this is 0 unless it changed
      // between the scan and now — in which case the save is correctly refused.
      reviewRevision: capture.review_revision,
    });
    // Make sure there's a server batch to attach the recovered episode to.
    void ensureBatch();
  }, [unsavedCapture, ensureBatch]);

  const discardUnsavedTake = useCallback(() => {
    if (!unsavedCapture) return;
    // Same one-click contract as discardEpisode; the two flows can even run at
    // once now — they target different captures and neither opens anything.
    void unsavedDiscard.discardNow(
      unsavedCapture,
      COLLECT_UNSAVED_DISCARD_REASON,
      splitDeploy
        ? "Interrupted take discarded from this machine — the robot's own copy is untouched"
        : 'Interrupted take discarded',
    );
  }, [unsavedCapture, unsavedDiscard, splitDeploy]);
  // "Later" hides the banner, and hiding it must mean hiding it: dismissing
  // only the take on screen let the next one take its place instantly, which is
  // indistinguishable from the button doing nothing. Every take we currently
  // know about is dismissed, so the banner returns only for one recorded since.
  const dismissUnsavedTake = useCallback(() => {
    if (unsavedCaptures.length === 0) return;
    for (const capture of unsavedCaptures) {
      dismissedUnsavedCaptures.add(capture.capture_id);
    }
    persistDismissed();
    setDismissNonce((n) => n + 1);
  }, [unsavedCaptures]);

  // ---- batch menu actions ---------------------------------------------------
  const pauseBatch = useCallback(() => {
    // Deviates from the design mock (which allows pausing at any phase):
    // pausing while a real recorder session is armed/recording/saving would
    // abandon it silently, so we only allow the clean, idle case.
    if (state.phase !== 'ready') return;
    dispatch({ type: 'PAUSE_BATCH' });
    setBatchMenuOpen(false);
  }, [state.phase]);
  const resumeBatch = useCallback(() => dispatch({ type: 'RESUME_BATCH' }), []);

  const pickEndReason = useCallback(
    (reason: string) => dispatch({ type: 'PICK_END_REASON', reason }),
    [],
  );
  const confirmEndBatch = useCallback(() => {
    if (!state.endReason) return;
    if (state.phase === 'arming') {
      // A start may still land after we've moved on — treat it like a manual
      // cancel so it gets auto-stopped instead of orphaned.
      cancelledStartRef.current = true;
    } else if (
      state.phase === 'recording' ||
      state.phase === 'saving' ||
      state.phase === 'quickcheck'
    ) {
      void stopRecord().catch(() => {});
    }
    // Mark the server batch ended-early (best-effort; only if one exists).
    if (state.batchId) {
      void patchBatch(state.batchId, {
        status: 'ended_early',
        ended_reason: state.endReason,
      }).catch(() => {});
    }
    dispatch({ type: 'CONFIRM_END_BATCH' });
    setEndModalOpen(false);
    setBatchMenuOpen(false);
  }, [state.endReason, state.phase, state.batchId]);

  const startNextBatch = useCallback(() => {
    if (state.phase !== 'ended' && state.phase !== 'completed') return;
    // A completed batch that never received its terminal PATCH (completion can
    // also be reached by lowering the target) must not stay 'active'
    // server-side — the next hydrate would restore the OLD batch over the new
    // one. Terminal-status PATCH is idempotent (ended_at stamps once).
    if (state.phase === 'completed' && state.batchId) {
      void patchBatch(state.batchId, { status: 'completed' }).catch(() => {});
    }
    dispatch({ type: 'START_NEXT_BATCH' });
    // START_NEXT_BATCH cleared batchId/batchSeq; create the new server batch now
    // (its batch_seq is assigned server-side).
    ensureBatch();
    showToast(`Next set ready — same condition, ${state.targetEpisodes} episodes`);
  }, [state.targetEpisodes, state.phase, showToast, ensureBatch]);

  // Reset the batch: close the current one and start fresh (counts → 0/30). The
  // recordings already taken are NOT deleted — they stay in Review. Unlike
  // start-next-batch, the new server batch is created LAZILY on the next start
  // (ensureBatch), not now. Works with the API down: the local reset always
  // happens and the toast says whether the server batch was closed.
  const resetBatch = useCallback(() => {
    // Abort any in-flight capture first so nothing is orphaned (as end-early).
    if (state.phase === 'arming') {
      cancelledStartRef.current = true;
    } else if (
      state.phase === 'recording' ||
      state.phase === 'saving' ||
      state.phase === 'quickcheck'
    ) {
      void stopRecord().catch(() => {});
    }
    const hadBatch = !!state.batchId;
    if (state.batchId) {
      void patchBatch(state.batchId, {
        status: 'ended_early',
        ended_reason: 'reset',
      }).catch(() => {});
    }
    dispatch({ type: 'RESET_BATCH' });
    setResetModalOpen(false);
    setBatchMenuOpen(false);
    showToast(
      hadBatch
        ? 'Set reset — recordings already taken stay in Review'
        : 'Set reset (local) — recordings already taken stay in Review',
    );
  }, [state.phase, state.batchId, showToast]);

  // ---- context: project / task / condition ----------------------------------
  const ctxEditable =
    state.phase === 'ready' ||
    state.phase === 'ended' ||
    state.phase === 'completed' ||
    state.phase === 'paused';
  const condAllowed = state.phase === 'ready';

  const {
    batchMenuOpen,
    projPickerOpen,
    taskPickerOpen,
    endModalOpen,
    issueModalOpen,
    robotPickerOpen,
    condModalOpen,
    resetModalOpen,
    targetModalOpen,
    shortcutsOpen,
    toggleBatchMenu,
    openProjPicker,
    toggleRobotPicker,
    openTaskPicker,
    openCondModal,
    openEndModal,
    openIssueModal,
    openResetModal,
    openTargetModal,
    openShortcuts,
    setBatchMenuOpen,
    setProjPickerOpen,
    setTaskPickerOpen,
    setEndModalOpen,
    setIssueModalOpen,
    setCondModalOpen,
    setResetModalOpen,
    setTargetModalOpen,
    setShortcutsOpen,
  } = useCollectOverlays({ ctxEditable, condAllowed });

  const changeTarget = useCallback(
    (target: number) => {
      const t = Math.max(1, Math.min(500, Math.floor(target)));
      if (!Number.isFinite(t)) return;
      dispatch({ type: 'SET_TARGET', target: t });
      setTargetModalOpen(false);
      // Persist on the current server batch (best-effort; a batch created
      // later takes the value from the machine state at create time).
      if (state.batchId)
        void patchBatch(state.batchId, { target_episodes: t }).catch(() => {});
      showToast(`Set target: ${t} episodes`);
    },
    [state.batchId, showToast],
  );
  const closeModals = useCallback(() => {
    setEndModalOpen(false);
    setIssueModalOpen(false);
    setCondModalOpen(false);
    setResetModalOpen(false);
    setTargetModalOpen(false);
    setTakeoverStopModalOpen(false);
    setShortcutsOpen(false);
  }, []);
  const submitIssue = useCallback(() => {
    setIssueModalOpen(false);
    showToast('Issue logged with episode context');
  }, [showToast]);

  // ---- context: project / task / condition ----------------------------------
  // Pickers + the set-rollover rule live in hooks/useCollectContext.ts.
  const {
    pickProject,
    pickTask,
    pickCustomTask,
    pickCondition,
    pickCustomCondition,
    adviceIdx,
    advicePrev,
    adviceNext,
  } = useCollectContext({
    ctxEditable,
    project: state.project,
    task: state.task,
    batchId: state.batchId,
    showToast,
    setProjPickerOpen,
    setTaskPickerOpen,
    setCondModalOpen,
  });

  // ---- keyboard shortcut layer (D-4) ---------------------------------------
  // R/S/Space/Esc/? on the window, ignored while typing or when any REGISTERED
  // overlay is open (the list below — modals own their own keys, e.g.
  // Esc-to-close). "Registered", not "any overlay on screen": an overlay whose
  // open state lives outside this hook is invisible to the guard, which is
  // exactly how `r` came to start a take behind the Robot picker. Enter is deliberately
  // NOT bound — focus management keeps the primary button focused so the native
  // button handles it.
  // EVERY overlay that can sit over Collect, not just the ones this hook owns:
  // the Robot picker's open state was component-local in ContextBar, so this
  // guard could not see it and `r` started a take behind the open list. Any new
  // overlay must be registered here or the shortcuts will fire underneath it.
  const anyOverlayOpen =
    robotPickerOpen ||
    endModalOpen ||
    issueModalOpen ||
    condModalOpen ||
    resetModalOpen ||
    targetModalOpen ||
    takeoverStopModalOpen ||
    shortcutsOpen ||
    projPickerOpen ||
    taskPickerOpen ||
    batchMenuOpen;
  useCollectShortcuts({
    anyOverlayOpen,
    takeoverActive: !!takeover,
    startRecording,
    stopRecording,
    cancelArming,
    openShortcutsSheet: openShortcuts,
  });

  const stats: BatchStats = useMemo(() => {
    // The recorded count / next number are MONOTONE (from recordedCount) so a
    // Review exclude/delete never lowers them or renumbers. The quality/task
    // tallies still come from the surviving episodes (they legitimately shrink
    // when a recording is deleted).
    const nRecorded = state.recordedCount;
    const nGood = state.episodes.filter((e) => e.quality === 'good').length;
    const nReview = state.episodes.filter((e) => e.quality === 'review').length;
    const nTaskFailed = state.episodes.filter((e) => e.taskResult === 'fail').length;
    return {
      nRecorded,
      nGood,
      nReview,
      nTaskFailed,
      nRemaining: Math.max(0, state.targetEpisodes - nRecorded),
      epNext: Math.min(nRecorded + 1, state.targetEpisodes),
    };
  }, [state.episodes, state.recordedCount, state.targetEpisodes]);

  return {
    phase: state.phase,
    episodes: state.episodes,
    batchSeq: state.batchSeq,
    predictedSeq: state.predictedSeq,
    elapsedMs: state.elapsedMs,
    pendingTask: state.pendingTask,
    failReason: state.failReason,
    startError: state.startError,
    stopError: state.stopError,
    isStarting: startMutation.isPending,
    stats,

    autoQuality,
    qualityOverride: state.qualityOverride,
    setQuality,
    quickCheck: { verdict: settledVerdict, pending: quickCheckPending },

    arming,
    integrity,
    droppedMessages,
    recordingBytes: currentCaptureBytes,
    recorderState,
    liveCaptures,
    preArmed,

    takeover,
    takeoverResumedOwn,
    takeoverStopModalOpen,
    openTakeoverStopModal,
    confirmTakeoverStop,
    isTakeoverStopping: takeoverStopMutation.isPending,

    unsavedTake,
    labelUnsavedTake,
    discardUnsavedTake,
    dismissUnsavedTake,
    unsavedTakeCount: unsavedCaptures.length,
    currentTakeStartedAt: resultCaptureQuery.data?.started_at ?? status?.started_at ?? null,
    unsavedDiscard,

    lastSavedIndex,

    selection,
    noSelection,

    recordedIsFloor: state.recordedIsFloor,
    project: state.project,
    task: state.task,
    condition: state.condition,
    targetEpisodes: state.targetEpisodes,
    ctxEditable,
    condAllowed,
    endReason: state.endReason,

    batchMenuOpen,
    robotPickerOpen,
    toggleRobotPicker,
    projPickerOpen,
    taskPickerOpen,
    endModalOpen,
    issueModalOpen,
    condModalOpen,
    resetModalOpen,
    targetModalOpen,
    shortcutsOpen,
    toggleBatchMenu,
    openProjPicker,
    openTaskPicker,
    openCondModal,
    openTargetModal,
    changeTarget,
    openEndModal,
    openIssueModal,
    openResetModal,
    openShortcuts,
    closeModals,

    episodeDiscard,
    splitDeploy,
    currentRunLabel: state.currentRunLabel,

    adviceIdx,
    advicePrev,
    adviceNext,

    toast,

    startRecording,
    cancelArming,
    stopRecording,
    canStop,
    stopBlockedReason,
    recorderUnreachable: !recorderReachable,
    recorderStaleMs,
    retryStop,
    pickSuccess,
    pickFailure,
    pickFailReason,
    confirmEpisode,
    isSavingReview,
    saveError,
    dismissSaveError,
    discardEpisode,
    retakeEpisode,
    operatorMissing,
    pauseBatch,
    resumeBatch,
    pickEndReason,
    confirmEndBatch,
    submitIssue,
    startNextBatch,
    resetBatch,
    pickProject,
    pickTask,
    pickCustomTask,
    pickCondition,
    pickCustomCondition,
    goMonitor,
  };
}
