// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Shared plan catalog (Projects → Tasks → Conditions) for Console v2 — the
// SINGLE source of truth for both the Settings "Projects & tasks" editor and the
// Collect screen's project/task/condition pickers. Previously each screen kept
// its own local copy, so a project added in Settings never appeared in Collect.
//
// A module-level store (same useSyncExternalStore pattern as collect's batch
// store) makes edits reactive across screens and survive a tab-switch unmount;
// it also persists to localStorage (versioned key) so edits survive a reload.
//
// The same store also carries the FAILURE-REASON vocabulary (the chips Collect
// offers when an episode is marked Failure, edited in Settings) — one more
// label axis with exactly the same shared-vocabulary reasoning, synced through
// the same /api/v1/plans catalog.
//
// SERVER SYNC (2026-07-14, batch-label decision): the catalog is the label
// VOCABULARY Collect stamps onto batches/episodes, so every terminal must
// share ONE copy — GET/PUT /api/v1/plans persists it in the orchestrator.
// Contract: a never-set server (projects: null) is SEEDED from this browser;
// unsynced local edits (dirty flag) win over the server copy; otherwise the
// server catalog is adopted. Offline, the browser-local copy stands and a
// dirty edit is re-pushed on the next edit or page load. This is still NOT
// the Phase 2.5 Plan model (no batch references or targets): its IDs only
// preserve catalog selection across rename/reorder.

import { useEffect, useSyncExternalStore } from 'react';
import { apiGet, apiPut } from '../api/client';

export interface PlanTask {
  task_id: string;
  name: string;
  conditions: PlanCondition[];
}
export interface PlanProject {
  project_id: string;
  name: string;
  tasks: PlanTask[];
}
export interface PlanCondition {
  condition_id: string;
  name: string;
}

export function newPlanId(prefix: 'project' | 'task' | 'condition'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// Seed catalog (the values the two screens previously duplicated).
export const DEFAULT_PLANS: PlanProject[] = [
  {
    project_id: 'project-tabletop-manipulation',
    name: 'Tabletop Manipulation',
    tasks: [
      {
        task_id: 'task-pick-and-place',
        name: 'Pick and Place',
        conditions: [
          { condition_id: 'condition-object-left-tray-center', name: 'Object: Left → Tray: Center' },
          { condition_id: 'condition-object-center-tray-center', name: 'Object: Center → Tray: Center' },
          { condition_id: 'condition-object-right-tray-center', name: 'Object: Right → Tray: Center' },
        ],
      },
      {
        task_id: 'task-stacking',
        name: 'Stacking',
        conditions: [
          { condition_id: 'condition-blocks-3', name: 'Blocks: 3' },
          { condition_id: 'condition-blocks-5', name: 'Blocks: 5' },
        ],
      },
    ],
  },
  {
    project_id: 'project-bin-picking',
    name: 'Bin Picking',
    tasks: [
      {
        task_id: 'task-bin-to-tray',
        name: 'Bin to Tray',
        conditions: [
          { condition_id: 'condition-bin-full', name: 'Bin: full' },
          { condition_id: 'condition-bin-sparse', name: 'Bin: sparse' },
        ],
      },
    ],
  },
  {
    project_id: 'project-kitchen-mobile',
    name: 'Kitchen Mobile',
    tasks: [
      {
        task_id: 'task-drawer-open',
        name: 'Drawer Open',
        conditions: [
          { condition_id: 'condition-drawer-top', name: 'Drawer: top' },
          { condition_id: 'condition-drawer-bottom', name: 'Drawer: bottom' },
        ],
      },
    ],
  },
];

// The fail-reason vocabulary Collect offers when an episode is marked Failure
// (edited in Settings > Failure reasons). Kept non-empty everywhere: labeling
// a Failure REQUIRES a reason, so an empty vocabulary would soft-lock that
// flow — the editor blocks removing the last entry and this store refuses an
// empty replacement.
export const DEFAULT_FAIL_REASONS = [
  'Grasp missed',
  'Object dropped',
  'Wrong placement',
  'Object misplaced at start',
  'Robot fault',
  'Other',
];

/** Deep copy so the store's arrays are never mutated in place by a caller. */
export function clonePlans(plans: PlanProject[]): PlanProject[] {
  return plans.map((p) => ({
    project_id: p.project_id,
    name: p.name,
    tasks: p.tasks.map((t) => ({
      task_id: t.task_id,
      name: t.name,
      conditions: t.conditions.map((c) => ({ condition_id: c.condition_id, name: c.name })),
    })),
  }));
}

/** The project matching `name`, else the first project — a safe fallback so a
 *  removed/renamed selection never crashes a picker. Returns an empty project
 *  only when the catalog itself is empty. */
export function findProject(plans: PlanProject[], name: string): PlanProject {
  return plans.find((p) => p.name === name) ?? plans[0] ?? { project_id: '', name: '—', tasks: [] };
}
/** The task matching `taskName` within its project, else that project's first
 *  task — same graceful fallback as findProject. */
export function findTask(plans: PlanProject[], projectName: string, taskName: string): PlanTask {
  const project = findProject(plans, projectName);
  return project.tasks.find((t) => t.name === taskName) ?? project.tasks[0] ?? { task_id: '', name: '—', conditions: [] };
}

/** Resolve displayed labels to catalog identities. Custom and absent labels have
 * no identity and deliberately return null rather than a guessed nearby item. */
export function resolvePlanIds(
  plans: PlanProject[],
  projectName: string | null,
  taskName: string | null,
  conditionName: string | null,
): { project_id: string | null; task_id: string | null; condition_id: string | null } {
  const project = plans.find((p) => p.name === projectName);
  if (!project) return { project_id: null, task_id: null, condition_id: null };
  const task = project.tasks.find((t) => t.name === taskName);
  if (!task) return { project_id: project.project_id, task_id: null, condition_id: null };
  const condition = task.conditions.find((c) => c.name === conditionName);
  return {
    project_id: project.project_id,
    task_id: task.task_id,
    condition_id: condition?.condition_id ?? null,
  };
}

const STORAGE_KEY = 'kairos.v2.plans.v1';

function legacyPlanId(kind: 'project' | 'task' | 'condition', path: string): string {
  // FNV-1a is deliberately deterministic, not cryptographic: this only gives
  // a pre-ID local blob stable identity until it is persisted in canonical form.
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i += 1) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `legacy-${kind}-${(hash >>> 0).toString(16)}`;
}

function normalizeLegacyPlans(value: unknown): PlanProject[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: PlanProject[] = [];
  for (let projectIndex = 0; projectIndex < value.length; projectIndex += 1) {
    const project = value[projectIndex];
    if (!project || typeof project !== 'object') return null;
    const p = project as Record<string, unknown>;
    if (typeof p.name !== 'string' || !Array.isArray(p.tasks)) return null;
    const projectName = p.name.trim();
    if (!projectName) return null;
    const projectPath = `${projectIndex}:${projectName}`;
    const tasks: PlanTask[] = [];
    for (let taskIndex = 0; taskIndex < p.tasks.length; taskIndex += 1) {
      const task = p.tasks[taskIndex];
      if (!task || typeof task !== 'object') return null;
      const t = task as Record<string, unknown>;
      if (typeof t.name !== 'string' || !Array.isArray(t.conditions)) return null;
      const taskName = t.name.trim();
      if (!taskName) return null;
      const taskPath = `${projectPath}/${taskIndex}:${taskName}`;
      const conditions: PlanCondition[] = [];
      for (let conditionIndex = 0; conditionIndex < t.conditions.length; conditionIndex += 1) {
        const rawCondition = t.conditions[conditionIndex];
        const condition =
          rawCondition && typeof rawCondition === 'object'
            ? (rawCondition as Record<string, unknown>)
            : null;
        const rawName = condition?.name ?? rawCondition;
        if (typeof rawName !== 'string' || !rawName.trim()) return null;
        const name = rawName.trim();
        const conditionPath = `${taskPath}/${conditionIndex}:${name}`;
        conditions.push({
          condition_id:
            typeof condition?.condition_id === 'string' && condition.condition_id
              ? condition.condition_id
              : legacyPlanId('condition', conditionPath),
          name,
        });
      }
      tasks.push({
        task_id:
          typeof t.task_id === 'string' && t.task_id
            ? t.task_id
            : legacyPlanId('task', taskPath),
        name: taskName,
        conditions,
      });
    }
    normalized.push({
      project_id:
        typeof p.project_id === 'string' && p.project_id
          ? p.project_id
          : legacyPlanId('project', projectPath),
      name: projectName,
      tasks,
    });
  }
  return normalized;
}

// Whether the in-memory catalog came OUT of storage, or from the seeds because
// nothing usable was there (absent, unparseable, or an older schema). The dirty
// flag below is a claim that this browser holds an edit the server has not seen;
// if nothing was restored, that claim has nothing behind it. See ensurePlansSynced.
let plansRestoredFromStorage = false;

function readInitial(): PlanProject[] {
  plansRestoredFromStorage = false;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return clonePlans(DEFAULT_PLANS);
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeLegacyPlans(parsed);
    if (normalized !== null) {
      plansRestoredFromStorage = true;
      // Persist the one-way localStorage migration before it can become a
      // dirty replay; later edits must retain the generated identities.
      persist(STORAGE_KEY, JSON.stringify(normalized));
      return normalized;
    }
    return clonePlans(DEFAULT_PLANS);
  } catch {
    return clonePlans(DEFAULT_PLANS);
  }
}

const FAIL_REASONS_KEY = 'kairos.v2.failreasons.v1';

function isReasonList(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((r) => typeof r === 'string');
}

function readInitialFailReasons(): string[] {
  try {
    const raw = window.localStorage.getItem(FAIL_REASONS_KEY);
    if (!raw) return DEFAULT_FAIL_REASONS.slice();
    const parsed = JSON.parse(raw) as unknown;
    return isReasonList(parsed) ? parsed : DEFAULT_FAIL_REASONS.slice();
  } catch {
    return DEFAULT_FAIL_REASONS.slice();
  }
}

// Operator roster (attribution, NOT auth — the project-lead ruling): the
// names the header OP picker offers. An EMPTY roster means "feature not
// adopted": the chip stays free-text and nothing is gated — so unlike the
// fail reasons, [] is a legitimate stored/adopted/pushed value.
const OPERATORS_KEY = 'kairos.v2.operators.v1';

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function readInitialOperators(): string[] {
  try {
    const raw = window.localStorage.getItem(OPERATORS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return isStringList(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Best-effort write that reports whether the value actually landed. The dirty
 *  flag must never outlive the edit it refers to, so every setter marks dirty
 *  only after its own value is safely stored (see setPlans). */
function persist(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    // localStorage unavailable or full — the in-memory copy still works this
    // session, it just cannot be recovered after a reload.
    return false;
  }
}

let currentPlans: PlanProject[] = readInitial();
let currentFailReasons: string[] = readInitialFailReasons();
let currentOperators: string[] = readInitialOperators();
// Set by any setter below: this session's in-memory copy IS a real edit, even
// when storage refused to keep it, so a dirty flag alongside it is trustworthy.
let editedThisSession = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Current catalog snapshot (stable reference until the next setPlans). */
export function getPlans(): PlanProject[] {
  return currentPlans;
}

/** Replace the whole catalog (Settings' add/rename/remove all funnel here),
 *  persisting to localStorage + pushing to the server, and notifying every
 *  subscribed screen. A failed push leaves the dirty flag set, so the edit is
 *  re-pushed on the next edit or page load instead of being silently lost. */
export function setPlans(next: PlanProject[] | unknown): void {
  const normalized = normalizeLegacyPlans(next);
  if (normalized === null) return;
  currentPlans = normalized;
  editedThisSession = true;
  // Persist BEFORE claiming the edit is unsynced. The flag is one byte and the
  // catalog is kilobytes, so a full origin fails only the second write — and
  // marking dirty first left that pair inconsistent across a reload: the claim
  // survived, the edit did not, and the next reconcile pushed the SEED catalog
  // over the team's. Only a STORED edit can be re-pushed on a later load.
  if (persist(STORAGE_KEY, JSON.stringify(normalized))) markCatalogDirty();
  notify();
  pushCatalogToServer();
}

/** Current fail-reason vocabulary snapshot (stable until the next set). */
export function getFailReasons(): string[] {
  return currentFailReasons;
}

/** Current operator roster snapshot (stable until the next set). */
export function getOperators(): string[] {
  return currentOperators;
}

/** Replace the operator roster — same persist/push/notify path as setPlans.
 *  An empty roster is allowed: it turns the OP picker back into free text. */
export function setOperators(next: string[]): void {
  currentOperators = next;
  editedThisSession = true;
  if (persist(OPERATORS_KEY, JSON.stringify(next))) markCatalogDirty();
  notify();
  pushCatalogToServer();
}

/** Replace the fail-reason vocabulary — same persist/push/notify path as
 *  setPlans. An empty replacement is refused (see DEFAULT_FAIL_REASONS: the
 *  Failure flow requires a reason, so the vocabulary must never empty out). */
export function setFailReasons(next: string[]): void {
  if (next.length === 0) return;
  currentFailReasons = next;
  editedThisSession = true;
  if (persist(FAIL_REASONS_KEY, JSON.stringify(next))) markCatalogDirty();
  notify();
  pushCatalogToServer();
}

// ---- server sync -----------------------------------------------------------

/** GET/PUT /api/v1/plans response shape (see routers/plans.py). A backend
 *  from before the failure_reasons field simply omits it (undefined). */
interface PlansServerResponse {
  projects: PlanProject[] | null;
  failure_reasons?: string[] | null;
  operators?: string[] | null;
  updated_at: string | null;
  revision: number;
}

// Set while a local edit hasn't been confirmed by the server — it survives a
// reload so an offline edit still wins the next reconcile.
const DIRTY_KEY = 'kairos.v2.plans.dirty.v1';
const SYNC_KEY = 'kairos.v2.plans.sync.v2';

interface PlansSyncState {
  acknowledgedRevision: number;
  dirtyBaseRevision: number | null;
  generation: number;
  conflicted: boolean;
}

function readSyncState(): PlansSyncState {
  try {
    const raw = window.localStorage.getItem(SYNC_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PlansSyncState>;
      if (
        typeof parsed.acknowledgedRevision === 'number' &&
        (typeof parsed.dirtyBaseRevision === 'number' || parsed.dirtyBaseRevision === null) &&
        typeof parsed.generation === 'number' &&
        typeof parsed.conflicted === 'boolean'
      ) {
        return parsed as PlansSyncState;
      }
    }
  } catch {
    // The legacy dirty bit below safely turns a pre-CAS offline edit into a
    // base-0 attempt, which conflicts rather than overwriting a known catalog.
  }
  return {
    acknowledgedRevision: 0,
    dirtyBaseRevision: readDirty() ? 0 : null,
    generation: 0,
    conflicted: false,
  };
}

function persistSyncState(): void {
  try {
    window.localStorage.setItem(SYNC_KEY, JSON.stringify(syncState));
  } catch {
    // The in-memory state still prevents response reordering this session.
  }
}

function readDirty(): boolean {
  try {
    return window.localStorage.getItem(DIRTY_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDirty(dirty: boolean): void {
  try {
    if (dirty) window.localStorage.setItem(DIRTY_KEY, '1');
    else window.localStorage.removeItem(DIRTY_KEY);
  } catch {
    // localStorage unavailable: sync still works within this session.
  }
}

let syncState: PlansSyncState = readSyncState();

function markCatalogDirty(): void {
  if (syncState.dirtyBaseRevision === null) {
    syncState.dirtyBaseRevision = syncState.acknowledgedRevision;
  }
  syncState.generation += 1;
  syncState.conflicted = false;
  persistSyncState();
  writeDirty(true);
}

function acknowledgeCatalog(revision: number): void {
  syncState.acknowledgedRevision = revision;
  syncState.dirtyBaseRevision = null;
  syncState.conflicted = false;
  persistSyncState();
  writeDirty(false);
}

// Whether the LAST push failed. The local copy standing is deliberate, but the
// editors report an edit as done the moment it applies locally — so without
// this the operator was told "Project added" while the catalog every other
// terminal reads was unchanged, with nothing on screen saying so. Not the same
// as the dirty flag, which is briefly true after every edit even on a good link.
let pushFailed = false;

function setPushFailed(value: boolean): void {
  if (pushFailed === value) return;
  pushFailed = value;
  notify();
}

let pushInFlight = false;

function pushCatalogToServer(): void {
  if (pushInFlight || syncState.conflicted || syncState.dirtyBaseRevision === null) return;
  pushInFlight = true;
  const generation = syncState.generation;
  const baseRevision = syncState.dirtyBaseRevision;
  const projects = clonePlans(getPlans());
  const failureReasons = getFailReasons().slice();
  const operators = getOperators().slice();
  apiPut<PlansServerResponse>('/plans', {
    base_revision: baseRevision,
    projects,
    failure_reasons: failureReasons,
    operators,
  })
    .then((response) => {
      // A newer local mutation can be made while this request is in flight.
      // Only the matching generation may declare the dirty catalog settled.
      syncState.acknowledgedRevision = response.revision;
      if (generation === syncState.generation) {
        acknowledgeCatalog(response.revision);
        setPushFailed(false);
      } else {
        syncState.dirtyBaseRevision = response.revision;
        persistSyncState();
      }
    })
    .catch((error: unknown) => {
      // A CAS conflict is neither offline nor retryable automatically: replay
      // would overwrite somebody else's catalog. Keep the exact local draft.
      if (error instanceof Error && 'status' in error && (error as { status?: number }).status === 409) {
        syncState.conflicted = true;
        persistSyncState();
      }
      setPushFailed(true);
    })
    .finally(() => {
      pushInFlight = false;
      if (
        !syncState.conflicted &&
        syncState.dirtyBaseRevision !== null &&
        syncState.generation !== generation
      ) {
        pushCatalogToServer();
      }
    });
}

/** Whether the last attempt to push the shared catalog failed, i.e. the edits
 *  on screen are on this browser only. */
export function getPlansUnsynced(): boolean {
  return pushFailed;
}

/** A revision conflict is distinct from a temporary unavailable server: this
 * browser deliberately stopped replaying the draft until the operator chooses
 * to discard it or applies it again after reading the current catalog. */
export function getPlansConflict(): boolean {
  return syncState.conflicted;
}

/** React binding for {@link getPlansUnsynced}. */
export function usePlansUnsynced(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getPlansUnsynced,
    getPlansUnsynced,
  );
}

/** React binding for an explicit server-versus-local catalog conflict. */
export function usePlansConflict(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getPlansConflict,
    getPlansConflict,
  );
}

/** Adopt the server catalog as-is (no dirty mark, no re-push). An empty list
 *  is honored — an explicitly emptied catalog must not resurrect the seeds. */
function adoptServerPlans(projects: PlanProject[]): void {
  const normalized = normalizeLegacyPlans(projects);
  if (normalized === null) return; // malformed — local copy stands
  currentPlans = clonePlans(normalized);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentPlans));
  } catch {
    /* ignore */
  }
  notify();
}

/** Explicit recovery for a CAS conflict. This discards only the local catalog
 * draft after a fresh GET succeeds; no stale local payload is sent back. */
export function adoptServerCatalog(): void {
  apiGet<PlansServerResponse>('/plans')
    .then((resp) => {
      if (!resp || !Array.isArray(resp.projects)) return;
      adoptServerPlans(resp.projects);
      if (isReasonList(resp.failure_reasons)) adoptServerFailReasons(resp.failure_reasons);
      if (isStringList(resp.operators)) adoptServerOperators(resp.operators);
      acknowledgeCatalog(resp.revision);
      setPushFailed(false);
      notify();
    })
    .catch(() => {
      setPushFailed(true);
    });
}

/** Adopt the server fail-reason vocabulary (no dirty mark, no re-push).
 *  Unlike projects, an empty list is NOT adopted — the Failure flow requires
 *  a reason, so an unusable vocabulary keeps the local copy instead. */
function adoptServerFailReasons(reasons: string[]): void {
  if (!isReasonList(reasons)) return;
  currentFailReasons = reasons.slice();
  try {
    window.localStorage.setItem(FAIL_REASONS_KEY, JSON.stringify(currentFailReasons));
  } catch {
    /* ignore */
  }
  notify();
}

/** Adopt the server roster (no dirty mark, no re-push). Empty IS adopted —
 *  an explicitly cleared roster must not resurrect local names. */
function adoptServerOperators(operators: string[]): void {
  currentOperators = operators.slice();
  try {
    window.localStorage.setItem(OPERATORS_KEY, JSON.stringify(currentOperators));
  } catch {
    /* ignore */
  }
  notify();
}

// Once per page load (module flag) — later mounts are no-ops.
let plansSyncStarted = false;

/** Reconcile the browser-local catalog with the server, once per page load:
 *  never-set server halves (projects and/or failure_reasons) → seed them from
 *  this browser; unsynced local edits → push them; otherwise adopt the server
 *  copy. Any failure keeps the local copy. */
export function ensurePlansSynced(): void {
  if (plansSyncStarted) return;
  plansSyncStarted = true;
  apiGet<PlansServerResponse>('/plans')
    .then((resp) => {
      if (!resp) return;
      syncState.acknowledgedRevision = resp.revision;
      persistSyncState();
      if (readDirty()) {
        // The flag says "this browser holds an edit the server has not seen".
        // Honor it only when something is actually behind it: an edit made in
        // THIS session, or a catalog that came back out of storage. Otherwise
        // the edit it refers to is gone (its write failed, or the stored value
        // is corrupt / from an older schema) while the one-byte flag survived.
        //
        // Nothing recoverable is dropped by clearing it. Reaching here means
        // !editedThisSession and !plansRestoredFromStorage, and readInitial's
        // only non-restore paths return clonePlans(DEFAULT_PLANS); the sole
        // other mutators are setPlans (which sets editedThisSession) and
        // adoptServerPlans (which runs BELOW this branch, once per page load).
        // So currentPlans here IS the factory seed catalog. What is discarded
        // is a CLAIM whose edit is already unrecoverable — not the operator's
        // work — and honoring it would PUT this browser's copy of all three
        // shared vocabularies over the team's: the seed projects, the operator
        // roster, and the failure-reason list.
        if (editedThisSession || plansRestoredFromStorage) {
          if (syncState.dirtyBaseRevision === null) {
            syncState.dirtyBaseRevision = 0;
            persistSyncState();
          }
          pushCatalogToServer();
          return;
        }
        writeDirty(false);
      }
      if (Array.isArray(resp.projects)) adoptServerPlans(resp.projects);
      if (isReasonList(resp.failure_reasons)) {
        adoptServerFailReasons(resp.failure_reasons);
      }
      if (isStringList(resp.operators)) adoptServerOperators(resp.operators);
      // Seed whichever half the server has never stored (null, or absent on a
      // pre-field backend). A server-side EMPTY reasons list is neither
      // adopted (unusable, see above) nor re-pushed — the local copy stands.
      if (
        resp.projects === null ||
        resp.failure_reasons == null ||
        resp.operators == null
      ) {
        if (syncState.dirtyBaseRevision === null) {
          syncState.dirtyBaseRevision = resp.revision;
          syncState.generation += 1;
          persistSyncState();
          writeDirty(true);
        }
        pushCatalogToServer();
      }
    })
    .catch(() => {
      // API unreachable — the browser-local catalog stands.
    });
}

/** React binding: re-renders the subscriber whenever the catalog changes, so a
 *  Settings edit shows up in Collect's pickers immediately. The first mount of
 *  any subscriber also kicks the once-per-load server reconcile. */
export function usePlans(): PlanProject[] {
  useEffect(() => {
    ensurePlansSynced();
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getPlans,
    getPlans,
  );
}

/** React binding for the fail-reason vocabulary — same semantics as usePlans
 *  (re-render on change, first mount kicks the server reconcile). */
export function useFailReasons(): string[] {
  useEffect(() => {
    ensurePlansSynced();
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getFailReasons,
    getFailReasons,
  );
}

/** React binding for the operator roster — same semantics as usePlans. */
export function useOperators(): string[] {
  useEffect(() => {
    ensurePlansSynced();
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getOperators,
    getOperators,
  );
}

/** Test-only: reset the catalog + clear its persistence between cases. */
export function __resetPlansStore(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(DIRTY_KEY);
    window.localStorage.removeItem(SYNC_KEY);
    window.localStorage.removeItem(FAIL_REASONS_KEY);
    window.localStorage.removeItem(OPERATORS_KEY);
  } catch {
    /* ignore */
  }
  plansSyncStarted = false;
  pushInFlight = false;
  pushFailed = false;
  syncState = {
    acknowledgedRevision: 0,
    dirtyBaseRevision: null,
    generation: 0,
    conflicted: false,
  };
  editedThisSession = false;
  plansRestoredFromStorage = false;
  currentPlans = clonePlans(DEFAULT_PLANS);
  currentFailReasons = DEFAULT_FAIL_REASONS.slice();
  currentOperators = [];
  notify();
}

/** Test-only: re-run the storage-restore path after seeding localStorage. */
export function __rehydratePlansStore(): void {
  // Simulates a fresh page load: whatever this session did is over.
  editedThisSession = false;
  currentPlans = readInitial();
  currentFailReasons = readInitialFailReasons();
  currentOperators = readInitialOperators();
  notify();
}
