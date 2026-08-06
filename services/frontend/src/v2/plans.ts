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
// the Phase 2.5 Plan model (no ids/refs/targets) — just the shared catalog.

import { useEffect, useSyncExternalStore } from 'react';
import { apiGet, apiPut } from '../api/client';

export interface PlanTask {
  name: string;
  conditions: string[];
}
export interface PlanProject {
  name: string;
  tasks: PlanTask[];
}

// Seed catalog (the values the two screens previously duplicated).
export const DEFAULT_PLANS: PlanProject[] = [
  {
    name: 'Tabletop Manipulation',
    tasks: [
      {
        name: 'Pick and Place',
        conditions: [
          'Object: Left → Tray: Center',
          'Object: Center → Tray: Center',
          'Object: Right → Tray: Center',
        ],
      },
      { name: 'Stacking', conditions: ['Blocks: 3', 'Blocks: 5'] },
    ],
  },
  {
    name: 'Bin Picking',
    tasks: [{ name: 'Bin to Tray', conditions: ['Bin: full', 'Bin: sparse'] }],
  },
  {
    name: 'Kitchen Mobile',
    tasks: [{ name: 'Drawer Open', conditions: ['Drawer: top', 'Drawer: bottom'] }],
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
    name: p.name,
    tasks: p.tasks.map((t) => ({ name: t.name, conditions: t.conditions.slice() })),
  }));
}

/** The project matching `name`, else the first project — a safe fallback so a
 *  removed/renamed selection never crashes a picker. Returns an empty project
 *  only when the catalog itself is empty. */
export function findProject(plans: PlanProject[], name: string): PlanProject {
  return plans.find((p) => p.name === name) ?? plans[0] ?? { name: '—', tasks: [] };
}
/** The task matching `taskName` within its project, else that project's first
 *  task — same graceful fallback as findProject. */
export function findTask(plans: PlanProject[], projectName: string, taskName: string): PlanTask {
  const project = findProject(plans, projectName);
  return project.tasks.find((t) => t.name === taskName) ?? project.tasks[0] ?? { name: '—', conditions: [] };
}

const STORAGE_KEY = 'kairos.v2.plans.v1';

function isPlanProject(v: unknown): v is PlanProject {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  if (typeof p.name !== 'string' || !Array.isArray(p.tasks)) return false;
  return p.tasks.every((t) => {
    if (!t || typeof t !== 'object') return false;
    const task = t as Record<string, unknown>;
    return (
      typeof task.name === 'string' &&
      Array.isArray(task.conditions) &&
      task.conditions.every((c) => typeof c === 'string')
    );
  });
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
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isPlanProject)) {
      plansRestoredFromStorage = true;
      return parsed as PlanProject[];
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
export function setPlans(next: PlanProject[]): void {
  currentPlans = next;
  editedThisSession = true;
  // Persist BEFORE claiming the edit is unsynced. The flag is one byte and the
  // catalog is kilobytes, so a full origin fails only the second write — and
  // marking dirty first left that pair inconsistent across a reload: the claim
  // survived, the edit did not, and the next reconcile pushed the SEED catalog
  // over the team's. Only a STORED edit can be re-pushed on a later load.
  if (persist(STORAGE_KEY, JSON.stringify(next))) writeDirty(true);
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
  if (persist(OPERATORS_KEY, JSON.stringify(next))) writeDirty(true);
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
  if (persist(FAIL_REASONS_KEY, JSON.stringify(next))) writeDirty(true);
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
}

// Set while a local edit hasn't been confirmed by the server — it survives a
// reload so an offline edit still wins the next reconcile.
const DIRTY_KEY = 'kairos.v2.plans.dirty.v1';

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

function pushCatalogToServer(): void {
  apiPut<PlansServerResponse>('/plans', {
    projects: getPlans(),
    failure_reasons: getFailReasons(),
    operators: getOperators(),
  })
    .then(() => {
      writeDirty(false);
      setPushFailed(false);
    })
    .catch(() => {
      // Offline / older backend: the dirty flag stays set and the local copy
      // stands; re-pushed on the next edit or page load. Surfaced, not swallowed.
      setPushFailed(true);
    });
}

/** Whether the last attempt to push the shared catalog failed, i.e. the edits
 *  on screen are on this browser only. */
export function getPlansUnsynced(): boolean {
  return pushFailed;
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

/** Adopt the server catalog as-is (no dirty mark, no re-push). An empty list
 *  is honored — an explicitly emptied catalog must not resurrect the seeds. */
function adoptServerPlans(projects: PlanProject[]): void {
  if (!projects.every(isPlanProject)) return; // malformed — local copy stands
  currentPlans = clonePlans(projects);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentPlans));
  } catch {
    /* ignore */
  }
  notify();
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
    window.localStorage.removeItem(FAIL_REASONS_KEY);
    window.localStorage.removeItem(OPERATORS_KEY);
  } catch {
    /* ignore */
  }
  plansSyncStarted = false;
  pushFailed = false;
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
