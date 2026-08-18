// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The batch machine proper — pure state + transitions, no I/O, no React.
// Exported (with its historical aliases) for direct unit testing.

import { getPlans } from '../../plans';
import {
  EPISODES_PER_BATCH,
  type EpisodeRecord,
  type MachineError,
  type Phase,
  type Quality,
  type QualityOverride,
  type TaskResult,
} from './types';

export interface MachineState {
  phase: Phase;
  episodes: EpisodeRecord[];
  /** Server-assigned batch number (per robot+local-date), the ONE human-readable
   *  batch number shared with Review/Datasets. Null until the batch is created on
   *  the API (lazily, on the first recording), so an empty reset never inflates
   *  it — the old local monotone counter is gone. */
  batchSeq: number | null;
  /** Monotone count of episodes recorded this batch — drives EVERY count/next
   *  number the operator sees. Only ever grows (per confirm), never lowered by a
   *  Review exclude/delete: `episodes` (used for the quality/task tallies + strip
   *  chips) may shrink on a delete-restore, but the recorded count must not. */
  recordedCount: number;
  /** `recordedCount` is a LOWER BOUND, not a count — the server reconstructed
   *  it in a rebuild and cannot count captures reviewed in and later deleted.
   *  Never persisted: it belongs to the server's answer, and the
   *  once-per-page-load restore brings it back with the batch. */
  recordedIsFloor: boolean;
  /** Planned episodes for this batch (server `target_episodes`). Editable per
   *  batch (Batch menu) — the fixed 30 ignored the server value the API always
   *  had. Inherited by the next batch; the strip/counters all follow it. */
  targetEpisodes: number;
  /** Server batch id (Phase 2), null until the batch is created on the API; the
   *  real key for episode POSTs. */
  batchId: string | null;
  /** Predicted next batch number for the honest pre-state shown while `batchSeq`
   *  is null (no batch created yet): 1 + max(batch_seq) among today's batches, or
   *  1 when there are none / the API is unreachable. A display hint only — the
   *  real number is assigned server-side on the first recording — so it is never
   *  persisted (transient; recomputed from GET /batches on each page load). */
  predictedSeq: number | null;
  elapsedMs: number;
  /** Operator's quality choice on the result panel; null = accept the auto
   *  (quick-check) quality. The auto value is NOT stored here — it is derived
   *  live from the recorder's integrity signal in the hook. */
  qualityOverride: QualityOverride | null;
  pendingTask: 'ok' | 'fail' | null;
  failReason: string;
  startError: MachineError | null;
  stopError: MachineError | null;
  /** The capture being recorded or labeled — every API call and testid keys on
   *  this, never on the run_id (§1). */
  currentCaptureId: string | null;
  /** That capture's `run_YYYYMMDD_HHMMSS` name. DISPLAY ONLY (§1): it is what
   *  the operator recognises on disk, and it is never sent anywhere. */
  currentRunLabel: string | null;
  /** The capture's `review_revision` at the time we loaded it — echoed back as
   *  `base_revision` so the save is a compare-and-swap (§4.1). 0 = never
   *  reviewed, which is what a freshly recorded capture always is. */
  currentReviewRevision: number;
  /** The last capture this browser started (durable) — lets takeover detection
   *  tell a resumed-own recording from one another session started. */
  lastCaptureId: string | null;
  /** `null` = no plan catalog to name one from. NOT the display placeholder:
   *  that em dash used to reach POST /batches and be stored as a real label. */
  project: string | null;
  task: string | null;
  condition: string;
  endReason: string;
}

function createInitialState(): MachineState {
  // Seed the context from the CURRENT shared catalog (which may carry the
  // operator's Settings edits), not a hardcoded first plan.
  const plans = getPlans();
  const firstPlan = plans[0];
  const firstTask = firstPlan?.tasks[0];
  return {
    phase: 'ready',
    episodes: [],
    batchSeq: null,
    recordedCount: 0,
    recordedIsFloor: false,
    targetEpisodes: EPISODES_PER_BATCH,
    batchId: null,
    predictedSeq: null,
    elapsedMs: 0,
    qualityOverride: null,
    pendingTask: null,
    failReason: '',
    startError: null,
    stopError: null,
    currentCaptureId: null,
    currentRunLabel: null,
    currentReviewRevision: 0,
    lastCaptureId: null,
    project: firstPlan?.name ?? null,
    task: firstTask?.name ?? null,
    condition: firstTask?.conditions[0]?.name ?? '—',
    endReason: '',
  };
}

export type Action =
  | { type: 'START_REQUESTED' }
  | { type: 'START_FAILED'; error: MachineError }
  | { type: 'START_SUCCEEDED'; captureId: string | null; runLabel: string | null }
  | { type: 'CANCEL_ARMING' }
  | { type: 'TICK'; elapsedMs: number }
  | { type: 'RECORDING_INTERRUPTED' }
  | { type: 'STOP_REQUESTED' }
  | { type: 'STOP_FAILED'; error: MachineError }
  | { type: 'RETRY_STOP' }
  | { type: 'SAVED' }
  | { type: 'QUICK_CHECK_DONE' }
  | { type: 'PICK_RESULT'; result: 'ok' | 'fail' }
  | { type: 'PICK_FAIL_REASON'; reason: string }
  | { type: 'SET_QUALITY'; quality: QualityOverride | null }
  // `index` is the number the SERVER stored (E-7): it renumbers on collision
  // and returns what it actually wrote. Omitted only where there is no server
  // answer to adopt — the capture-less path below — in which case the local
  // proposal stands.
  | { type: 'CONFIRM_EPISODE'; quality: Quality; index?: number }
  | { type: 'SET_TARGET'; target: number }
  | {
      type: 'RESUME_TAKE';
      captureId: string;
      runLabel: string | null;
      reviewRevision: number;
    }
  | { type: 'SET_REVIEW_BASE'; revision: number }
  | { type: 'RETRY_EPISODE' }
  | { type: 'PAUSE_BATCH' }
  | { type: 'RESUME_BATCH' }
  | { type: 'PICK_END_REASON'; reason: string }
  | { type: 'CONFIRM_END_BATCH' }
  | { type: 'START_NEXT_BATCH' }
  | { type: 'RESET_BATCH' }
  | { type: 'SET_CONDITION'; condition: string }
  | { type: 'SET_PROJECT'; project: string; task: string; condition: string }
  | { type: 'SET_TASK'; task: string; condition: string }
  | {
      type: 'ROLLOVER_SET';
      project: string | null;
      task: string | null;
      condition: string;
    }
  | { type: 'SET_BATCH'; batchId: string | null; batchSeq: number | null };

function reducer(state: MachineState, action: Action): MachineState {
  switch (action.type) {
    case 'START_REQUESTED':
      if (state.phase !== 'ready') return state;
      return { ...state, phase: 'arming', startError: null };
    case 'START_FAILED':
      return { ...state, phase: 'ready', startError: action.error };
    case 'START_SUCCEEDED':
      return {
        ...state,
        phase: 'recording',
        elapsedMs: 0,
        qualityOverride: null,
        currentCaptureId: action.captureId,
        currentRunLabel: action.runLabel,
        // A capture the recorder just minted has never been reviewed, so the
        // first save's compare-and-swap token is 0 (§4.1).
        currentReviewRevision: 0,
        // Remember the capture we started (durable) for resumed-own takeover
        // detection.
        lastCaptureId: action.captureId ?? state.lastCaptureId,
        startError: null,
      };
    case 'CANCEL_ARMING':
      if (state.phase !== 'arming') return state;
      return { ...state, phase: 'ready' };
    case 'TICK': {
      if (state.phase !== 'recording') return state;
      return { ...state, elapsedMs: action.elapsedMs };
    }
    case 'STOP_REQUESTED':
      if (state.phase !== 'recording') return state;
      return { ...state, phase: 'saving', stopError: null };
    case 'RETRY_STOP':
      // Clear the prior stop error while a fresh stop is attempted (stays in
      // 'saving'; the mutation re-fires from the hook).
      if (state.phase !== 'saving') return state;
      return { ...state, stopError: null };
    case 'STOP_FAILED':
      // Stay in 'saving' and surface the error — the operator retries via the
      // visible Retry-stop button (D-3). The recording isn't lost; the recorder
      // is still holding the bag until a stop succeeds, so we never silently
      // swallow the failure or force the flow forward.
      return { ...state, stopError: action.error };
    case 'SAVED':
      if (state.phase !== 'saving') return state;
      return { ...state, phase: 'quickcheck' };
    case 'QUICK_CHECK_DONE':
      if (state.phase !== 'quickcheck') return state;
      // Pre-select Success so the happy path is a single primary action (D-9 ④).
      return {
        ...state,
        phase: 'result',
        pendingTask: 'ok',
        failReason: '',
        qualityOverride: null,
      };
    case 'PICK_RESULT':
      if (state.phase !== 'result') return state;
      return {
        ...state,
        pendingTask: action.result,
        failReason: action.result === 'ok' ? '' : state.failReason,
      };
    case 'PICK_FAIL_REASON':
      if (state.phase !== 'result') return state;
      return { ...state, failReason: action.reason };
    case 'SET_QUALITY':
      if (state.phase !== 'result') return state;
      return { ...state, qualityOverride: action.quality };
    case 'CONFIRM_EPISODE': {
      if (state.phase !== 'result' || !state.pendingTask) return state;
      if (state.pendingTask === 'fail' && !state.failReason) return state;
      // Independent axes: a failed task can still be good-quality, usable data.
      // Quality is decided by the HOOK (real integrity + any operator override)
      // and passed in — the reducer never reads a live signal itself.
      const taskResult: TaskResult = state.pendingTask === 'fail' ? 'fail' : 'ok';
      const quality: Quality = action.quality;
      // The next index follows the monotone recorded count (never reuses a
      // deleted episode's number).
      const recordedCount = state.recordedCount + 1;
      const episode: EpisodeRecord = {
        // The stored number when the server gave one, else our proposal. The
        // COUNT still advances by one either way: how many takes were recorded
        // and what number each got are different questions, and completion is
        // the first one.
        index: action.index ?? recordedCount,
        quality,
        taskResult,
        captureId: state.currentCaptureId ?? undefined,
        failReason: taskResult === 'fail' ? state.failReason : undefined,
      };
      const episodes = [...state.episodes, episode];
      const done = recordedCount >= state.targetEpisodes;
      return {
        ...state,
        episodes,
        recordedCount,
        phase: done ? 'completed' : 'ready',
        elapsedMs: 0,
        qualityOverride: null,
        pendingTask: null,
        failReason: '',
        currentCaptureId: null,
        currentRunLabel: null,
        currentReviewRevision: 0,
      };
    }
    case 'SET_REVIEW_BASE':
      // A refetched capture after a rejected save: adopt its current revision so
      // a re-apply is a compare-and-swap against what is actually stored. The
      // operator's typed values are deliberately untouched — §4.1 forbids
      // merging, so re-applying is their explicit decision, not ours.
      if (state.currentReviewRevision === action.revision) return state;
      return { ...state, currentReviewRevision: action.revision };
    case 'SET_TARGET': {
      // Clamp to a sane range; re-derive completion when at rest (raising the
      // target re-opens a completed batch, lowering it below the recorded
      // count completes it). Recording/result phases are never disturbed.
      const target = Math.max(1, Math.min(500, Math.floor(action.target)));
      if (!Number.isFinite(target) || target === state.targetEpisodes) return state;
      let phase = state.phase;
      if (phase === 'ready' || phase === 'completed') {
        phase = state.recordedCount >= target ? 'completed' : 'ready';
      }
      return { ...state, targetEpisodes: target, phase };
    }
    case 'RESUME_TAKE':
      // Recover an unsaved take (D-3): drop straight into the result panel for
      // the given capture so the operator can label it. Success is pre-selected;
      // quality falls back to auto (no override) until the operator changes it.
      return {
        ...state,
        phase: 'result',
        currentCaptureId: action.captureId,
        currentRunLabel: action.runLabel,
        currentReviewRevision: action.reviewRevision,
        pendingTask: 'ok',
        failReason: '',
        qualityOverride: null,
        elapsedMs: 0,
        startError: null,
        stopError: null,
      };
    case 'RECORDING_INTERRUPTED':
      // The recorder came back and is not holding this capture. Whatever
      // happened while it was silent, the recording is over — so the screen
      // stops claiming it is running. The capture is released rather than
      // forgotten: it exists server-side as `interrupted` with whatever bytes
      // it managed, and the unsaved-take banner offers it for recovery.
      if (state.phase !== 'recording') return state;
      return {
        ...state,
        phase: 'ready',
        elapsedMs: 0,
        qualityOverride: null,
        pendingTask: null,
        failReason: '',
        currentCaptureId: null,
        currentRunLabel: null,
        currentReviewRevision: 0,
      };
    case 'RETRY_EPISODE':
      if (state.phase !== 'result') return state;
      return {
        ...state,
        phase: 'ready',
        elapsedMs: 0,
        qualityOverride: null,
        pendingTask: null,
        failReason: '',
        currentCaptureId: null,
        currentRunLabel: null,
        currentReviewRevision: 0,
      };
    case 'PAUSE_BATCH':
      if (state.phase !== 'ready') return state;
      return { ...state, phase: 'paused' };
    case 'RESUME_BATCH':
      if (state.phase !== 'paused') return state;
      return { ...state, phase: 'ready' };
    case 'PICK_END_REASON':
      return { ...state, endReason: action.reason };
    case 'CONFIRM_END_BATCH':
      if (!state.endReason) return state;
      return { ...state, phase: 'ended' };
    case 'START_NEXT_BATCH':
      if (state.phase !== 'ended' && state.phase !== 'completed') return state;
      return {
        ...state,
        episodes: [],
        recordedCount: 0,
        recordedIsFloor: false,
        // A new batch needs a fresh server batch (and its own new batch_seq);
        // both cleared here and re-created lazily on the next start (ensureBatch).
        batchSeq: null,
        batchId: null,
        phase: 'ready',
        elapsedMs: 0,
        qualityOverride: null,
        endReason: '',
        currentCaptureId: null,
        currentRunLabel: null,
        currentReviewRevision: 0,
      };
    case 'RESET_BATCH':
      // Close the current batch and start a fresh one: counts back to 0/30, the
      // batch number cleared (a NEW server batch_seq is assigned lazily on the
      // next recording — an empty reset never inflates the number). The
      // recordings already taken are NOT touched — they stay in Review. Also
      // clears any in-flight/result state so reset works from any phase (the
      // hook stops/cancels a live recording first).
      return {
        ...state,
        episodes: [],
        recordedCount: 0,
        recordedIsFloor: false,
        batchSeq: null,
        batchId: null,
        phase: 'ready',
        elapsedMs: 0,
        qualityOverride: null,
        pendingTask: null,
        failReason: '',
        startError: null,
        stopError: null,
        endReason: '',
        currentCaptureId: null,
        currentRunLabel: null,
        currentReviewRevision: 0,
      };
    case 'SET_CONDITION':
      return { ...state, condition: action.condition };
    case 'SET_PROJECT':
      return {
        ...state,
        project: action.project,
        task: action.task,
        condition: action.condition,
      };
    case 'SET_TASK':
      return { ...state, task: action.task, condition: action.condition };
    case 'ROLLOVER_SET': {
      // A context change (project/task/condition) once this batch already holds a
      // recording: close the current set locally and open a fresh one with the
      // new context. Earlier episodes keep their original context (condition is
      // stored per-batch server-side, so relabeling in place would retroactively
      // mislabel them). Mirrors START_NEXT_BATCH — counts/number/episodes reset,
      // targetEpisodes inherited — but also applies the new context and predicts
      // the next set number from the closing set's known seq. The new server
      // batch is created lazily on the next recording (ensureBatch), which reads
      // this new context from the store snapshot.
      const nextPredicted =
        state.batchSeq != null ? state.batchSeq + 1 : state.predictedSeq;
      return {
        ...state,
        episodes: [],
        recordedCount: 0,
        recordedIsFloor: false,
        batchSeq: null,
        batchId: null,
        predictedSeq: nextPredicted,
        project: action.project,
        task: action.task,
        condition: action.condition,
        phase: 'ready',
        elapsedMs: 0,
        qualityOverride: null,
        pendingTask: null,
        failReason: '',
        startError: null,
        stopError: null,
        endReason: '',
        currentCaptureId: null,
        currentRunLabel: null,
        currentReviewRevision: 0,
      };
    }
    case 'SET_BATCH':
      return { ...state, batchId: action.batchId, batchSeq: action.batchSeq };
    default:
      return state;
  }
}

// Exported for direct reducer unit tests (no React needed for pure transitions).
export {
  reducer,
  createInitialState,
  reducer as batchMachineReducer,
  createInitialState as createBatchMachineState,
};
