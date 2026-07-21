// Collect screen state machine: batch -> episode -> phase, all local to the
// frontend (the backend has no Session/Batch/Episode model yet — that's Phase
// 2). The recording itself is real: startRecording()/stopRecording() call the
// orchestrator's /record/start and /record/stop (same contract LiveTab uses).
// The saving/quick-check transitions are gated on REAL recorder events (the
// stop mutation resolving and the /record/status integrity landing), not fixed
// demo timers — so the operator never advances past a stop that hasn't finished.
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
import { ApiError, apiDelete, apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { errorText } from '../../components/ErrorMessage';
import { useUiStore } from '../../store/uiStore';
import {
  createBatch,
  getEpisodeOutcome,
  listBatches,
  patchBatch,
  removeEpisodeOutcome,
  saveEpisodeOutcome,
} from '../episodeBridge';
import { findProject, findTask, getPlans } from '../plans';
import { RECORDING_CONFIG_KEY } from '../../features/config/ConfigTab';
import type {
  BatchEpisodeSummary,
  BatchSummary,
  Episode,
  EpisodeCreateRequest,
  EpisodeQuality,
  EpisodeQualitySource,
  Page,
  QuickCheckVerdict,
  RecordArming,
  RecordIntegrity,
  RecordPrepareResponse,
  RecordStartRequest,
  RecordStatus,
  RecordingConfigPayload,
  RunDetail,
  RunState,
  RunSummary,
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

export interface EpisodeRecord {
  index: number;
  /** Recording/data quality — independent of whether the task succeeded. */
  quality: Quality;
  /** Whether the demonstrated task succeeded — independent of data quality. */
  taskResult: TaskResult;
  /** The run_id returned by /record/start for this episode's capture, if any. */
  runId?: string;
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
  currentRunId: string | null;
  /** The last run this browser started (durable) — lets takeover detection tell
   *  a resumed-own recording from one another session started. */
  lastRunId: string | null;
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
    currentRunId: null,
    lastRunId: null,
    project: firstPlan?.name ?? '—',
    task: firstTask?.name ?? '—',
    condition: firstTask?.conditions[0] ?? '—',
    endReason: '',
  };
}

type Action =
  | { type: 'START_REQUESTED' }
  | { type: 'START_FAILED'; error: MachineError }
  | { type: 'START_SUCCEEDED'; runId: string | null }
  | { type: 'CANCEL_ARMING' }
  | { type: 'TICK'; elapsedMs: number }
  | { type: 'STOP_REQUESTED' }
  | { type: 'STOP_FAILED'; error: MachineError }
  | { type: 'RETRY_STOP' }
  | { type: 'SAVED' }
  | { type: 'QUICK_CHECK_DONE' }
  | { type: 'PICK_RESULT'; result: 'ok' | 'fail' }
  | { type: 'PICK_FAIL_REASON'; reason: string }
  | { type: 'SET_QUALITY'; quality: QualityOverride | null }
  | { type: 'CONFIRM_EPISODE'; quality: Quality }
  | { type: 'ADOPT_EPISODE_INDEX'; runId: string; index: number }
  | { type: 'SET_TARGET'; target: number }
  | { type: 'RESUME_TAKE'; runId: string }
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
        currentRunId: action.runId,
        // Remember the run we started (durable) for resumed-own takeover detection.
        lastRunId: action.runId ?? state.lastRunId,
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
        runId: state.currentRunId ?? undefined,
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
        currentRunId: null,
      };
    }
    case 'ADOPT_EPISODE_INDEX': {
      // The server may re-allocate index_in_batch on a save collision (another
      // terminal took the number first). Adopt the returned value so the strip
      // chip sits on its true slot instead of drifting one off after a restore.
      let changed = false;
      const episodes = state.episodes.map((e) => {
        if (e.runId === action.runId && e.index !== action.index) {
          changed = true;
          return { ...e, index: action.index };
        }
        return e;
      });
      if (!changed) return state;
      return {
        ...state,
        episodes,
        recordedCount: Math.max(state.recordedCount, action.index),
      };
    }
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
      // the given run so the operator can label it. Success is pre-selected;
      // quality falls back to auto (no override) until the operator changes it.
      return {
        ...state,
        phase: 'result',
        currentRunId: action.runId,
        pendingTask: 'ok',
        failReason: '',
        qualityOverride: null,
        elapsedMs: 0,
        startError: null,
        stopError: null,
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
        currentRunId: null,
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
        currentRunId: null,
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
        currentRunId: null,
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
      // A context change (project/task/condition) once this set already holds a
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
        currentRunId: null,
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
  /** Last run this browser started — durable so a reload can still recognise a
   *  recording it started as "resumed own" rather than another session's. */
  lastRunId: string | null;
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
    lastRunId: state.lastRunId,
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
      lastRunId: typeof blob.lastRunId === 'string' ? blob.lastRunId : null,
    };
  } catch {
    return base;
  }
}

let currentState: MachineState = readInitialState();
const storeListeners = new Set<() => void>();

// Runs the operator has dismissed ("Later") from the unsaved-take banner. Module
// scope so a tab-switch remount keeps them hidden; cleared on a full page load
// (a fresh module) so the banner re-offers them next session — matching the
// "hide until next page load" contract in the design.
const dismissedUnsavedRuns = new Set<string>();

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

/** Map a server batch's episode summary to the local display record. */
function serverEpisodeToRecord(ep: BatchEpisodeSummary): EpisodeRecord {
  return {
    index: ep.index,
    // Collect's live quality axis is good | review; a server 'not_usable'
    // (e.g. a Review exclude) has no Collect equivalent, so it shows as review.
    quality: ep.quality === 'good' ? 'good' : 'review',
    taskResult: ep.task_result === 'failure' ? 'fail' : 'ok',
    runId: ep.run_id,
  };
}

/** Adopt the server's active batch as the durable context. When the server
 *  reports none we deliberately leave local state alone (a no-op) rather than
 *  clobber it — the local blob may hold a just-finished batch or an episode that
 *  only reached the browser bridge while the API was down; either self-heals on
 *  the next recording. Volatile phase stays at rest. */
function applyServerRestore(batch: BatchSummary | null): void {
  if (!batch) return;
  const serverEpisodes = batch.episodes.map(serverEpisodeToRecord);
  // Same batch as the local blob? Then local episodes the server does NOT have
  // (a save that only reached the browser bridge while the API was down, or a
  // POST that hadn't landed yet) must survive the restore — replacing the list
  // wholesale flipped a just-saved chip back to "not recorded". A record whose
  // slot the server has since given to another episode can't be placed honestly
  // and is dropped (the monotone count still includes it).
  const sameBatch = currentState.batchId === batch.batch_id;
  let episodes = serverEpisodes;
  if (sameBatch) {
    const serverRunIds = new Set(
      serverEpisodes
        .map((e) => e.runId)
        .filter((id): id is string => typeof id === 'string'),
    );
    const usedIndexes = new Set(serverEpisodes.map((e) => e.index));
    const localOnly = currentState.episodes.filter(
      (e) => (!e.runId || !serverRunIds.has(e.runId)) && !usedIndexes.has(e.index),
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
    // Preserve the durable last-run pointer so a resumed-own takeover is still
    // recognised after a server restore (which otherwise resets to a fresh state).
    lastRunId: currentState.lastRunId,
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

/** True when a local batch context can't be backed by any server run — a
 *  phantom left behind after the runs/batches were deleted server-side (Apple
 *  P0: an operator wipes runs, then the next load shows "Batch 6 · 3 recorded"
 *  that no longer exists). Only reports phantom on POSITIVE evidence of absence:
 *  a bridge-only episode whose run still exists is preserved (self-heals). */
function localBatchIsPhantom(s: MachineState, runs: RunSummary[]): boolean {
  const serverRunIds = new Set(runs.map((r) => r.run_id));
  const localRunIds = s.episodes
    .map((e) => e.runId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (localRunIds.length > 0) {
    // Every recorded episode's run is gone from the server → phantom. If even
    // one survives (e.g. an episode that only reached the browser bridge), keep.
    return localRunIds.every((id) => !serverRunIds.has(id));
  }
  // No run ids to check (an older blob, or counts without episodes): phantom
  // only when the server has NO runs at all — otherwise we can't prove the
  // local batch is stale, so we keep it (offline/older-backend resilience).
  return runs.length === 0;
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
  dismissedUnsavedRuns.clear();
  try {
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
  /** Finalised/live bag size for the current run (formatBytes it; null → "—"). */
  recordingBytes: number | null;
  /** The recorder's SERVER state (from /record/status), the single source the
   *  SYSTEM STATUS Recorder row and the takeover card both read — so the two can
   *  never contradict. Null before the first poll. */
  recorderState: RunState | 'idle' | null;
  /** True while the recorder holds a pre-armed (two-phase prepare) session:
   *  the next matching Start is a near-instant resume. Server-reported, never
   *  assumed from having sent a prepare. */
  preArmed: boolean;

  // Takeover (D-1): a recording is running server-side that this screen is not
  // driving (another tab/session, or a reload of our own). Null in the normal
  // case; when set, ControlCard shows the takeover card instead of a phase card.
  takeover: {
    runId: string;
    startedAt: string | null;
    bytes: number | null;
    /** Topic count from the run detail (RecordStatus has no topic list); null until loaded. */
    topicsCount: number | null;
    /** Operator from the run detail; null when absent (never fabricated). */
    operator: string | null;
  } | null;
  /** True when the takeover run is one this browser started (resumed own). */
  takeoverResumedOwn: boolean;
  takeoverStopModalOpen: boolean;
  openTakeoverStopModal: () => void;
  confirmTakeoverStop: () => void;
  isTakeoverStopping: boolean;

  // Unsaved take recovery (D-3): a completed run with no episode label, offered
  // for recovery after a reload between Stop and Save. Null when none.
  unsavedTake: {
    runId: string;
    startedAt: string | null;
    bytes: number | null;
    durationMs: number | null;
  } | null;
  /** Open the result panel for the unsaved take to label it. */
  labelUnsavedTake: () => void;
  /** Open the discard-confirmation for the unsaved take. */
  discardUnsavedTake: () => void;
  /** Confirm discarding the unsaved take (real DELETE /runs/{id}). */
  confirmDiscardUnsavedTake: () => void;
  /** Hide the unsaved-take banner until the next page load. */
  dismissUnsavedTake: () => void;
  unsavedDiscardModalOpen: boolean;
  isDiscardingUnsaved: boolean;

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

  // Discard-episode confirmation (real DELETE /runs/{id} — v1 LiveTab parity).
  discardModalOpen: boolean;
  /** run_id of the just-stopped episode that Discard would delete (null when
   *  the capture had no persisted run). */
  discardRunId: string | null;
  /** Finalised size of that run (from /record/status), for the modal. */
  discardRunBytes: number | null;
  /** DELETE error text, kept on the open modal so the episode is preserved. */
  discardError: string | null;
  isDiscarding: boolean;

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
  /** Re-attempt a stop that failed (stays in SAVING). */
  retryStop: () => void;
  pickSuccess: () => void;
  pickFailure: () => void;
  pickFailReason: (reason: string) => void;
  confirmEpisode: () => void;
  /** Open the Discard confirmation modal (was a silent local reset). */
  openDiscardModal: () => void;
  /** Confirm Discard: DELETE the run, then proceed to the re-record flow. */
  confirmDiscard: () => void;
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
   *  afterwards (a string on the batch). Rolls the set over when the current set
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

// The Collect episode-save payload. The shared `EpisodeCreateRequest` marks
// `quality` required, but F1 OMITS it (and `quality_source`) when the operator
// did not override, so the server derives the auto quality from the run's
// settled quick_check verdict. Kept feature-local — the shared api/types is
// off-limits to this change (and the backend already accepts an absent quality).
type CollectEpisodePayload = Omit<
  EpisodeCreateRequest,
  'quality' | 'quality_source'
> & {
  quality?: EpisodeQuality;
  quality_source?: EpisodeQualitySource;
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
  const statusQuery = useQuery({
    queryKey: queryKeys.recordStatus,
    queryFn: ({ signal }) => apiGet<RecordStatus>('/record/status', { signal }),
    refetchInterval: 5000,
  });
  const status = statusQuery.data;
  const arming: RecordArming | null = status?.arming ?? null;
  // Gate integrity to THIS episode's run so a previous run's `dropped`/`failed`
  // can't leak into the current episode's result while the poll catches up.
  const runMatches =
    state.currentRunId == null || (status?.run_id ?? null) === state.currentRunId;
  const integrity: RecordIntegrity | null = runMatches
    ? (status?.integrity ?? null)
    : null;
  const droppedMessages: number | null = runMatches
    ? (status?.dropped_messages ?? null)
    : null;
  // Finalised/live bag size for the current run (the Discard modal + the
  // recording card's real "MB written", replacing a fabricated elapsed×rate).
  const currentRunBytes: number | null = runMatches ? (status?.bytes ?? null) : null;
  // The recorder's SERVER state — the one source the SYSTEM STATUS Recorder row
  // and the takeover card both read (D-1), so they can never disagree.
  const recorderState: RunState | 'idle' | null = status?.state ?? null;

  // ---- settled quick-check verdict (F1) ------------------------------------
  // After stop the orchestrator settles a quick_check verdict on the run
  // (good/needs_review + human-readable reasons). While the operator is on the
  // result panel, poll the run detail gently so the panel shows the SERVER's
  // verdict — the same value the server derives on save — instead of a client
  // re-derivation. Bounded to ~3 fetches (~5s): settlement is sub-second in
  // practice, and saving is never blocked on it (the operator may save before
  // it lands; the server corrects a quick_check-sourced episode when it does).
  const resultRunId =
    state.phase === 'result' && state.currentRunId ? state.currentRunId : null;
  const resultRunQuery = useQuery({
    queryKey: queryKeys.run(resultRunId ?? ''),
    queryFn: ({ signal }) =>
      apiGet<RunDetail>(`/runs/${encodeURIComponent(resultRunId ?? '')}`, { signal }),
    enabled: !!resultRunId,
    refetchInterval: (query) => {
      if (query.state.data?.quick_check?.verdict) return false; // settled -> stop
      if (query.state.dataUpdateCount >= 3) return false; // bounded backstop
      return 2000;
    },
  });
  const settledVerdict: QuickCheckVerdict | null = resultRunId
    ? (resultRunQuery.data?.quick_check?.verdict ?? null)
    : null;
  // True while the operator is on the result panel and the verdict has not
  // settled yet — drives an honest "Quick check running…" note, never a value.
  const quickCheckPending = !!resultRunId && settledVerdict == null;

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
  // tab/session started it, or this is a reload of our own). We treat it as a
  // takeover whenever the server reports 'recording' but our local phase isn't
  // in an active-recording state.
  const localActive =
    state.phase === 'arming' ||
    state.phase === 'recording' ||
    state.phase === 'saving' ||
    state.phase === 'quickcheck';
  const takeoverRunId =
    recorderState === 'recording' && !localActive ? (status?.run_id ?? null) : null;
  // The run detail supplies the operator + topic count (RecordStatus carries
  // neither); only fetched while a takeover is showing.
  const takeoverDetailQuery = useQuery({
    queryKey: queryKeys.run(takeoverRunId ?? ''),
    queryFn: ({ signal }) =>
      apiGet<RunDetail>(`/runs/${encodeURIComponent(takeoverRunId ?? '')}`, { signal }),
    enabled: !!takeoverRunId,
  });
  const takeover = takeoverRunId
    ? {
        runId: takeoverRunId,
        startedAt: status?.started_at ?? null,
        bytes: status?.bytes ?? null,
        topicsCount: takeoverDetailQuery.data?.topics?.length ?? null,
        operator: takeoverDetailQuery.data?.operator ?? null,
      }
    : null;
  const takeoverResumedOwn = !!takeover && takeover.runId === state.lastRunId;

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
    takeoverRunId == null &&
    (state.phase === 'ready' || state.phase === 'result') &&
    (preArmed ||
      recorderState === 'idle' ||
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
  // A completed run with no episode label, recent, and not the run we're already
  // labeling, is a take the operator stopped but never saved (e.g. a reload
  // between Stop and Save). Offer it for recovery. Shares the ['runs'] cache
  // prefix so a save/discard invalidation refreshes it.
  const runsScanQuery = useQuery({
    queryKey: queryKeys.runs('collect-scan'),
    queryFn: ({ signal }) =>
      apiGet<Page<RunSummary>>('/runs', { signal, query: { limit: 10 } }),
    refetchInterval: 15000,
  });
  // A bump to recompute the (module-set-backed) dismissed filter without state.
  const [dismissNonce, setDismissNonce] = useState(0);
  const unsavedTake = useMemo(() => {
    void dismissNonce; // recompute when a take is dismissed
    const items = runsScanQuery.data?.items ?? [];
    const now = Date.now();
    for (const run of items) {
      if (run.state !== 'completed') continue;
      if (run.episode) continue;
      if (!run.started_at) continue;
      const startedMs = Date.parse(run.started_at);
      if (Number.isNaN(startedMs) || now - startedMs > UNSAVED_MAX_AGE_MS) continue;
      if (run.run_id === state.currentRunId) continue;
      if (dismissedUnsavedRuns.has(run.run_id)) continue;
      if (getEpisodeOutcome(run.run_id)) continue;
      const bytes =
        status?.run_id === run.run_id && typeof status?.bytes === 'number'
          ? status.bytes
          : null;
      const endedMs = run.ended_at ? Date.parse(run.ended_at) : NaN;
      const durationMs =
        run.duration_ms ??
        (Number.isNaN(endedMs) ? null : Math.max(0, endedMs - startedMs));
      return { runId: run.run_id, startedAt: run.started_at, bytes, durationMs };
    }
    return null;
  }, [
    runsScanQuery.data,
    state.currentRunId,
    status?.run_id,
    status?.bytes,
    dismissNonce,
  ]);

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

  // ---- Phase 2 batch lifecycle (server API) --------------------------------
  // A server batch is created lazily on the first recording of a batch (and
  // after "start next batch"), not eagerly, so merely opening Collect never
  // spawns empty batches. Recording never waits on it: if the create fails the
  // recording still proceeds and the episode save falls back to the bridge.
  const batchCreateInFlight = useRef(false);
  const ensureBatch = useCallback(() => {
    const s = getStoreSnapshot();
    if (s.batchId || batchCreateInFlight.current) return;
    batchCreateInFlight.current = true;
    const op = useUiStore.getState().recordOperator.trim();
    createBatch({
      project: s.project,
      task: s.task,
      condition: s.condition && s.condition !== '—' ? s.condition : undefined,
      operator: op || undefined,
      target_episodes: getStoreSnapshot().targetEpisodes,
    })
      .then((batch) =>
        dispatch({
          type: 'SET_BATCH',
          batchId: batch.batch_id,
          batchSeq: typeof batch.batch_seq === 'number' ? batch.batch_seq : null,
        }),
      )
      .catch(() => {
        // API unreachable — the episode save will fall back to the bridge.
      })
      .finally(() => {
        batchCreateInFlight.current = false;
      });
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
        // phantom left behind after the runs/batches were deleted server-side
        // (Apple P0). Confirm by checking the batch's runs still exist, then
        // discard the stale context so the hero counters never report
        // recordings that don't exist. We keep it on any /runs failure (offline
        // resilience) or when a run still backs it (bridge-only episode).
        if (!hasLocalBatchContext(getStoreSnapshot())) return;
        let runs: Page<RunSummary>;
        try {
          runs = await apiGet<Page<RunSummary>>('/runs', { query: { limit: 100 } });
        } catch {
          return; // /runs unreachable — keep the local context.
        }
        const after = getStoreSnapshot();
        if (
          atRestPhase(after.phase) &&
          hasLocalBatchContext(after) &&
          localBatchIsPhantom(after, runs.items ?? [])
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

  const startMutation = useMutation({
    mutationFn: (body: RecordStartRequest) => apiPost<RunDetail>('/record/start', body),
    onSuccess: (run) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
      if (cancelledStartRef.current) {
        cancelledStartRef.current = false;
        // The operator already backed out locally. If the recorder actually
        // started server-side despite that, stop it now (best-effort) so it
        // doesn't keep running unnoticed.
        if (run && run.state !== 'failed') {
          void apiPost('/record/stop', {}).catch(() => {});
        }
        return;
      }
      if (!run || run.state === 'failed') {
        dispatch({
          type: 'START_FAILED',
          error: run?.error
            ? { code: run.error.code, message: run.error.message }
            : { code: null, message: 'the recorder rejected the start' },
        });
        return;
      }
      dispatch({ type: 'START_SUCCEEDED', runId: run.run_id });
    },
    onError: (err) => {
      if (cancelledStartRef.current) {
        cancelledStartRef.current = false;
        return;
      }
      dispatch({ type: 'START_FAILED', error: toMachineError(err) });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => apiPost<RunDetail>('/record/stop', {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
      // The stop returned the finalised run: advance SAVING → QUICK CHECK on the
      // real event, and refresh the runs cache (the just-stopped run is now
      // completed — feeds the unsaved-take scan if the operator navigates away).
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      dispatch({ type: 'SAVED' });
    },
    onError: (err) => {
      dispatch({ type: 'STOP_FAILED', error: toMachineError(err) });
    },
  });

  const startRecording = useCallback(() => {
    if (state.phase !== 'ready' || noSelection) return;
    cancelledStartRef.current = false;
    // Lazily create the server batch (best-effort, never blocks the recording).
    ensureBatch();
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

  const stopRecording = useCallback(() => {
    if (state.phase !== 'recording') return;
    dispatch({ type: 'STOP_REQUESTED' });
    stopMutation.mutate();
  }, [state.phase, stopMutation]);

  const retryStop = useCallback(() => {
    if (getStoreSnapshot().phase !== 'saving') return;
    dispatch({ type: 'RETRY_STOP' });
    stopMutation.mutate();
  }, [stopMutation]);

  // ---- recording elapsed timer ---------------------------------------------
  const recStartRef = useRef<number | null>(null);
  useEffect(() => {
    if (state.phase !== 'recording') return;
    recStartRef.current = Date.now();
    const id = setInterval(() => {
      if (recStartRef.current == null) return;
      dispatch({ type: 'TICK', elapsedMs: Date.now() - recStartRef.current });
    }, 250);
    return () => clearInterval(id);
  }, [state.phase]);

  // SAVING advances on the REAL stop event (stopMutation.onSuccess dispatches
  // SAVED). This secondary gate covers a tab-switch during saving: once the
  // recorder reports the current run finalised, advance even if the mutation's
  // callback was on an unmounted instance. A failed stop stays in SAVING (with
  // the Retry button) and never trips this (state is still 'recording' on the
  // recorder until a stop succeeds).
  useEffect(() => {
    if (state.phase !== 'saving') return;
    const forThisRun =
      state.currentRunId == null || status?.run_id === state.currentRunId;
    if (status?.state === 'completed' && forThisRun) dispatch({ type: 'SAVED' });
  }, [state.phase, state.currentRunId, status?.state, status?.run_id]);

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

  const confirmEpisode = useCallback(() => {
    if (state.phase !== 'result' || !state.pendingTask) return;
    if (state.pendingTask === 'fail' && !state.failReason) return;
    // Monotone: the new episode's number follows the recorded count, so a prior
    // Review delete never causes a reused index_in_batch on the server.
    const nextIndex = state.recordedCount + 1;
    const willComplete = nextIndex >= state.targetEpisodes;
    const isFail = state.pendingTask === 'fail';
    const reason = state.failReason;
    // Quality (D-2 / F1): the operator's override if any, else the auto value.
    // `effective`/`localQuality` drive the LOCAL strip chip + the offline bridge
    // fallback. The SERVER payload sends an explicit quality ONLY on an override
    // (provenance 'operator'); with no override it is OMITTED below so the server
    // derives it from the run's settled quick_check verdict — the single source
    // of the auto quality, correct even when saved before the verdict settles.
    // 'notusable' has no local axis (maps to 'review').
    const override = state.qualityOverride;
    const effective: QualityOverride = override ?? autoQuality;
    const localQuality: Quality = effective === 'good' ? 'good' : 'review';
    const overrideServerQuality: EpisodeQuality | null =
      override == null
        ? null
        : override === 'good'
          ? 'good'
          : override === 'review'
            ? 'needs_review'
            : 'not_usable';
    const runId = state.currentRunId;
    const batchId = state.batchId;
    // The bridge fallback (used only when the episode POST fails) keeps a local
    // grouping number; use the server batch_seq when known, else a safe 1.
    const bridgeBatchNum = state.batchSeq ?? 1;
    const batchSeqForReceipt = state.batchSeq;
    const op = operator.trim();
    // The save receipt: prefer the SERVER-returned index_in_batch (the backend
    // may re-allocate it); falls back to the local next index otherwise.
    const receipt = (index: number) => {
      flashSaved(index);
      const seqPart =
        batchSeqForReceipt != null ? ` of Set ${batchSeqForReceipt}` : '';
      showToast(`Saved — Episode ${index}${seqPart}${op ? ` · ${op}` : ''}`);
    };
    dispatch({ type: 'CONFIRM_EPISODE', quality: localQuality });

    // Persist the episode to the server (Phase 2). On any failure keep the local
    // save and fall back to the browser bridge, so Review still shows it, and
    // tell the operator it didn't reach the server (honesty).
    if (runId) {
      const bridgeFallback = () => {
        saveEpisodeOutcome(runId, {
          quality: localQuality,
          taskResult: isFail ? 'fail' : 'ok',
          failReason: isFail ? reason || undefined : undefined,
          batchNum: bridgeBatchNum,
          episodeIndex: nextIndex,
          savedAt: Date.now(),
        });
        showToast(`Episode ${nextIndex} saved locally — couldn't reach the server`);
      };
      if (batchId) {
        const body: CollectEpisodePayload = {
          batch_id: batchId,
          run_id: runId,
          index_in_batch: nextIndex,
          task_result: isFail ? 'failure' : 'success',
        };
        // Explicit override -> send it with operator provenance. No override ->
        // omit quality/quality_source so the server derives from quick_check.
        if (overrideServerQuality != null) {
          body.quality = overrideServerQuality;
          body.quality_source = 'operator';
        }
        if (isFail && reason) body.failure_reason = reason;
        apiPost<Episode>('/episodes', body)
          .then((ep) => {
            if (willComplete)
              void patchBatch(batchId, { status: 'completed' }).catch(() => {});
            // The server may have re-allocated the index (UNIQUE collision with
            // another terminal) — adopt it so the strip chip sits on the true slot.
            if (
              typeof ep.index_in_batch === 'number' &&
              ep.index_in_batch !== nextIndex
            ) {
              dispatch({
                type: 'ADOPT_EPISODE_INDEX',
                runId,
                index: ep.index_in_batch,
              });
            }
            receipt(
              typeof ep.index_in_batch === 'number' ? ep.index_in_batch : nextIndex,
            );
            // The just-saved run now has an episode — refresh the unsaved-take scan.
            void queryClient.invalidateQueries({ queryKey: ['runs'] });
          })
          .catch((err) => {
            // 409 = the run already has an episode (already saved) — not a failure.
            if (err instanceof ApiError && err.status === 409) {
              receipt(nextIndex);
              return;
            }
            bridgeFallback();
          });
      } else {
        // No server batch (create failed / API down) — bridge only.
        bridgeFallback();
      }
    } else {
      // No run to attach (capture returned no run_id) — a purely local strip
      // entry; still mark a completed batch done and give a receipt.
      if (willComplete && batchId)
        void patchBatch(batchId, { status: 'completed' }).catch(() => {});
      receipt(nextIndex);
    }
  }, [
    state.phase,
    state.pendingTask,
    state.failReason,
    state.qualityOverride,
    state.recordedCount,
    state.targetEpisodes,
    state.currentRunId,
    state.batchId,
    state.batchSeq,
    autoQuality,
    operator,
    showToast,
    flashSaved,
    queryClient,
  ]);

  // ---- discard episode (real DELETE /runs/{id} — v1 LiveTab Keep/Discard) ----
  // The result-phase "Discard & re-record" used to only reset local state, so
  // the run stayed on disk. Now it opens a confirmation modal and, on confirm,
  // deletes the run before the local re-record reset (RETRY_EPISODE, unchanged).
  // Deletion never happens without the modal; a failed DELETE keeps the episode.
  const [discardModalOpen, setDiscardModalOpen] = useState(false);
  const discardMutation = useMutation({
    mutationFn: (rid: string) => apiDelete(`/runs/${encodeURIComponent(rid)}`),
    onSuccess: (_data, rid) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      // Drop any Collect->Review bridge entry for the deleted run so a discarded
      // recording never lingers as a stale outcome on the Review screen.
      removeEpisodeOutcome(rid);
      dispatch({ type: 'RETRY_EPISODE' });
      setDiscardModalOpen(false);
      showToast('Episode discarded — run deleted, re-record when ready');
    },
    // onError: keep the episode + modal open; the error surfaces via discardError.
  });

  const openDiscardModal = useCallback(() => {
    if (state.phase !== 'result') return;
    discardMutation.reset();
    setDiscardModalOpen(true);
  }, [state.phase, discardMutation]);

  const confirmDiscard = useCallback(() => {
    if (state.phase !== 'result') return;
    if (state.currentRunId) {
      discardMutation.mutate(state.currentRunId);
      return;
    }
    // No persisted run to delete (capture returned no run_id) — local reset only.
    dispatch({ type: 'RETRY_EPISODE' });
    setDiscardModalOpen(false);
    showToast('Episode discarded — re-record when ready');
  }, [state.phase, state.currentRunId, discardMutation, showToast]);

  // ---- takeover stop (D-1) -------------------------------------------------
  // Stop a recording this screen isn't driving (another session, or a resumed
  // own). A confirmation modal guards against knocking over someone else's take;
  // the stop then joins the normal completion path (the stopped run surfaces as
  // an unsaved take for labeling).
  const [takeoverStopModalOpen, setTakeoverStopModalOpen] = useState(false);
  const takeoverStopMutation = useMutation({
    mutationFn: () => apiPost<RunDetail>('/record/stop', {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
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
    const t = unsavedTake;
    if (!t) return;
    dispatch({ type: 'RESUME_TAKE', runId: t.runId });
    // Make sure there's a server batch to attach the recovered episode to.
    ensureBatch();
  }, [unsavedTake, ensureBatch]);

  const [unsavedDiscardModalOpen, setUnsavedDiscardModalOpen] = useState(false);
  const unsavedDiscardMutation = useMutation({
    mutationFn: (rid: string) => apiDelete(`/runs/${encodeURIComponent(rid)}`),
    onSuccess: (_data, rid) => {
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
      removeEpisodeOutcome(rid);
      setUnsavedDiscardModalOpen(false);
      showToast('Unsaved take discarded — run deleted');
    },
  });
  const discardUnsavedTake = useCallback(() => setUnsavedDiscardModalOpen(true), []);
  const confirmDiscardUnsavedTake = useCallback(() => {
    if (unsavedTake) unsavedDiscardMutation.mutate(unsavedTake.runId);
  }, [unsavedTake, unsavedDiscardMutation]);
  const dismissUnsavedTake = useCallback(() => {
    if (unsavedTake) {
      dismissedUnsavedRuns.add(unsavedTake.runId);
      setDismissNonce((n) => n + 1);
    }
  }, [unsavedTake]);

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
    setDiscardModalOpen(false);
    setTakeoverStopModalOpen(false);
    setUnsavedDiscardModalOpen(false);
    setShortcutsOpen(false);
  }, []);
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
    discardModalOpen ||
    takeoverStopModalOpen ||
    unsavedDiscardModalOpen ||
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
    recordingBytes: currentRunBytes,
    recorderState,
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
    confirmDiscardUnsavedTake,
    dismissUnsavedTake,
    unsavedDiscardModalOpen,
    isDiscardingUnsaved: unsavedDiscardMutation.isPending,

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

    discardModalOpen,
    discardRunId: state.currentRunId,
    discardRunBytes: currentRunBytes,
    discardError: discardMutation.isError ? errorText(discardMutation.error) : null,
    isDiscarding: discardMutation.isPending,

    adviceIdx,
    advicePrev,
    adviceNext,

    toast,

    startRecording,
    cancelArming,
    stopRecording,
    retryStop,
    pickSuccess,
    pickFailure,
    pickFailReason,
    confirmEpisode,
    openDiscardModal,
    confirmDiscard,
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
