// Episode persistence for Console v2: the Phase-2 orchestrator API (primary)
// plus a browser-local fallback bridge (used only when the API is unreachable
// or a run predates the server model).
//
// The lower half of this file is the REST client for /api/v1/batches and
// /api/v1/episodes — the server is now the source of truth, so an episode saved
// on one terminal shows in Review on any other.
//
// The upper half is the LEGACY fallback bridge: a run_id-keyed localStorage map,
// deliberately SEPARATE from Collect's per-batch blob (`kairos.collect.batch`),
// capped at the newest ~500 runs. Collect writes it only when the episode POST
// fails (so the outcome isn't lost); Review reads it only for runs with no
// server `episode` (so pre-Phase-2 entries stay displayable). No migration —
// these entries age out.
//
// Honesty: the bridge only ever carries what the operator actually chose in
// Collect. It never overrides backend truth — a run the backend reports as
// failed/interrupted stays "Not usable" in Review regardless of any stale entry
// here (the read side in mapRuns.ts enforces that).

import { ApiError, apiGet, apiPost, getApiBase } from '../api/client';
import type {
  Batch,
  BatchCreateRequest,
  BatchListResponse,
  BatchPatchRequest,
  Episode,
  EpisodeCreateRequest,
  EpisodePatchRequest,
} from '../api/types';

/** Collect's own quality axis (`review/useBatchMachine` Quality). Never
 *  'not usable' — that is a backend verdict, not something Collect emits. */
export type BridgeQuality = 'good' | 'review';
/** Collect's task-outcome axis (`review/useBatchMachine` TaskResult). */
export type BridgeTaskResult = 'ok' | 'fail';

/** One episode's operator-chosen outcome, mirrored from a saved Collect episode. */
export interface EpisodeOutcome {
  quality: BridgeQuality;
  taskResult: BridgeTaskResult;
  /** Set only when taskResult === 'fail'. */
  failReason?: string;
  /** Collect batch number this episode belonged to. */
  batchNum: number;
  /** 1-based index of the episode within its batch. */
  episodeIndex: number;
  /** Epoch ms the outcome was saved — the eviction key for the size cap. */
  savedAt: number;
}

// Versioned key: a future shape change bumps the suffix rather than trying to
// migrate an old blob in place.
const STORAGE_KEY = 'kairos.v2.episodeOutcomes.v1';
const MAX_ENTRIES = 500;

type OutcomeMap = Record<string, EpisodeOutcome>;

function readMap(): OutcomeMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as OutcomeMap;
  } catch {
    return {};
  }
}

function writeMap(map: OutcomeMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage unavailable (private mode / SSR): the bridge is a
    // best-effort convenience, so a failed write is silently non-fatal.
  }
}

function isOutcome(v: unknown): v is EpisodeOutcome {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    (o.quality === 'good' || o.quality === 'review') &&
    (o.taskResult === 'ok' || o.taskResult === 'fail') &&
    typeof o.batchNum === 'number' &&
    typeof o.episodeIndex === 'number' &&
    typeof o.savedAt === 'number'
  );
}

/** Mirror a saved Collect episode's outcome into the bridge, keyed by run_id.
 *  Enforces the size cap by evicting the oldest entries (by savedAt). */
export function saveEpisodeOutcome(runId: string, outcome: EpisodeOutcome): void {
  if (!runId) return;
  const map = readMap();
  map[runId] = outcome;
  const ids = Object.keys(map);
  if (ids.length > MAX_ENTRIES) {
    ids
      .sort((a, b) => (map[a]!.savedAt ?? 0) - (map[b]!.savedAt ?? 0)) // oldest first
      .slice(0, ids.length - MAX_ENTRIES)
      .forEach((id) => delete map[id]);
  }
  writeMap(map);
}

/** The operator-chosen outcome for a run, or null when none is recorded (the
 *  honest "—" default) or the stored entry is malformed. */
export function getEpisodeOutcome(runId: string): EpisodeOutcome | null {
  if (!runId) return null;
  const o = readMap()[runId];
  return isOutcome(o) ? o : null;
}

/** Drop a run's outcome — called when its recording is discarded/deleted so no
 *  stale entry lingers for a run that no longer exists. */
export function removeEpisodeOutcome(runId: string): void {
  if (!runId) return;
  const map = readMap();
  if (runId in map) {
    delete map[runId];
    writeMap(map);
  }
}

/** Test-only: wipe the whole bridge so cases don't leak into each other. */
export function __clearEpisodeOutcomes(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// ===========================================================================
// Phase 2 server API (primary): /api/v1/batches and /api/v1/episodes.
// ===========================================================================

// PATCH isn't in api/client.ts (and that file is out of scope to edit), so a
// minimal PATCH mirrors apiPost's error handling here.
async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const base = getApiBase();
  const url = path.startsWith('/api/')
    ? path
    : `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let errBody = null;
    try {
      errBody = await resp.json();
    } catch {
      errBody = null;
    }
    throw new ApiError(resp.status, errBody, `HTTP ${resp.status} ${resp.statusText}`);
  }
  const text = await resp.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** POST /api/v1/batches — start a batch (Collect). */
export function createBatch(body: BatchCreateRequest): Promise<Batch> {
  return apiPost<Batch>('/batches', body);
}

/** PATCH /api/v1/batches/{id} — early stop / completion / condition change. */
export function patchBatch(batchId: string, body: BatchPatchRequest): Promise<Batch> {
  return apiPatch<Batch>(`/batches/${encodeURIComponent(batchId)}`, body);
}

/** GET /api/v1/batches?status=active — newest-first, each with its episodes. */
export function listActiveBatches(): Promise<BatchListResponse> {
  return apiGet<BatchListResponse>('/batches', { query: { status: 'active' } });
}

/** GET /api/v1/batches — ALL batches newest-first (any status). Used to predict
 *  the next batch number (max batch_seq among today's batches + 1). */
export function listBatches(): Promise<BatchListResponse> {
  return apiGet<BatchListResponse>('/batches');
}

/** POST /api/v1/episodes — persist an episode on Collect Save. */
export function createEpisode(body: EpisodeCreateRequest): Promise<Episode> {
  return apiPost<Episode>('/episodes', body);
}

/** PATCH /api/v1/episodes/{id} — Review adopt/exclude or quality/result override. */
export function patchEpisode(episodeId: string, body: EpisodePatchRequest): Promise<Episode> {
  return apiPatch<Episode>(`/episodes/${encodeURIComponent(episodeId)}`, body);
}
