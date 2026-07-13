// Collect screen state machine: batch -> episode -> phase, all local to the
// frontend (the backend has no Session/Batch/Episode model yet — that's Phase
// 2). The recording itself is real: startRecording()/stopRecording() call the
// orchestrator's /record/start and /record/stop (same contract LiveTab uses),
// and every other transition (arming/saving/quick-check/result/pause/end) is
// simulated client-side so the operator flow is fully demoable today.
//
// The reducer below is the "batch machine" proper — pure, exported for direct
// unit testing. Everything else in the hook (real API calls, timers, toast,
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
  createEpisode,
  listBatches,
  patchBatch,
  removeEpisodeOutcome,
  saveEpisodeOutcome,
} from '../episodeBridge';
import { findProject, findTask, getPlans } from '../plans';
import type {
  BatchEpisodeSummary,
  BatchSummary,
  EpisodeCreateRequest,
  RecordArming,
  RecordIntegrity,
  RecordStartRequest,
  RecordStatus,
  RunDetail,
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
export function describeTaskOutcome(pendingTask: 'ok' | 'fail' | null, failReason: string): string {
  if (pendingTask === 'ok') return 'Success.';
  if (pendingTask === 'fail') {
    return failReason ? `Failed — ${failReason.toLowerCase()}.` : 'Failed — choose a reason below.';
  }
  return '—';
}

/** Plain-language "Recording quality: …" line for the episode-result summary. */
export function describeQuality(recWarning: boolean): string {
  return recWarning
    ? 'Needs review — camera rate dropped during recording.'
    : 'Good — no issues detected.';
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
const SAVING_MS = 1000;
const QUICKCHECK_MS = 1500;
const WARNING_AT_S = 6;
export const MB_PER_S = 6.8; // demo write-rate used for the recording MB counter

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
  recWarning: boolean;
  pendingTask: 'ok' | 'fail' | null;
  failReason: string;
  startError: string | null;
  stopError: string | null;
  currentRunId: string | null;
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
    batchId: null,
    predictedSeq: null,
    elapsedMs: 0,
    recWarning: false,
    pendingTask: null,
    failReason: '',
    startError: null,
    stopError: null,
    currentRunId: null,
    project: firstPlan?.name ?? '—',
    task: firstTask?.name ?? '—',
    condition: firstTask?.conditions[0] ?? '—',
    endReason: '',
  };
}

type Action =
  | { type: 'START_REQUESTED' }
  | { type: 'START_FAILED'; message: string }
  | { type: 'START_SUCCEEDED'; runId: string | null }
  | { type: 'CANCEL_ARMING' }
  | { type: 'TICK'; elapsedMs: number }
  | { type: 'STOP_REQUESTED' }
  | { type: 'STOP_FAILED'; message: string }
  | { type: 'SAVED' }
  | { type: 'QUICK_CHECK_DONE' }
  | { type: 'PICK_RESULT'; result: 'ok' | 'fail' }
  | { type: 'PICK_FAIL_REASON'; reason: string }
  | { type: 'CONFIRM_EPISODE' }
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
  | { type: 'SET_BATCH'; batchId: string | null; batchSeq: number | null };

function reducer(state: MachineState, action: Action): MachineState {
  switch (action.type) {
    case 'START_REQUESTED':
      if (state.phase !== 'ready') return state;
      return { ...state, phase: 'arming', startError: null };
    case 'START_FAILED':
      return { ...state, phase: 'ready', startError: action.message };
    case 'START_SUCCEEDED':
      return {
        ...state,
        phase: 'recording',
        elapsedMs: 0,
        recWarning: false,
        currentRunId: action.runId,
        startError: null,
      };
    case 'CANCEL_ARMING':
      if (state.phase !== 'arming') return state;
      return { ...state, phase: 'ready' };
    case 'TICK': {
      if (state.phase !== 'recording') return state;
      const recWarning = state.recWarning || action.elapsedMs >= WARNING_AT_S * 1000;
      return { ...state, elapsedMs: action.elapsedMs, recWarning };
    }
    case 'STOP_REQUESTED':
      if (state.phase !== 'recording') return state;
      return { ...state, phase: 'saving', stopError: null };
    case 'STOP_FAILED':
      // Only snap back to RECORDING if we're still in the immediate next phase —
      // once the demo-paced saving/quick-check timers have moved further on, a
      // late stop error just gets recorded (no phase change), since forcing the
      // operator's already-shown result back would be more confusing than useful.
      if (state.phase !== 'saving') return { ...state, stopError: action.message };
      return { ...state, phase: 'recording', stopError: action.message };
    case 'SAVED':
      if (state.phase !== 'saving') return state;
      return { ...state, phase: 'quickcheck' };
    case 'QUICK_CHECK_DONE':
      if (state.phase !== 'quickcheck') return state;
      return { ...state, phase: 'result', pendingTask: null, failReason: '' };
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
    case 'CONFIRM_EPISODE': {
      if (state.phase !== 'result' || !state.pendingTask) return state;
      if (state.pendingTask === 'fail' && !state.failReason) return state;
      // Independent axes: a failed task can still be good-quality, usable data.
      const taskResult: TaskResult = state.pendingTask === 'fail' ? 'fail' : 'ok';
      const quality: Quality = state.recWarning ? 'review' : 'good';
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
      const done = recordedCount >= EPISODES_PER_BATCH;
      return {
        ...state,
        episodes,
        recordedCount,
        phase: done ? 'completed' : 'ready',
        elapsedMs: 0,
        recWarning: false,
        pendingTask: null,
        failReason: '',
        currentRunId: null,
      };
    }
    case 'RETRY_EPISODE':
      if (state.phase !== 'result') return state;
      return {
        ...state,
        phase: 'ready',
        elapsedMs: 0,
        recWarning: false,
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
        recWarning: false,
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
        recWarning: false,
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
      return { ...state, project: action.project, task: action.task, condition: action.condition };
    case 'SET_TASK':
      return { ...state, task: action.task, condition: action.condition };
    case 'SET_BATCH':
      return { ...state, batchId: action.batchId, batchSeq: action.batchSeq };
    default:
      return state;
  }
}

// Exported for direct reducer unit tests (no React needed for pure transitions).
export { reducer as batchMachineReducer, createInitialState as createBatchMachineState };

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
  /** Server batch id, mirrored so an API-down reload can still resume. */
  batchId: string | null;
  episodes: EpisodeRecord[];
  project: string;
  task: string;
  condition: string;
}

/** Serialize just the durable subset (used both to persist and to dedupe). */
function serializeDurable(state: MachineState): string {
  const blob: PersistedBatch = {
    batchSeq: state.batchSeq,
    recordedCount: state.recordedCount,
    batchId: state.batchId,
    episodes: state.episodes,
    project: state.project,
    task: state.task,
    condition: state.condition,
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
    const episodes = Array.isArray(blob.episodes) ? (blob.episodes as EpisodeRecord[]) : [];
    const recordedCount = Math.max(
      typeof blob.recordedCount === 'number' ? blob.recordedCount : 0,
      maxRecorded(episodes),
    );
    // A durable full batch resumes on its completed summary; anything else
    // lands on the safe 'ready' baseline. The persisted phase (if any) is
    // ignored on purpose — see the note above.
    const phase: Phase = recordedCount >= EPISODES_PER_BATCH ? 'completed' : 'ready';
    return {
      ...base,
      phase,
      batchSeq: typeof blob.batchSeq === 'number' ? blob.batchSeq : null,
      recordedCount,
      batchId: typeof blob.batchId === 'string' ? blob.batchId : null,
      episodes,
      project: typeof blob.project === 'string' ? blob.project : base.project,
      task: typeof blob.task === 'string' ? blob.task : base.task,
      condition: typeof blob.condition === 'string' ? blob.condition : base.condition,
    };
  } catch {
    return base;
  }
}

let currentState: MachineState = readInitialState();
const storeListeners = new Set<() => void>();

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
  const episodes = batch.episodes.map(serverEpisodeToRecord);
  // The batch number is the server's own batch_seq (null on an older backend
  // that doesn't serve it yet → honest "—" fallback in the UI).
  const batchSeq = typeof batch.batch_seq === 'number' ? batch.batch_seq : null;
  // Monotone recorded count: the server's `episodes_recorded` (which excludes
  // nothing and never drops on a Review delete) — or, on an older backend, the
  // episode list's own lower bound. NEVER lower the count already held locally.
  const serverRecorded =
    typeof batch.episodes_recorded === 'number'
      ? batch.episodes_recorded
      : maxRecorded(episodes);
  const recordedCount = Math.max(serverRecorded, currentState.recordedCount);
  const phase: Phase = recordedCount >= EPISODES_PER_BATCH ? 'completed' : 'ready';
  currentState = {
    ...createInitialState(),
    batchId: batch.batch_id,
    batchSeq,
    recordedCount,
    project: batch.project,
    task: batch.task,
    condition: batch.condition ?? '—',
    episodes,
    phase,
  };
  persistBatch(currentState);
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
    if (isLocalToday(b.created_at) && typeof b.batch_seq === 'number' && b.batch_seq > max) {
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
  recWarning: boolean;
  pendingTask: 'ok' | 'fail' | null;
  failReason: string;
  startError: string | null;
  stopError: string | null;
  isStarting: boolean;
  stats: BatchStats;

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
  toggleBatchMenu: () => void;
  openProjPicker: () => void;
  openTaskPicker: () => void;
  openCondModal: () => void;
  openEndModal: () => void;
  openIssueModal: () => void;
  openResetModal: () => void;
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
  /** Jump to the Monitor tab (Warnings card's "Open in Monitor →"). */
  goMonitor: () => void;
}

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
      return { topics: [...recordSelected], count: recordSelected.size, customized: true };
    }
    if (defaultTopics.length > 0) {
      return { topics: defaultTopics, count: defaultTopics.length, customized: false };
    }
    return { topics: 'all', count: 0, customized: false };
  }, [recordCustomized, recordSelected, defaultTopics]);
  // Disable Start only when the operator explicitly cleared every topic.
  const noSelection =
    selection.customized && Array.isArray(selection.topics) && selection.topics.length === 0;

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
  const integrity: RecordIntegrity | null = runMatches ? status?.integrity ?? null : null;
  const droppedMessages: number | null = runMatches ? status?.dropped_messages ?? null : null;
  // Finalised bag size for the just-stopped run, shown in the Discard modal.
  const currentRunBytes: number | null = runMatches ? status?.bytes ?? null : null;

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
      target_episodes: EPISODES_PER_BATCH,
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
    listBatches()
      .then((resp) => {
        const items = resp.items ?? [];
        const p = getStoreSnapshot().phase;
        const atRest = p === 'ready' || p === 'completed' || p === 'ended' || p === 'paused';
        if (atRest) applyServerRestore(items.find((b) => b.status === 'active') ?? null);
        setPredictedSeq(predictNextSeq(items));
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
          message: run?.error
            ? `${run.error.code}: ${run.error.message}`
            : 'the recorder rejected the start',
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
      dispatch({ type: 'START_FAILED', message: errorText(err) });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => apiPost<RunDetail>('/record/stop', {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
    },
    onError: (err) => {
      dispatch({ type: 'STOP_FAILED', message: errorText(err) });
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
  }, [state.phase, state.task, noSelection, selection.topics, operator, startMutation, ensureBatch]);

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

  // ---- demo-paced phase timers ---------------------------------------------
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

  useEffect(() => {
    if (state.phase !== 'saving') return;
    const id = setTimeout(() => dispatch({ type: 'SAVED' }), SAVING_MS);
    return () => clearTimeout(id);
  }, [state.phase]);

  useEffect(() => {
    if (state.phase !== 'quickcheck') return;
    const id = setTimeout(() => dispatch({ type: 'QUICK_CHECK_DONE' }), QUICKCHECK_MS);
    return () => clearTimeout(id);
  }, [state.phase]);

  // ---- episode result / confirm --------------------------------------------
  const pickSuccess = useCallback(() => dispatch({ type: 'PICK_RESULT', result: 'ok' }), []);
  const pickFailure = useCallback(() => dispatch({ type: 'PICK_RESULT', result: 'fail' }), []);
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
    const willComplete = nextIndex >= EPISODES_PER_BATCH;
    const isFail = state.pendingTask === 'fail';
    const reason = state.failReason;
    const needsReview = state.recWarning;
    const runId = state.currentRunId;
    const batchId = state.batchId;
    // The bridge fallback (used only when the episode POST fails) keeps a local
    // grouping number; use the server batch_seq when known, else a safe 1.
    const bridgeBatchNum = state.batchSeq ?? 1;
    dispatch({ type: 'CONFIRM_EPISODE' });

    // Persist the episode to the server (Phase 2). On any failure keep the local
    // save and fall back to the browser bridge, so Review still shows it, and
    // tell the operator it didn't reach the server (honesty).
    if (runId) {
      const bridgeFallback = () => {
        saveEpisodeOutcome(runId, {
          quality: needsReview ? 'review' : 'good',
          taskResult: isFail ? 'fail' : 'ok',
          failReason: isFail ? reason || undefined : undefined,
          batchNum: bridgeBatchNum,
          episodeIndex: nextIndex,
          savedAt: Date.now(),
        });
        showToast(`Episode ${nextIndex} saved locally — couldn't reach the server`);
      };
      if (batchId) {
        const body: EpisodeCreateRequest = {
          batch_id: batchId,
          run_id: runId,
          index_in_batch: nextIndex,
          task_result: isFail ? 'failure' : 'success',
          quality: needsReview ? 'needs_review' : 'good',
          quality_source: 'operator',
        };
        if (isFail && reason) body.failure_reason = reason;
        createEpisode(body)
          .then(() => {
            if (willComplete) void patchBatch(batchId, { status: 'completed' }).catch(() => {});
          })
          .catch((err) => {
            // 409 = the run already has an episode (already saved) — not a failure.
            if (err instanceof ApiError && err.status === 409) return;
            bridgeFallback();
          });
      } else {
        // No server batch (create failed / API down) — bridge only.
        bridgeFallback();
      }
    } else if (willComplete && batchId) {
      // Completed with no run to attach — still mark the batch done.
      void patchBatch(batchId, { status: 'completed' }).catch(() => {});
    }

    if (!willComplete) {
      // Report both axes when either is notable — a failed task and/or a
      // review-flagged recording — so the toast never implies "not usable"
      // for data that's actually saved and labeled.
      const notes: string[] = [];
      if (isFail) notes.push(`task failed${reason ? ` (${reason})` : ''}`);
      if (needsReview) notes.push('quality needs review');
      const detail = notes.length ? ` — ${notes.join(', ')}` : '';
      showToast(`Episode ${nextIndex} saved${detail} — ready for #${nextIndex + 1}`);
    }
  }, [
    state.phase,
    state.pendingTask,
    state.failReason,
    state.recWarning,
    state.recordedCount,
    state.currentRunId,
    state.batchId,
    state.batchSeq,
    showToast,
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
    } else if (state.phase === 'recording' || state.phase === 'saving' || state.phase === 'quickcheck') {
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
    showToast(`Next batch ready — same condition, ${EPISODES_PER_BATCH} episodes`);
  }, [state.phase, showToast, ensureBatch]);

  // Reset the batch: close the current one and start fresh (counts → 0/30). The
  // recordings already taken are NOT deleted — they stay in Review. Unlike
  // start-next-batch, the new server batch is created LAZILY on the next start
  // (ensureBatch), not now. Works with the API down: the local reset always
  // happens and the toast says whether the server batch was closed.
  const resetBatch = useCallback(() => {
    // Abort any in-flight capture first so nothing is orphaned (as end-early).
    if (state.phase === 'arming') {
      cancelledStartRef.current = true;
    } else if (state.phase === 'recording' || state.phase === 'saving' || state.phase === 'quickcheck') {
      void apiPost('/record/stop', {}).catch(() => {});
    }
    const hadBatch = !!state.batchId;
    if (state.batchId) {
      void patchBatch(state.batchId, { status: 'ended_early', ended_reason: 'reset' }).catch(
        () => {},
      );
    }
    dispatch({ type: 'RESET_BATCH' });
    setResetModalOpen(false);
    setBatchMenuOpen(false);
    showToast(
      hadBatch
        ? 'Batch reset — recordings already taken stay in Review'
        : 'Batch reset (local) — recordings already taken stay in Review',
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
  const closeModals = useCallback(() => {
    setEndModalOpen(false);
    setIssueModalOpen(false);
    setCondModalOpen(false);
    setResetModalOpen(false);
    setDiscardModalOpen(false);
  }, []);
  const submitIssue = useCallback(() => {
    setIssueModalOpen(false);
    showToast('Issue logged with episode context');
  }, [showToast]);

  const pickProject = useCallback(
    (name: string) => {
      const plan = findProject(getPlans(), name);
      const t0 = plan.tasks[0];
      dispatch({
        type: 'SET_PROJECT',
        project: plan.name,
        task: t0?.name ?? '—',
        condition: t0?.conditions[0] ?? '—',
      });
      setProjPickerOpen(false);
      showToast('Project switched — batch plan reloaded');
    },
    [showToast],
  );
  const pickTask = useCallback(
    (name: string) => {
      const t = findTask(getPlans(), state.project, name);
      dispatch({ type: 'SET_TASK', task: t?.name ?? '—', condition: t?.conditions[0] ?? '—' });
      setTaskPickerOpen(false);
      showToast('Task switched — applies to next batch');
    },
    [state.project, showToast],
  );
  const pickCustomTask = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      // A free-text task has no plan-defined conditions; clear the condition to
      // '—' so a stale plan condition can't ride along with an unrelated task.
      dispatch({ type: 'SET_TASK', task: trimmed, condition: '—' });
      setTaskPickerOpen(false);
      showToast('Custom task set — applies to next recording');
    },
    [showToast],
  );
  const pickCondition = useCallback(
    (condition: string) => {
      dispatch({ type: 'SET_CONDITION', condition });
      setCondModalOpen(false);
      // Persist the condition change on the current server batch (best-effort).
      if (state.batchId) void patchBatch(state.batchId, { condition }).catch(() => {});
      showToast('Condition updated — applies from next episode');
    },
    [state.batchId, showToast],
  );

  const advicePrev = useCallback(
    () => setAdviceIdx((i) => (i - 1 + ADVICE_ITEMS.length) % ADVICE_ITEMS.length),
    [],
  );
  const adviceNext = useCallback(() => setAdviceIdx((i) => (i + 1) % ADVICE_ITEMS.length), []);

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
      nRemaining: Math.max(0, EPISODES_PER_BATCH - nRecorded),
      epNext: Math.min(nRecorded + 1, EPISODES_PER_BATCH),
    };
  }, [state.episodes, state.recordedCount]);

  return {
    phase: state.phase,
    episodes: state.episodes,
    batchSeq: state.batchSeq,
    predictedSeq: state.predictedSeq,
    elapsedMs: state.elapsedMs,
    recWarning: state.recWarning,
    pendingTask: state.pendingTask,
    failReason: state.failReason,
    startError: state.startError,
    stopError: state.stopError,
    isStarting: startMutation.isPending,
    stats,

    arming,
    integrity,
    droppedMessages,

    selection,
    noSelection,

    project: state.project,
    task: state.task,
    condition: state.condition,
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
    toggleBatchMenu,
    openProjPicker,
    openTaskPicker,
    openCondModal,
    openEndModal,
    openIssueModal,
    openResetModal,
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
    goMonitor,
  };
}
