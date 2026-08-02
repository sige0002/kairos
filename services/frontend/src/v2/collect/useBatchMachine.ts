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
  useSyncExternalStore,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost } from '../../api/client';
import { createBatch, listBatches, patchBatch } from '../../api/batches';
import { getCapture, listCaptures, saveReview } from '../../api/captures';
import { queryKeys } from '../../api/queryKeys';
import { useUiStore } from '../../store/uiStore';
import {
  useCaptureDeletion,
  type CaptureDeletionState,
} from '../captures/useCaptureDeletion';
import { needsReload } from '../captures/errors';
import { useRecordStatus } from '../captures/useRecordStatus';
import { findProject, findTask, getPlans } from '../plans';
import { RECORDING_CONFIG_KEY } from '../../features/config/ConfigTab';
import {
  ACTIVE_RECORD_STATES,
  liveCaptureIds,
  type BatchEpisodeSummary,
  type BatchSummary,
  type Capture,
  type CaptureDetail,
  type Quality as ServerQuality,
  type QuickCheckVerdict,
  type RecordArming,
  type RecordIntegrity,
  type RecordPrepareResponse,
  type RecordStartRequest,
  type RecordState,
  type RecordStatus,
  type RecordingConfigPayload,
  type ReviewSaveRequest,
  type ReviewStatus,
} from '../../api/types';

export type Phase =
  | 'ready'
  | 'arming'
  | 'recording'
  | 'saving'
  | 'quickcheck'
  | 'result'
  | 'paused'
  | 'ended'
  | 'completed';

// Two independent axes — NOT one merged bucket. A failed task still produced
// a usable, labeled recording (see docs/specs: Datasets "include failures:
// yes, labeled"); collapsing them into a single "not usable" result would
// contradict that. `quality` has no 'bad'/'not usable' value yet in Phase 1 —
// that would come from full (post-recording) validation, which doesn't exist
// here — so the only quality signal available live is the review flag.
export type Quality = 'good' | 'review';
export type TaskResult = 'ok' | 'fail';

// The operator's optional quality override on the result panel. 'notusable' has
// no local EpisodeRecord equivalent (see Quality) — it maps to 'review' for the
// strip/tallies and to the server 'not_usable' on save.
export type QualityOverride = 'good' | 'review' | 'notusable';

// A recorder error carried to the UI: `code` is the machine-readable code
// (e.g. `already_recording`) when the backend/transport gave one, so ControlCard
// can show friendly copy and a muted `(code)` line; null when only a message.
export interface MachineError {
  code: string | null;
  message: string;
}

/** Why Stop is refused right now (M2). `floor` = the take is younger than
 *  STOP_FLOOR_MS. */
export type StopBlockedReason = 'floor' | null;

/** Minimum life of a take before Stop is accepted. A real double-click's second
 *  press lands tens of milliseconds after the first (qa-ui measured 86ms), and
 *  no deliberate recording is a second long. */
export const STOP_FLOOR_MS = 1000;

// The floor is a real wall-clock wait, which every test that merely needs to
// reach the result phase would otherwise have to sit through. Unit tests opt
// out explicitly through this seam (the same module-store + setter shape as
// splitMode.ts); the guard's own tests use the shipped value.
let stopFloorMs = STOP_FLOOR_MS;
export function __setStopFloorMs(ms: number): void {
  stopFloorMs = ms;
}
export function __resetStopFloorMs(): void {
  stopFloorMs = STOP_FLOOR_MS;
}

export interface EpisodeRecord {
  index: number;
  /** Recording/data quality — independent of whether the task succeeded. */
  quality: Quality;
  /** Whether the demonstrated task succeeded — independent of data quality. */
  taskResult: TaskResult;
  /** The capture this episode labels — the only identity (§1). Absent only for
   *  a take the recorder never named. */
  captureId?: string;
  failReason?: string;
}

/** Plain-language "Task outcome: …" line for the episode-result summary. */
export function describeTaskOutcome(
  pendingTask: 'ok' | 'fail' | null,
  failReason: string,
): string {
  if (pendingTask === 'ok') return 'Success.';
  if (pendingTask === 'fail') {
    return failReason
      ? `Failed — ${failReason.toLowerCase()}.`
      : 'Failed — choose a reason below.';
  }
  return '—';
}

/** Human labels for the effective quality shown on the result panel. */
export const QUALITY_LABEL: Record<QualityOverride, string> = {
  good: 'Good',
  review: 'Needs review',
  notusable: 'Not usable',
};

/**
 * The `review_status` a Collect save stamps on the capture (§4.1).
 *
 * Collect labels a take; whether it is adopted into a dataset is Review's
 * decision, so a labeled take stays `pending`. The one exception is an operator
 * who called the data not usable — that is the same statement Review's own
 * exclude makes, and leaving it `pending` would put it straight back into the
 * queue it was just taken out of.
 */
export function collectReviewStatus(
  override: QualityOverride | null,
): ReviewStatus {
  return override === 'notusable' ? 'excluded' : 'pending';
}

// The plan catalog (Projects → Tasks → Conditions) now lives in the shared
// v2/plans store so a Settings edit reflects here immediately. This screen reads
// the live catalog (getPlans / usePlans) rather than a private copy.

export const FAIL_REASONS = [
  'Grasp missed',
  'Object dropped',
  'Wrong placement',
  'Object misplaced at start',
  'Robot fault',
  'Other',
];

export const END_REASONS = [
  'Work time over',
  'Equipment / system problem',
  'Condition change',
  'Safety',
  'Plan change',
  'Other',
];

export interface AdviceItem {
  badge: string;
  title: string;
  detail: string;
}

// Advice generation is intentionally NOT implemented — one fixed placeholder
// item, per the design decision (see the Collect task brief).
export const ADVICE_ITEMS: AdviceItem[] = [
  {
    badge: 'QUALITY',
    title: 'Hold still for ~1 s before starting',
    detail:
      'The first second after Start stabilizes the initial state the model learns ' +
      'from — a brief pause before moving improves this episode.',
  },
];

export const EPISODES_PER_BATCH = 30;
// Quick-check waits for the real integrity signal from /record/status; this is
// only the backstop if that signal never lands (e.g. an older backend that
// doesn't classify integrity) so the operator is never stuck on QUICK CHECK.
const QUICKCHECK_FALLBACK_MS = 3000;
// A just-saved episode's strip chip flashes a teal ring for this long.
const SAVED_FLASH_MS = 1200;
// An unsaved take older than this is no longer offered for recovery.
const UNSAVED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Pre-arm keep-alive: re-prepare this long BEFORE the armed session's
// disarm_at deadline (covers request latency + the status-poll lag).
const PREARM_KEEPALIVE_LEAD_MS = 20_000;
// Retry cadence after a failed prepare (or when disarm_at is unknown).
const PREARM_RETRY_MS = 30_000;

interface MachineState {
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
  project: string;
  task: string;
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
    project: firstPlan?.name ?? '—',
    task: firstTask?.name ?? '—',
    condition: firstTask?.conditions[0] ?? '—',
    endReason: '',
  };
}

type Action =
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
  | { type: 'CONFIRM_EPISODE'; quality: Quality }
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
      project: string;
      task: string;
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
        index: recordedCount,
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
  reducer as batchMachineReducer,
  createInitialState as createBatchMachineState,
};

// ---------------------------------------------------------------------------
// Module-level external store for the batch machine.
//
// The reducer above is unchanged; only its *host* moves. The Collect screen is
// unmounted whenever the operator switches tabs (App.tsx renders only the
// active tab — including the "REC N topics" chip / "Open in Monitor →" jumps),
// so a `useReducer` inside the hook wiped the whole batch on every navigation.
// Parking the state in module scope (like uiStore does for the Live-tab drafts)
// makes it survive the unmount: the module store keeps the FULL state — phase
// included — so a mid-result-phase round-trip keeps its run_id, and components
// re-subscribe on remount via `useSyncExternalStore`.
//
// Durable session context (batch number, confirmed episodes, project/task/
// condition) is ALSO mirrored to localStorage so it survives a full reload.
// Volatile/in-flight state is never persisted: on a reload the phase resolves to
// the safe baseline (ready, or the completed-batch summary when the episode
// count is already full), timers reset, and any in-flight recording truth comes
// from the /record/status poll — never reconstructed from storage.
const BATCH_STORAGE_KEY = 'kairos.collect.batch';

interface PersistedBatch {
  /** Server batch number (null until created / API down). */
  batchSeq: number | null;
  /** Monotone recorded count (survives an API-down reload; see the note above). */
  recordedCount: number;
  /** Planned episodes for this batch (server target_episodes); absent in older
   *  blobs -> the 30 default. */
  targetEpisodes?: number;
  /** Server batch id, mirrored so an API-down reload can still resume. */
  batchId: string | null;
  episodes: EpisodeRecord[];
  project: string;
  task: string;
  condition: string;
  /** Last capture this browser started — durable so a reload can still
   *  recognise a recording it started as "resumed own", not another session's. */
  lastCaptureId: string | null;
}

/** Serialize just the durable subset (used both to persist and to dedupe). */
function serializeDurable(state: MachineState): string {
  const blob: PersistedBatch = {
    batchSeq: state.batchSeq,
    recordedCount: state.recordedCount,
    targetEpisodes: state.targetEpisodes,
    batchId: state.batchId,
    episodes: state.episodes,
    project: state.project,
    task: state.task,
    condition: state.condition,
    lastCaptureId: state.lastCaptureId,
  };
  return JSON.stringify(blob);
}

// Skip redundant writes: TICK fires ~4x/s during recording but never changes
// the durable subset, so we only touch localStorage when it actually differs.
let lastPersisted = '';

function persistBatch(state: MachineState): void {
  const blob = serializeDurable(state);
  if (blob === lastPersisted) return;
  lastPersisted = blob;
  try {
    window.localStorage.setItem(BATCH_STORAGE_KEY, blob);
  } catch {
    // localStorage unavailable (private mode / SSR): the in-memory store still
    // survives tab switches; only reload-persistence is lost.
  }
}

/** Lower bound for the monotone recorded count from an episode list — the max
 *  of the list length and the highest episode index (an older backend that
 *  omits `episodes_recorded` still can't lower the count below what's present). */
function maxRecorded(episodes: EpisodeRecord[]): number {
  let m = episodes.length;
  for (const e of episodes) if (typeof e.index === 'number' && e.index > m) m = e.index;
  return m;
}

/** Fresh state seeded from the persisted durable context, if any. Volatile
 *  fields (phase, timers, run id, pending result, errors) are NEVER restored. */
function readInitialState(): MachineState {
  const base = createInitialState();
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(BATCH_STORAGE_KEY);
  } catch {
    return base;
  }
  if (!raw) return base;
  try {
    const blob = JSON.parse(raw) as Partial<PersistedBatch> | null;
    if (!blob || typeof blob !== 'object') return base;
    const episodes = Array.isArray(blob.episodes)
      ? (blob.episodes as EpisodeRecord[])
      : [];
    const recordedCount = Math.max(
      typeof blob.recordedCount === 'number' ? blob.recordedCount : 0,
      maxRecorded(episodes),
    );
    const targetEpisodes =
      typeof blob.targetEpisodes === 'number' && blob.targetEpisodes >= 1
        ? Math.floor(blob.targetEpisodes)
        : EPISODES_PER_BATCH;
    // A durable full batch resumes on its completed summary; anything else
    // lands on the safe 'ready' baseline. The persisted phase (if any) is
    // ignored on purpose — see the note above.
    const phase: Phase = recordedCount >= targetEpisodes ? 'completed' : 'ready';
    return {
      ...base,
      phase,
      batchSeq: typeof blob.batchSeq === 'number' ? blob.batchSeq : null,
      recordedCount,
      targetEpisodes,
      batchId: typeof blob.batchId === 'string' ? blob.batchId : null,
      episodes,
      project: typeof blob.project === 'string' ? blob.project : base.project,
      task: typeof blob.task === 'string' ? blob.task : base.task,
      condition: typeof blob.condition === 'string' ? blob.condition : base.condition,
      lastCaptureId:
        typeof blob.lastCaptureId === 'string' ? blob.lastCaptureId : null,
    };
  } catch {
    return base;
  }
}

let currentState: MachineState = readInitialState();
const storeListeners = new Set<() => void>();

// Captures the operator has dismissed ("Later") from the unsaved-take banner.
// Persisted, because the banner PROMISES it: "Later hides them all until a new
// one appears". A dismissal that a reload undoes breaks that promise in the one
// situation the operator is most likely to hit it — they dismissed precisely
// because they did not want to deal with those takes yet.
//
// Ids, not a flag: a take recorded AFTER the dismissal has an id nobody
// dismissed, so it surfaces on its own without any expiry rule.
const DISMISSED_STORAGE_KEY = 'kairos.collect.dismissedUnsaved';

function readDismissed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [],
    );
  } catch {
    // Unreadable or unavailable storage: the banner simply re-offers them,
    // which is the safe direction — an unsaved take shown twice costs a click,
    // one hidden wrongly costs the take.
    return new Set();
  }
}

const dismissedUnsavedCaptures = readDismissed();

function persistDismissed(): void {
  try {
    window.localStorage.setItem(
      DISMISSED_STORAGE_KEY,
      JSON.stringify([...dismissedUnsavedCaptures]),
    );
  } catch {
    // Best-effort: the in-memory set still holds for this session.
  }
}

function notifyStore(): void {
  for (const listener of storeListeners) listener();
}

function dispatch(action: Action): void {
  const next = reducer(currentState, action);
  if (next === currentState) return;
  currentState = next;
  persistBatch(next);
  notifyStore();
}

function subscribeStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

function getStoreSnapshot(): MachineState {
  return currentState;
}

/** React binding for the module store (subscribes for the component's life). */
function useBatchState(): MachineState {
  return useSyncExternalStore(subscribeStore, getStoreSnapshot, getStoreSnapshot);
}

// ---- Phase 2 server restore ----------------------------------------------
// On the first Collect mount of a page load, the durable batch context is
// reconciled with the orchestrator (GET /batches?status=active — server truth,
// which supersedes the localStorage fallback restored above). Runs once per
// load (this flag), never on later tab-switch remounts, so it can't clobber
// in-memory progress; and only while the machine is at rest, so it never
// disturbs an active recording. On API failure the localStorage restore stands.
let serverHydrated = false;

/** Map a server batch's capture summary to the local display record. */
function serverEpisodeToRecord(ep: BatchEpisodeSummary): EpisodeRecord {
  return {
    index: ep.index,
    // Collect's live quality axis is good | review; a server 'not_usable'
    // (e.g. a Review exclude) has no Collect equivalent, so it shows as review.
    quality: ep.quality === 'good' ? 'good' : 'review',
    taskResult: ep.task_result === 'failure' ? 'fail' : 'ok',
    captureId: ep.capture_id,
  };
}

/** Adopt the server's active batch as the durable context. When the server
 *  reports none we deliberately leave local state alone (a no-op) rather than
 *  clobber it — the local blob may hold a just-finished batch whose PATCH has
 *  not landed yet; it self-heals on the next recording. Volatile phase stays at
 *  rest. */
function applyServerRestore(batch: BatchSummary | null): void {
  if (!batch) return;
  const serverEpisodes = batch.episodes.map(serverEpisodeToRecord);
  // Same batch as the local blob? Then local episodes the server does NOT have
  // (a review save whose response hadn't landed when the page went away) must
  // survive the restore — replacing the list wholesale flipped a just-saved chip
  // back to "not recorded". A record whose slot the server has since given to
  // another capture can't be placed honestly and is dropped (the monotone count
  // still includes it).
  const sameBatch = currentState.batchId === batch.batch_id;
  let episodes = serverEpisodes;
  if (sameBatch) {
    const serverCaptureIds = new Set(
      serverEpisodes
        .map((e) => e.captureId)
        .filter((id): id is string => typeof id === 'string'),
    );
    const usedIndexes = new Set(serverEpisodes.map((e) => e.index));
    const localOnly = currentState.episodes.filter(
      (e) =>
        (!e.captureId || !serverCaptureIds.has(e.captureId)) &&
        !usedIndexes.has(e.index),
    );
    if (localOnly.length > 0) {
      episodes = [...serverEpisodes, ...localOnly].sort((a, b) => a.index - b.index);
    }
  }
  // The batch number is the server's own batch_seq (null on an older backend
  // that doesn't serve it yet → honest "—" fallback in the UI).
  const batchSeq = typeof batch.batch_seq === 'number' ? batch.batch_seq : null;
  // Monotone recorded count: the server's `episodes_recorded` (which excludes
  // nothing and never drops on a Review delete) — or, on an older backend, the
  // episode list's own lower bound. The locally-held count only joins the max
  // when it belongs to THIS batch — carrying a different (e.g. just-finished)
  // batch's count into the server's active batch would inflate it.
  const serverRecorded =
    typeof batch.episodes_recorded === 'number'
      ? batch.episodes_recorded
      : maxRecorded(serverEpisodes);
  const recordedCount = Math.max(
    serverRecorded,
    sameBatch ? currentState.recordedCount : 0,
    maxRecorded(episodes),
  );
  // The batch's own plan size (the API always carried it; the UI now follows).
  const targetEpisodes =
    typeof batch.target_episodes === 'number' && batch.target_episodes >= 1
      ? Math.floor(batch.target_episodes)
      : EPISODES_PER_BATCH;
  const phase: Phase = recordedCount >= targetEpisodes ? 'completed' : 'ready';
  currentState = {
    ...createInitialState(),
    batchId: batch.batch_id,
    batchSeq,
    recordedCount,
    targetEpisodes,
    project: batch.project,
    task: batch.task,
    condition: batch.condition ?? '—',
    episodes,
    phase,
    // Preserve the durable last-capture pointer so a resumed-own takeover is
    // still recognised after a server restore (which otherwise resets to a fresh
    // state).
    lastCaptureId: currentState.lastCaptureId,
  };
  persistBatch(currentState);
  notifyStore();
}

/** True when the persisted local batch holds real content worth reconciling
 *  against the server (a recorded count, episodes, or a server batch handle) —
 *  vs a pristine empty machine that has nothing to discard. */
function hasLocalBatchContext(s: MachineState): boolean {
  return (
    s.recordedCount > 0 ||
    s.episodes.length > 0 ||
    s.batchSeq != null ||
    s.batchId != null
  );
}

/** True when a local batch context can't be backed by any server capture — a
 *  phantom left behind after the captures/batches were deleted server-side
 *  (Apple P0: an operator wipes the catalog, then the next load shows "Batch 6 ·
 *  3 recorded" that no longer exists). Only reports phantom on POSITIVE evidence
 *  of absence: one surviving capture keeps the whole context. */
function localBatchIsPhantom(s: MachineState, captures: Capture[]): boolean {
  const serverCaptureIds = new Set(captures.map((c) => c.capture_id));
  const localCaptureIds = s.episodes
    .map((e) => e.captureId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (localCaptureIds.length > 0) {
    // Every recorded episode's capture is gone from the server → phantom. If
    // even one survives, keep the context.
    return localCaptureIds.every((id) => !serverCaptureIds.has(id));
  }
  // No capture ids to check (an older blob, or counts without episodes):
  // phantom only when the server has NO captures at all — otherwise we can't
  // prove the local batch is stale, so we keep it (offline resilience).
  return captures.length === 0;
}

/** Discard a stale local batch context (a confirmed phantom): clear the
 *  persisted blob and reset the machine to the honest empty state, preserving
 *  only the transient predicted next-batch number (recomputed this same load).
 *  The counters then read the truth — nothing recorded — instead of numbers for
 *  recordings that no longer exist. */
function clearLocalBatch(): void {
  lastPersisted = '';
  try {
    window.localStorage.removeItem(BATCH_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  const predicted = currentState.predictedSeq;
  currentState = { ...createInitialState(), predictedSeq: predicted };
  notifyStore();
}

/** True when `iso` falls on today's LOCAL calendar day (batch_seq resets per
 *  local date server-side, so the prediction must use the same day boundary). */
function isLocalToday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/** 1 + the largest batch_seq among today's batches — the number the NEXT batch
 *  will most likely get. No batches today (or none carry a seq) → 1. */
function predictNextSeq(items: BatchSummary[]): number {
  let max = 0;
  for (const b of items) {
    if (
      isLocalToday(b.created_at) &&
      typeof b.batch_seq === 'number' &&
      b.batch_seq > max
    ) {
      max = b.batch_seq;
    }
  }
  return max + 1;
}

/** Store the predicted next batch number (display hint; never persisted). */
function setPredictedSeq(seq: number | null): void {
  if (currentState.predictedSeq === seq) return;
  currentState = { ...currentState, predictedSeq: seq };
  notifyStore();
}

// Test-only hooks: reset the module store between tests, or re-run the
// storage-restore path after seeding a localStorage blob. Not used in app code.
export function __resetBatchStore(): void {
  lastPersisted = '';
  serverHydrated = false;
  dismissedUnsavedCaptures.clear();
  try {
    window.localStorage.removeItem(DISMISSED_STORAGE_KEY);
    window.localStorage.removeItem(BATCH_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  currentState = createInitialState();
  notifyStore();
}
export function __rehydrateBatchStore(): void {
  lastPersisted = '';
  currentState = readInitialState();
  notifyStore();
}

export interface BatchStats {
  nRecorded: number;
  /** quality === 'good' (independent of task outcome). */
  nGood: number;
  /** quality === 'review' (independent of task outcome). */
  nReview: number;
  /** taskResult === 'fail' — a separate axis, NOT a quality bucket. Can
   *  overlap with nGood or nReview (a failed task can still be good data). */
  nTaskFailed: number;
  nRemaining: number;
  epNext: number;
}

export interface UseBatchMachineArgs {
  /** The active robot's configured `default_topics` (from runtime config). The
   *  actual next-start selection is resolved from this + the uiStore record
   *  picker (see `RecordSelection` / v1 LiveTab.tsx:940-948). */
  defaultTopics: string[];
}

/** Resolved topic selection for the next /record/start (mirrors v1 LiveTab). */
export interface RecordSelection {
  /** Explicit concrete names, or 'all' to record everything. */
  topics: string[] | 'all';
  /** How many topics that represents (for the record-topics chip). */
  count: number;
  /** Whether the operator customized the Monitor picker (vs configured defaults). */
  customized: boolean;
}

export interface BatchMachine {
  phase: Phase;
  episodes: EpisodeRecord[];
  /** Server batch number (null before the batch is created / on an older
   *  backend). The UI shows "Batch {batchSeq}" or an honest "—" fallback. */
  batchSeq: number | null;
  /** Predicted next batch number (display hint) for the pre-state shown while
   *  `batchSeq` is null. Null → the UI falls back to "next #1". */
  predictedSeq: number | null;
  elapsedMs: number;
  pendingTask: 'ok' | 'fail' | null;
  failReason: string;
  startError: MachineError | null;
  stopError: MachineError | null;
  isStarting: boolean;
  stats: BatchStats;

  // Quality (D-2): the auto value from the real integrity signal, plus the
  // operator's optional override. `autoQuality` drives the QUICK chip; the
  // effective quality (override ?? auto) is what gets saved.
  /** Real quick-check quality for the current run (from integrity), never a mock. */
  autoQuality: Quality;
  /** Operator override, or null when accepting the auto value. */
  qualityOverride: QualityOverride | null;
  /** Set the operator override (null clears it back to auto). */
  setQuality: (q: QualityOverride | null) => void;

  // Settled quick-check verdict (F1): the server's stop-time quality call plus
  // its human-readable reasons, shown on the result panel when settled.
  quickCheck: {
    /** The settled verdict, or null while unsettled / on an older backend. */
    verdict: QuickCheckVerdict | null;
    /** True while on the result panel waiting for the verdict to settle. */
    pending: boolean;
  };

  // Real recorder signals from /record/status (never the mock quality flag).
  /** Live arming matched/missing snapshot (OL-①.4). Null unless the recorder
   *  reports it; a non-persisted live aid, never stored anywhere. */
  arming: RecordArming | null;
  /** Recording integrity for THIS episode's run (OL-①). 'dropped'/'failed'
   *  drive the result-phase banner; gated to the current run so a prior run's
   *  drop can't leak into this episode's result. */
  integrity: RecordIntegrity | null;
  /** rosbag2's self-reported messages lost when integrity is 'dropped'. */
  droppedMessages: number | null;
  /** Finalised/live bag size for the current capture (formatBytes it; null → "—"). */
  recordingBytes: number | null;
  /** The recorder's SERVER state (from /record/status), the single source the
   *  SYSTEM STATUS Recorder row and the takeover card both read — so the two can
   *  never contradict. Null before the first poll. The recorder has no `idle`:
   *  a fresh one sits in `created` (§10). */
  recorderState: RecordState | null;
  /** The recorder's live capture set, or null when it did not answer with one —
   *  which means UNREACHABLE, not "nothing is live" (§10 rev.2.4). The two are
   *  never collapsed: the UI says it does not know rather than reporting an
   *  empty set it never saw. */
  liveCaptures: string[] | null;
  /** True while the recorder holds a pre-armed (two-phase prepare) session:
   *  the next matching Start is a near-instant resume. Server-reported, never
   *  assumed from having sent a prepare. */
  preArmed: boolean;

  // Takeover (D-1): a recording is running server-side that this screen is not
  // driving (another tab/session, or a reload of our own). Null in the normal
  // case; when set, ControlCard shows the takeover card instead of a phase card.
  takeover: {
    captureId: string;
    /** The capture's run_id — DISPLAY ONLY (§1); null until the detail loads. */
    runLabel: string | null;
    startedAt: string | null;
    bytes: number | null;
    /** Topic count from the capture (RecordStatus has no topic list); null until loaded. */
    topicsCount: number | null;
    /** Operator from the capture; null when absent (never fabricated). */
    operator: string | null;
  } | null;
  /** True when the takeover capture is one this browser started (resumed own). */
  takeoverResumedOwn: boolean;
  takeoverStopModalOpen: boolean;
  openTakeoverStopModal: () => void;
  confirmTakeoverStop: () => void;
  isTakeoverStopping: boolean;

  // Unsaved take recovery (D-3): a finished capture with review_revision 0 —
  // never reviewed — offered for recovery after a reload between Stop and Save.
  // Null when none.
  unsavedTake: {
    captureId: string;
    /** run_id for display (§1); null when the capture carries none. */
    runLabel: string | null;
    startedAt: string | null;
    bytes: number | null;
    durationMs: number | null;
    /** True when the take ended on its own rather than being stopped. */
    interrupted: boolean;
    /** Why it ended, from the capture's own error. Null when none was
     *  recorded — the banner then says only that it ended by itself. */
    reason: string | null;
  } | null;
  /** Open the result panel for the unsaved take to label it. */
  labelUnsavedTake: () => void;
  /** Open the shared discard dialog for the unsaved take. */
  discardUnsavedTake: () => void;
  /** Hide the unsaved-take banner until a take recorded AFTER this point
   *  appears (or the next page load). */
  dismissUnsavedTake: () => void;
  /** How many recoverable unsaved takes exist right now. More than one is
   *  worth saying: the operator is looking at a banner for one of them. */
  unsavedTakeCount: number;
  /** When the take the result panel is about started — the field the operator
   *  can match against the recovery banner, which names its own take the same
   *  way. Null before a capture exists or when the recorder gave no time. */
  currentTakeStartedAt: string | null;
  /** The shared discard flow driving that dialog (§7 + §12). */
  unsavedDiscard: CaptureDeletionState;

  /** Index of the just-saved episode (flashes its strip chip), cleared shortly after. */
  lastSavedIndex: number | null;

  // Next-recording topic selection (resolved from config default_topics + the
  // uiStore Monitor picker; the picker checkboxes are another screen's task —
  // Collect only consumes the store).
  selection: RecordSelection;
  /** True only when the operator explicitly cleared every topic — disables
   *  Start (v1 LiveTab parity). */
  noSelection: boolean;

  // context
  project: string;
  task: string;
  condition: string;
  /** Planned episodes for the current batch (server target_episodes). */
  targetEpisodes: number;
  ctxEditable: boolean;
  condAllowed: boolean;
  endReason: string;

  // pickers / menu / modals
  batchMenuOpen: boolean;
  projPickerOpen: boolean;
  taskPickerOpen: boolean;
  endModalOpen: boolean;
  issueModalOpen: boolean;
  condModalOpen: boolean;
  resetModalOpen: boolean;
  targetModalOpen: boolean;
  /** Keyboard-shortcuts help sheet (opened with `?`). */
  shortcutsOpen: boolean;
  toggleBatchMenu: () => void;
  openProjPicker: () => void;
  openTaskPicker: () => void;
  openCondModal: () => void;
  openTargetModal: () => void;
  /** Set the batch's planned episode count (clamped 1-500; PATCHes the server
   *  batch when one exists). */
  changeTarget: (target: number) => void;
  openEndModal: () => void;
  openIssueModal: () => void;
  openResetModal: () => void;
  openShortcuts: () => void;
  closeModals: () => void;

  // Discard this take (§7): a DISCARD, not a delete — the data was never worth
  // keeping — so it runs through the shared dialog, which states the
  // irreversibility and requires a reason.
  episodeDiscard: CaptureDeletionState;
  /** True on a split deployment: the robot keeps its own copy, so a discard only
   *  removes what is on this machine and the dialog must say so (§12). */
  splitDeploy: boolean;
  /** `run_YYYYMMDD_HHMMSS` of the take being labeled. DISPLAY ONLY (§1). */
  currentRunLabel: string | null;

  // advice pager
  adviceIdx: number;
  advicePrev: () => void;
  adviceNext: () => void;

  // toast
  toast: string;

  // actions
  startRecording: () => void;
  cancelArming: () => void;
  stopRecording: () => void;
  /** Whether Stop may be used yet, and if not, why (M2 — see STOP_FLOOR_MS). */
  canStop: boolean;
  stopBlockedReason: StopBlockedReason;
  /** True once a /record/status poll has failed: the recorder is not answering
   *  and nothing derived from its last response may be presented as current. */
  recorderUnreachable: boolean;
  /** Milliseconds since the last SUCCESSFUL poll, for "last known: …, Ns ago".
   *  Null when there has never been one. */
  recorderStaleMs: number | null;
  /** Re-attempt a stop that failed (stays in SAVING). */
  retryStop: () => void;
  pickSuccess: () => void;
  pickFailure: () => void;
  pickFailReason: (reason: string) => void;
  /** Save the review on the capture (§4.1 compare-and-swap). Resolves only once
   *  the server accepted it — the strip chip and the receipt never claim a save
   *  that did not happen (§12). */
  confirmEpisode: () => void;
  /** True while that save is in flight. */
  isSavingReview: boolean;
  /** The rejected save, kept until the operator acts on it. A 409 means someone
   *  else edited the capture (re-apply); a 500 means NOTHING was saved. */
  saveError: unknown;
  /** Dismiss that message once the operator has read it (§12: it is never
   *  cleared on a timer). */
  dismissSaveError: () => void;
  /** Open the shared discard dialog for the take being labeled. */
  openDiscardModal: () => void;
  pauseBatch: () => void;
  resumeBatch: () => void;
  pickEndReason: (reason: string) => void;
  confirmEndBatch: () => void;
  submitIssue: () => void;
  startNextBatch: () => void;
  /** Reset the batch (counts → 0/30, recordings kept in Review). */
  resetBatch: () => void;
  pickProject: (name: string) => void;
  pickTask: (name: string) => void;
  /** Set a free-text task the operator typed (v1 parity — recording accepted any
   *  task string). Not added to the plans store; flows into the next
   *  /record/start and /batches as-is. */
  pickCustomTask: (name: string) => void;
  pickCondition: (condition: string) => void;
  /** Set a free-text condition the operator typed in the condition modal. Not
   *  added to the plans catalog; behaves exactly like a catalog condition
   *  afterwards (a string on the batch). Rolls it over when the current batch
   *  already has a recording, same as pickCondition. */
  pickCustomCondition: (condition: string) => void;
  /** Jump to the Monitor tab (Warnings card's "Open in Monitor →"). */
  goMonitor: () => void;
}

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
  // While the operator sits ready-to-record, keep the recorder ARMED — a
  // standing /record/prepare, kept alive by matching re-prepares shortly before
  // its disarm deadline — so Start is a near-instant resume instead of a
  // multi-second spawn + DDS-discovery wait. Bounded and honest:
  //  - config-gated (recording.pre_arm): an armed recorder carries
  //    recording-level DDS receive load, so a tight-budget robot turns it off;
  //  - only while this tab is visible and the phase is ready/result (the
  //    recorder's own prepare_disarm_timeout_s cleans up an abandoned arm);
  //  - best-effort: a failed prepare is never surfaced — Start simply falls
  //    back to the full synchronous path.
  const recordingConfigQuery = useQuery({
    queryKey: RECORDING_CONFIG_KEY,
    queryFn: ({ signal }) =>
      apiGet<RecordingConfigPayload>('/config/recording', { signal }),
    staleTime: 60_000,
  });
  const preArmEnabled = useMemo(() => {
    const cfg = recordingConfigQuery.data?.config;
    if (!cfg || typeof cfg !== 'object') return false; // unknown yet -> don't arm
    const tuning = (cfg as { recording?: { pre_arm?: unknown } }).recording;
    return tuning?.pre_arm !== false; // present-but-unset defaults on (model default)
  }, [recordingConfigQuery.data]);

  // Pause the engine while the tab is hidden (the recorder's TTL disarms an
  // abandoned session on its own); resume re-arms on the next visibility.
  const pageVisible = useSyncExternalStore(
    (notify) => {
      document.addEventListener('visibilitychange', notify);
      return () => document.removeEventListener('visibilitychange', notify);
    },
    () => document.visibilityState === 'visible',
    () => true,
  );

  // Arm while the operator is between recordings on this screen: 'ready' (about
  // to start) and 'result' (labeling — the next start follows right after).
  // recorderState gates out recording/stopping (incl. takeover) AND the
  // pre-first-poll null, so we never prepare blind.
  const preArmed = recorderState === 'armed';
  const preArmEligible =
    preArmEnabled &&
    !noSelection &&
    takeoverCaptureId == null &&
    (state.phase === 'ready' || state.phase === 'result') &&
    // A fresh recorder reports `created`; there is no `idle` on the wire (§10).
    (preArmed ||
      recorderState === 'created' ||
      recorderState === 'completed' ||
      recorderState === 'failed' ||
      recorderState === 'interrupted');

  // operator/task ride along on prepare for completeness but are NOT part of
  // the armed-session match (metadata comes from the eventual start request),
  // so they are read via refs — typing in the operator field must not re-fire
  // prepares.
  const operatorRef = useRef(operator);
  operatorRef.current = operator;
  const taskRef = useRef(state.task);
  taskRef.current = state.task;

  const preArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preArmInFlightRef = useRef(false);
  // JSON key of the last selection we prepared with: a selection change while
  // armed must re-prepare now (the recorder swaps the mismatched session).
  const lastPreparedKeyRef = useRef<string | null>(null);
  const armingDisarmAt = arming?.disarm_at ?? null;

  useEffect(() => {
    if (!preArmEligible || !pageVisible) {
      if (preArmTimerRef.current) {
        clearTimeout(preArmTimerRef.current);
        preArmTimerRef.current = null;
      }
      return;
    }
    let cancelled = false;
    const topicsKey = JSON.stringify(selection.topics);

    const schedule = (ms: number) => {
      if (preArmTimerRef.current) clearTimeout(preArmTimerRef.current);
      preArmTimerRef.current = setTimeout(fire, Math.max(ms, 1_000));
    };
    const fire = () => {
      if (cancelled || preArmInFlightRef.current) return;
      preArmInFlightRef.current = true;
      const body: RecordStartRequest = { topics: selection.topics };
      if (operatorRef.current.trim()) body.operator = operatorRef.current.trim();
      if (taskRef.current.trim()) body.task = taskRef.current.trim();
      apiPost<RecordPrepareResponse>('/record/prepare', body)
        .then(() => {
          lastPreparedKeyRef.current = topicsKey;
          // Reflect armed + the new disarm_at on the shared status query; the
          // effect re-runs off that data and schedules the next keep-alive.
          void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
        })
        .catch(() => {
          // Best-effort by design (e.g. 409 lost a race with a start, older
          // backend without /record/prepare): retry later, never surface.
          if (!cancelled) schedule(PREARM_RETRY_MS);
        })
        .finally(() => {
          preArmInFlightRef.current = false;
        });
    };

    if (!preArmed || lastPreparedKeyRef.current !== topicsKey) {
      fire();
    } else {
      // Armed and matching — extend shortly before the recorder's deadline.
      const deadlineMs = armingDisarmAt ? Date.parse(armingDisarmAt) : NaN;
      schedule(
        Number.isFinite(deadlineMs)
          ? deadlineMs - Date.now() - PREARM_KEEPALIVE_LEAD_MS
          : PREARM_RETRY_MS,
      );
    }
    return () => {
      cancelled = true;
      if (preArmTimerRef.current) {
        clearTimeout(preArmTimerRef.current);
        preArmTimerRef.current = null;
      }
    };
  }, [
    preArmEligible,
    pageVisible,
    preArmed,
    armingDisarmAt,
    selection.topics,
    queryClient,
  ]);

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
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(''), 2400);
  }, []);
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

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
  // A server batch is created lazily on the first recording of a batch (and
  // after "start next batch"), not eagerly, so merely opening Collect never
  // spawns empty batches. Recording never waits on it; the review save does
  // await it, because a batch_id that arrives after the save would leave the
  // capture ungrouped for good.
  const batchCreateRef = useRef<Promise<string | null> | null>(null);
  const ensureBatch = useCallback((): Promise<string | null> => {
    const s = getStoreSnapshot();
    if (s.batchId) return Promise.resolve(s.batchId);
    if (batchCreateRef.current) return batchCreateRef.current;
    const op = useUiStore.getState().recordOperator.trim();
    const pending = createBatch({
      project: s.project,
      task: s.task,
      condition: s.condition && s.condition !== '—' ? s.condition : undefined,
      operator: op || undefined,
      target_episodes: s.targetEpisodes,
    })
      .then((batch) => {
        dispatch({
          type: 'SET_BATCH',
          batchId: batch.batch_id,
          batchSeq: typeof batch.batch_seq === 'number' ? batch.batch_seq : null,
        });
        return batch.batch_id;
      })
      .catch(() => {
        // API unreachable. The review still saves — a capture carries its own
        // review (§8) — it just belongs to no batch, which the receipt says.
        return null;
      })
      .finally(() => {
        batchCreateRef.current = null;
      });
    batchCreateRef.current = pending;
    return pending;
  }, []);

  // Once-per-page-load reconcile with the server's active batch. Never on later
  // tab-switch remounts (module flag), and only while the machine is at rest, so
  // it can't disturb an in-progress recording. On failure the localStorage
  // restore already applied at store init stands.
  useEffect(() => {
    if (serverHydrated) return;
    serverHydrated = true;
    // One GET /batches serves both jobs: restore the newest *active* batch (server
    // truth over the localStorage fallback) AND predict the next batch number from
    // today's batches (the honest pre-state before any batch exists).
    const atRestPhase = (p: Phase) =>
      p === 'ready' || p === 'completed' || p === 'ended' || p === 'paused';
    listBatches()
      .then(async (resp) => {
        const items = resp.items ?? [];
        // The predicted pre-state is always safe to refresh from today's batches.
        setPredictedSeq(predictNextSeq(items));
        if (!atRestPhase(getStoreSnapshot().phase)) return;
        const active = items.find((b) => b.status === 'active') ?? null;
        if (active) {
          applyServerRestore(active);
          return;
        }
        // Server reports NO active batch. A local batch context here may be a
        // phantom left behind after the captures/batches were deleted
        // server-side (Apple P0). Confirm by checking the batch's captures still
        // exist, then discard the stale context so the hero counters never
        // report recordings that don't exist. We keep it on any /captures
        // failure (offline resilience) or when a capture still backs it.
        if (!hasLocalBatchContext(getStoreSnapshot())) return;
        let captures: Capture[];
        try {
          captures = (await listCaptures({ limit: 100 })).items;
        } catch {
          return; // /captures unreachable — keep the local context.
        }
        const after = getStoreSnapshot();
        if (
          atRestPhase(after.phase) &&
          hasLocalBatchContext(after) &&
          localBatchIsPhantom(after, captures)
        ) {
          clearLocalBatch();
        }
      })
      .catch(() => {
        /* API unreachable — keep the localStorage fallback; the pre-state falls
         *  back to "next #1" (predictedSeq stays null). */
      });
  }, []);

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
    mutationFn: (body: RecordStartRequest) => apiPost<Capture>('/record/start', body),
    onSuccess: (capture) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
      if (cancelledStartRef.current) {
        cancelledStartRef.current = false;
        // The operator already backed out locally. If the recorder actually
        // started server-side despite that, stop it now (best-effort) so it
        // doesn't keep running unnoticed.
        if (capture && capture.state !== 'failed') {
          void apiPost('/record/stop', {}).catch(() => {});
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
      const capture = await apiPost<Capture>('/record/stop', {});
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
      const after = await apiGet<RecordStatus>('/record/status');
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
    if (state.task.trim()) body.task = state.task.trim();
    startMutation.mutate(body);
  }, [
    state.phase,
    state.task,
    noSelection,
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

  // M2: Start and Stop occupy the SAME position — START_SUCCEEDED swaps the
  // ready card for the recording card — so the second half of a real
  // double-click lands on Stop. qa-ui measured the result: a start at T+0 and
  // its own stop at T+86ms, an 87ms bag that then had to be reviewed like a
  // real take.
  //
  // A minimum age is the whole guard. 86ms is nowhere near a second and no
  // deliberate take is that short, so the floor defeats the accident outright.
  //
  // Deliberately NOT also gated on the recorder acknowledging the capture: the
  // stop path already refuses a stop the recorder has not honoured (it stays in
  // SAVING while `live_capture_ids` still names the capture), so a second gate
  // here would add nothing except a window — up to a poll interval — in which
  // an operator cannot end a recording. That is a worse failure than the
  // accident being prevented, and B1 is exactly the case where the recorder
  // goes quiet mid-take.
  const stopBlockedReason: StopBlockedReason =
    state.phase === 'recording' && state.elapsedMs < stopFloorMs ? 'floor' : null;
  const canStop = state.phase === 'recording' && stopBlockedReason === null;

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

  // ---- recording elapsed timer ---------------------------------------------
  // A slow clock that runs ONLY while the recorder is silent, so the
  // "last known … Ns ago" figure keeps climbing while the elapsed timer is
  // frozen. One second is enough for a number read in seconds, and it stops
  // entirely once the recorder answers again.
  const [staleNowMs, setStaleNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (recorderReachable) return;
    setStaleNowMs(Date.now());
    const id = setInterval(() => setStaleNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [recorderReachable]);

  const recStartRef = useRef<number | null>(null);
  // The baseline belongs to the RECORDING, not to our connection: it is set
  // when the take begins and cleared when it ends. Re-deriving it whenever the
  // recorder's reachability changed restarted the clock at 00:00:00 the moment
  // an outage ended, presenting a brand-new elapsed time for a take that had
  // been running — or had already died — throughout.
  useEffect(() => {
    if (state.phase !== 'recording') {
      recStartRef.current = null;
      return;
    }
    if (recStartRef.current == null) recStartRef.current = Date.now();
  }, [state.phase]);

  useEffect(() => {
    if (state.phase !== 'recording') return;
    // B1: freeze the elapsed clock while the recorder is silent. An animating
    // timer is an active claim that a recording is progressing, and once the
    // poll fails we have no evidence of that — qa-ui watched it climb
    // 00:12 → 00:37 against a recorder that had been dead the whole time. The
    // last value stays on screen, labelled as last-known.
    if (!recorderReachable) return;
    const id = setInterval(() => {
      if (recStartRef.current == null) return;
      dispatch({ type: 'TICK', elapsedMs: Date.now() - recStartRef.current });
    }, 250);
    return () => clearInterval(id);
  }, [state.phase, recorderReachable]);

  // B1-recovery: the recorder is answering again, so everything the machine
  // believed through the outage is checkable — and a local `recording` phase is
  // a claim nothing on the server supports. If our capture is not in the live
  // set, the take ended while we could not see it. Resuming RECORDING on stale
  // client state alone is how a tab shows a fresh 00:00:00 timer for a
  // recording that no longer exists.
  const wasUnreachableRef = useRef(false);
  useEffect(() => {
    if (!recorderReachable) {
      wasUnreachableRef.current = true;
      return;
    }
    if (!wasUnreachableRef.current) return;
    const live = recordStatus.live;
    // Still cannot tell what is live — stay as we are rather than guessing.
    if (live === null) return;
    wasUnreachableRef.current = false;
    if (state.phase !== 'recording') return;
    const captureId = state.currentCaptureId;
    if (captureId && live.includes(captureId)) return; // genuinely still running
    dispatch({ type: 'RECORDING_INTERRUPTED' });
    showToast(
      'The recording ended while the recorder was unreachable — the take is ' +
        'listed below for labelling or discarding.',
    );
  }, [recorderReachable, recordStatus.live, state.phase, state.currentCaptureId, showToast]);

  // SAVING advances on the REAL stop event (stopMutation.onSuccess dispatches
  // SAVED). This secondary gate covers a tab-switch during saving: once the
  // recorder reports the current run finalised, advance even if the mutation's
  // callback was on an unmounted instance. A failed stop stays in SAVING (with
  // the Retry button) and never trips this (state is still 'recording' on the
  // recorder until a stop succeeds).
  useEffect(() => {
    if (state.phase !== 'saving') return;
    const forThisCapture =
      state.currentCaptureId == null || status?.capture_id === state.currentCaptureId;
    // `live_capture_ids` is the definitive answer to "is this still being
    // written" (§10). A capture still named there is not finalised whatever the
    // state field says, and advancing past it is the same mistake the stop
    // confirmation exists to prevent — reached by a different route.
    const stillLive =
      state.currentCaptureId != null &&
      liveCaptures?.includes(state.currentCaptureId) === true;
    if (status?.state === 'completed' && forThisCapture && !stillLive)
      dispatch({ type: 'SAVED' });
  }, [
    state.phase,
    state.currentCaptureId,
    status?.state,
    status?.capture_id,
    liveCaptures,
  ]);

  // QUICK CHECK reads the recorder's real integrity (already on /record/status);
  // advance as soon as it lands for this run, with a fallback so an older backend
  // that never classifies integrity can't strand the operator.
  useEffect(() => {
    if (state.phase !== 'quickcheck') return;
    if (integrity != null) {
      dispatch({ type: 'QUICK_CHECK_DONE' });
      return;
    }
    const id = setTimeout(
      () => dispatch({ type: 'QUICK_CHECK_DONE' }),
      QUICKCHECK_FALLBACK_MS,
    );
    return () => clearTimeout(id);
  }, [state.phase, integrity]);

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
          review_status: collectReviewStatus(override),
          batch_id: batchId,
          // An index inside no batch means nothing, so it is only sent with one.
          index_in_batch: batchId ? nextIndex : null,
        };
        if (override != null) {
          body.quality = SERVER_QUALITY[override];
          body.quality_source = 'operator';
        }
        await saveReview(captureId, body);
        dispatch({ type: 'CONFIRM_EPISODE', quality: localQuality });
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
        flashSaved(nextIndex);
        const batchSeq = getStoreSnapshot().batchSeq;
        const seqPart = batchSeq != null ? ` of Batch ${batchSeq}` : '';
        showToast(
          batchId
            ? `Saved — Episode ${nextIndex}${seqPart}${op ? ` · ${op}` : ''}`
            : `Saved — Episode ${nextIndex}, not grouped into a set (no batch)`,
        );
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
      apiGet<{ available?: boolean }>('/transfer/status', { signal }),
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

  const openDiscardModal = useCallback(() => {
    const snapshot = getStoreSnapshot();
    if (snapshot.phase !== 'result') return;
    const captureId = snapshot.currentCaptureId;
    if (!captureId) {
      // Nothing was persisted for this take, so there is nothing to discard.
      // Re-record straight away rather than opening a dialog offering to delete
      // something that does not exist.
      dispatch({ type: 'RETRY_EPISODE' });
      showToast('Nothing was recorded for this take — re-record when ready');
      return;
    }
    // The recovery banner can be on screen at the same time; two discard dialogs
    // stacked on each other is two irreversible actions the operator cannot tell
    // apart, so opening one always closes the other.
    unsavedDiscard.cancel();
    // The dialog is obliged to state how many recordings and how many bytes are
    // going (§12), which only the capture itself can answer.
    void queryClient
      .fetchQuery({
        queryKey: queryKeys.capture(captureId),
        queryFn: ({ signal }: { signal: AbortSignal }) => getCapture(captureId, signal),
      })
      .then((capture) => episodeDiscard.requestDiscard(capture))
      .catch(() =>
        showToast("Couldn't load this recording — discard is unavailable right now"),
      );
  }, [queryClient, episodeDiscard, unsavedDiscard, showToast]);

  // ---- takeover stop (D-1) -------------------------------------------------
  // Stop a recording this screen isn't driving (another session, or a resumed
  // own). A confirmation modal guards against knocking over someone else's take;
  // the stop then joins the normal completion path (the stopped capture surfaces
  // as an unsaved take for labeling).
  const [takeoverStopModalOpen, setTakeoverStopModalOpen] = useState(false);
  const takeoverStopMutation = useMutation({
    mutationFn: () => apiPost<Capture>('/record/stop', {}),
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
    // Never two discard dialogs at once (see openDiscardModal).
    episodeDiscard.cancel();
    unsavedDiscard.requestDiscard(unsavedCapture);
  }, [unsavedCapture, episodeDiscard, unsavedDiscard]);
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
      void apiPost('/record/stop', {}).catch(() => {});
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
      void apiPost('/record/stop', {}).catch(() => {});
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

  const [batchMenuOpen, setBatchMenuOpen] = useState(false);
  const [projPickerOpen, setProjPickerOpen] = useState(false);
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [endModalOpen, setEndModalOpen] = useState(false);
  const [issueModalOpen, setIssueModalOpen] = useState(false);
  const [condModalOpen, setCondModalOpen] = useState(false);
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [targetModalOpen, setTargetModalOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [adviceIdx, setAdviceIdx] = useState(0);

  const toggleBatchMenu = useCallback(() => setBatchMenuOpen((v) => !v), []);
  const openProjPicker = useCallback(() => {
    if (!ctxEditable) return;
    setProjPickerOpen((v) => !v);
    setTaskPickerOpen(false);
    setBatchMenuOpen(false);
  }, [ctxEditable]);
  const openTaskPicker = useCallback(() => {
    if (!ctxEditable) return;
    setTaskPickerOpen((v) => !v);
    setProjPickerOpen(false);
    setBatchMenuOpen(false);
  }, [ctxEditable]);
  const openCondModal = useCallback(() => {
    if (!condAllowed) return;
    setCondModalOpen(true);
    setBatchMenuOpen(false);
  }, [condAllowed]);
  const openEndModal = useCallback(() => {
    setEndModalOpen(true);
    setBatchMenuOpen(false);
  }, []);
  const openIssueModal = useCallback(() => {
    setIssueModalOpen(true);
    setBatchMenuOpen(false);
  }, []);
  const openResetModal = useCallback(() => {
    setResetModalOpen(true);
    setBatchMenuOpen(false);
  }, []);
  const openTargetModal = useCallback(() => {
    setTargetModalOpen(true);
    setBatchMenuOpen(false);
  }, []);
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
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const closeModals = useCallback(() => {
    setEndModalOpen(false);
    setIssueModalOpen(false);
    setCondModalOpen(false);
    setResetModalOpen(false);
    setTargetModalOpen(false);
    setTakeoverStopModalOpen(false);
    setShortcutsOpen(false);
    // The two discard dialogs refuse to close mid-run on purpose: half the
    // targets may already be gone and hiding the dialog would hide which.
    episodeDiscard.cancel();
    unsavedDiscard.cancel();
  }, [episodeDiscard, unsavedDiscard]);
  const submitIssue = useCallback(() => {
    setIssueModalOpen(false);
    showToast('Issue logged with episode context');
  }, [showToast]);

  // A context change (project/task/condition) once the current set already holds
  // a recording rolls the set over: close the current one (server-side too, if
  // it's still active) and open a fresh set carrying the new context. Earlier
  // episodes keep their original context — condition lives per-batch server-side,
  // so relabeling in place would retroactively mislabel them. A set with nothing
  // recorded yet is updated in place instead (no empty set is ever minted).
  const rolloverSet = useCallback(
    (
      endedReason: string,
      changeLabel: string,
      next: { project: string; task: string; condition: string },
    ) => {
      // Only close a set that's still active server-side. A 'completed'/'ended'
      // set was already closed with its true terminal status (by confirmEpisode /
      // confirmEndBatch) — re-PATCHing would overwrite that; skip it. 'ready' and
      // 'paused' are the still-active at-rest phases.
      const stillActive =
        getStoreSnapshot().phase === 'ready' || getStoreSnapshot().phase === 'paused';
      const s = getStoreSnapshot();
      if (s.batchId && stillActive) {
        void patchBatch(s.batchId, {
          status: 'ended_early',
          ended_reason: endedReason,
        }).catch(() => {});
      }
      const oldSeq = s.batchSeq;
      dispatch({
        type: 'ROLLOVER_SET',
        project: next.project,
        task: next.task,
        condition: next.condition,
      });
      showToast(
        oldSeq != null
          ? `Set #${oldSeq} closed (${changeLabel}) — next recording starts a new set`
          : `Set closed (${changeLabel}) — next recording starts a new set`,
      );
    },
    [showToast],
  );

  const pickProject = useCallback(
    (name: string) => {
      const plan = findProject(getPlans(), name);
      const t0 = plan.tasks[0];
      const next = {
        project: plan.name,
        task: t0?.name ?? '—',
        condition: t0?.conditions[0] ?? '—',
      };
      setProjPickerOpen(false);
      if (getStoreSnapshot().recordedCount >= 1) {
        rolloverSet('Plan change', 'project changed', next);
        return;
      }
      dispatch({ type: 'SET_PROJECT', ...next });
      // An empty batch may already exist (e.g. after Start next set → ensureBatch).
      // Sync the relabel so later episodes don't drift from the operator's choice
      // in index.jsonl. A '—' (no) condition is omitted, matching the create path.
      if (state.batchId)
        void patchBatch(state.batchId, {
          project: next.project,
          task: next.task,
          condition: next.condition !== '—' ? next.condition : undefined,
        }).catch(() => {});
      showToast('Project switched — plan reloaded');
    },
    [state.batchId, rolloverSet, showToast],
  );
  const pickTask = useCallback(
    (name: string) => {
      const t = findTask(getPlans(), state.project, name);
      const next = {
        project: state.project,
        task: t?.name ?? '—',
        condition: t?.conditions[0] ?? '—',
      };
      setTaskPickerOpen(false);
      if (getStoreSnapshot().recordedCount >= 1) {
        rolloverSet('Task change', 'task changed', next);
        return;
      }
      dispatch({ type: 'SET_TASK', task: next.task, condition: next.condition });
      // Sync the relabel onto an already-created empty batch (see pickProject).
      if (state.batchId)
        void patchBatch(state.batchId, {
          task: next.task,
          condition: next.condition !== '—' ? next.condition : undefined,
        }).catch(() => {});
      showToast('Task switched');
    },
    [state.project, state.batchId, rolloverSet, showToast],
  );
  const pickCustomTask = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      // A free-text task has no plan-defined conditions; clear the condition to
      // '—' so a stale plan condition can't ride along with an unrelated task.
      setTaskPickerOpen(false);
      if (getStoreSnapshot().recordedCount >= 1) {
        rolloverSet('Task change', 'task changed', {
          project: state.project,
          task: trimmed,
          condition: '—',
        });
        return;
      }
      dispatch({ type: 'SET_TASK', task: trimmed, condition: '—' });
      // Sync the task onto an already-created empty batch. A free-text task has
      // no plan condition ('—'), so only the task is sent — the batch keeps any
      // prior condition (PATCH can't clear it to null; a minor residual).
      if (state.batchId)
        void patchBatch(state.batchId, { task: trimmed }).catch(() => {});
      showToast('Custom task set');
    },
    [state.project, state.batchId, rolloverSet, showToast],
  );
  const pickCondition = useCallback(
    (condition: string) => {
      setCondModalOpen(false);
      if (getStoreSnapshot().recordedCount >= 1) {
        rolloverSet('Condition change', 'condition changed', {
          project: state.project,
          task: state.task,
          condition,
        });
        return;
      }
      dispatch({ type: 'SET_CONDITION', condition });
      // Persist the condition change on the current server batch (best-effort).
      if (state.batchId) void patchBatch(state.batchId, { condition }).catch(() => {});
      showToast('Condition updated');
    },
    [state.project, state.task, state.batchId, rolloverSet, showToast],
  );
  const pickCustomCondition = useCallback(
    (condition: string) => {
      const trimmed = condition.trim();
      if (!trimmed) return;
      setCondModalOpen(false);
      if (getStoreSnapshot().recordedCount >= 1) {
        rolloverSet('Condition change', 'condition changed', {
          project: state.project,
          task: state.task,
          condition: trimmed,
        });
        return;
      }
      dispatch({ type: 'SET_CONDITION', condition: trimmed });
      // A free-text condition is just a string on the batch — persist it in place
      // the same way a catalog pick does (best-effort); never added to the plan.
      if (state.batchId)
        void patchBatch(state.batchId, { condition: trimmed }).catch(() => {});
      showToast('Condition updated');
    },
    [state.project, state.task, state.batchId, rolloverSet, showToast],
  );

  const advicePrev = useCallback(
    () => setAdviceIdx((i) => (i - 1 + ADVICE_ITEMS.length) % ADVICE_ITEMS.length),
    [],
  );
  const adviceNext = useCallback(
    () => setAdviceIdx((i) => (i + 1) % ADVICE_ITEMS.length),
    [],
  );

  // ---- keyboard shortcut layer (D-4) ---------------------------------------
  // R/S/Space/Esc/? on the window, ignored while typing or when an overlay is
  // open (modals own their own keys, e.g. Esc-to-close). Enter is deliberately
  // NOT bound — focus management keeps the primary button focused so the native
  // button handles it.
  const anyOverlayOpen =
    endModalOpen ||
    issueModalOpen ||
    condModalOpen ||
    resetModalOpen ||
    targetModalOpen ||
    episodeDiscard.kind != null ||
    unsavedDiscard.kind != null ||
    takeoverStopModalOpen ||
    shortcutsOpen ||
    projPickerOpen ||
    taskPickerOpen ||
    batchMenuOpen;
  // R-to-start must not fire into a takeover (would 409); read it via a ref so
  // the listener stays stable.
  const takeoverActiveRef = useRef(false);
  takeoverActiveRef.current = !!takeover;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const typing =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (t?.isContentEditable ?? false);
      if (typing) return;
      // While an overlay is open, only let it handle its own keys.
      if (anyOverlayOpen) return;
      const phase = getStoreSnapshot().phase;
      if (e.key === 'r' || e.key === 'R') {
        if (phase === 'ready' && !takeoverActiveRef.current) {
          e.preventDefault();
          startRecording();
        }
      } else if (
        e.key === 's' ||
        e.key === 'S' ||
        e.key === ' ' ||
        e.key === 'Spacebar'
      ) {
        if (phase === 'recording') {
          e.preventDefault();
          stopRecording();
        }
      } else if (e.key === 'Escape') {
        if (phase === 'arming') {
          e.preventDefault();
          cancelArming();
        }
      } else if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anyOverlayOpen, startRecording, stopRecording, cancelArming]);

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

    project: state.project,
    task: state.task,
    condition: state.condition,
    targetEpisodes: state.targetEpisodes,
    ctxEditable,
    condAllowed,
    endReason: state.endReason,

    batchMenuOpen,
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
    recorderStaleMs:
      !recorderReachable && recordStatus.lastGoodAt != null
        ? Math.max(0, staleNowMs - recordStatus.lastGoodAt)
        : null,
    retryStop,
    pickSuccess,
    pickFailure,
    pickFailReason,
    confirmEpisode,
    isSavingReview,
    saveError,
    dismissSaveError,
    openDiscardModal,
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
