// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Module-level external store for the batch machine (state that must survive
// the Collect screen's unmount on a tab switch), plus its localStorage
// persistence and the Phase 2 server restore. Split out of useBatchMachine.ts.

import { useSyncExternalStore } from 'react';
import type {
  BatchSummary,
  Capture,
  CaptureListItem,
} from '../../../api/types';
import {
  EPISODES_PER_BATCH,
  STOP_FLOOR_MS,
  type EpisodeRecord,
  type Phase,
} from './types';
import { createInitialState, reducer, type Action, type MachineState } from './reducer';

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
  project: string | null;
  task: string | null;
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

/**
 * When the CURRENT take began, on the monotonic clock — module-level for the
 * same reason the machine state is (E-28).
 *
 * The shell unmounts this screen on a tab switch and mounts a fresh one on the
 * way back, which an operator does mid-take to glance at Monitor. Held in a
 * `useRef` this was lost on the way out, so the returning screen re-baselined
 * and handed back a minutes-old recording reading 00:00:00 — and re-armed the
 * Stop floor, which asks how old the take is and had just been told "brand
 * new".
 *
 * Deliberately NOT persisted: `performance.now()` is measured from the
 * DOCUMENT's time origin, so the number is meaningless in the next document —
 * and there is nothing to carry, because a reload never restores the
 * `recording` phase (see readInitialState).
 */
let takeStartMono: number | null = null;

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

export const dismissedUnsavedCaptures = readDismissed();

export function persistDismissed(): void {
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

export function dispatch(action: Action): void {
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

export function getStoreSnapshot(): MachineState {
  return currentState;
}

/** React binding for the module store (subscribes for the component's life). */
export function useBatchState(): MachineState {
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

/** Map one of a batch's captures to the local display record. A capture IS the
 *  episode (§8), so its `index_in_batch` is the number on the strip. */
function serverEpisodeToRecord(capture: Capture): EpisodeRecord {
  return {
    index: capture.index_in_batch ?? 0,
    // Collect's live quality axis is good | review; a server 'not_usable'
    // (e.g. a Review exclude) has no Collect equivalent, so it shows as review.
    quality: capture.quality === 'good' ? 'good' : 'review',
    taskResult: capture.task_result === 'failure' ? 'fail' : 'ok',
    captureId: capture.capture_id,
  };
}

/** Adopt the server's active batch as the durable context, with *captures* from
 *  that batch's detail — the list is a count and carries no episodes (E-27).
 *  When the server reports no active batch we deliberately leave local state
 *  alone (a no-op) rather than clobber it — the local blob may hold a
 *  just-finished batch whose PATCH has not landed yet; it self-heals on the
 *  next recording. Volatile phase stays at rest. */
export function applyServerRestore(batch: BatchSummary | null, captures: Capture[]): void {
  if (!batch) return;
  const serverEpisodes = captures.map(serverEpisodeToRecord);
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
    recordedIsFloor: batch.episodes_recorded_is_floor === true,
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

// Capture states that mean "this recording no longer exists for tallies"
// (mirrors the server's TOMBSTONE_STATES; the batch summary already excludes
// them, this set is for verifying local-only records against /captures/{id}).
export const TOMBSTONE_STATES = new Set(['delete_pending', 'discarded', 'deleted']);

/** Remove episode records whose capture the server has since tombstoned.
 *  The restore merge in applyServerRestore deliberately keeps local-only
 *  records (a review save whose PATCH hadn't landed has no batch_id
 *  server-side yet) — but that same keep would resurrect DELETED episodes
 *  into the strip and the quality tallies forever. The hydrate verifies each
 *  suspect against the server and calls this with the proven-dead. */
export function pruneDeadEpisodes(deadCaptureIds: Set<string>): void {
  if (deadCaptureIds.size === 0) return;
  const episodes = currentState.episodes.filter(
    (e) => !e.captureId || !deadCaptureIds.has(e.captureId),
  );
  if (episodes.length === currentState.episodes.length) return;
  currentState = { ...currentState, episodes };
  persistBatch(currentState);
  notifyStore();
}

/** True when the persisted local batch holds real content worth reconciling
 *  against the server (a recorded count, episodes, or a server batch handle) —
 *  vs a pristine empty machine that has nothing to discard. */
export function hasLocalBatchContext(s: MachineState): boolean {
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
export function localBatchIsPhantom(s: MachineState, captures: CaptureListItem[]): boolean {
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
export function clearLocalBatch(): void {
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
export function predictNextSeq(items: BatchSummary[]): number {
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
export function setPredictedSeq(seq: number | null): void {
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
  takeStartMono = null;
  notifyStore();
}
export function __rehydrateBatchStore(): void {
  lastPersisted = '';
  currentState = readInitialState();
  takeStartMono = null;
  notifyStore();
}

// ---- cross-module accessors ----------------------------------------------
// The hook half (useBatchMachine.ts) reads AND writes these module-level
// values. An ESM import binding is read-only on the importing side, so writes
// have to come back through functions defined here.

// The stop-confirmation seam moved to the shared module (Settings'
// stop-and-switch confirms through the same loop now); re-exported here so
// every existing import through useBatchMachine keeps resolving.
export {
  __resetStopConfirmMs,
  __setStopConfirmMs,
  getStopConfirmMaxMs,
  getStopConfirmPollMs,
} from '../../captures/stopConfirm';

export function getStopFloorMs(): number {
  return stopFloorMs;
}

export function getTakeStartMono(): number | null {
  return takeStartMono;
}

export function setTakeStartMono(value: number | null): void {
  takeStartMono = value;
}

export function isServerHydrated(): boolean {
  return serverHydrated;
}

export function markServerHydrated(): void {
  serverHydrated = true;
}
