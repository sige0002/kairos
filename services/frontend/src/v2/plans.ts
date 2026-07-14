// Shared plan catalog (Projects → Tasks → Conditions) for Console v2 — the
// SINGLE source of truth for both the Settings "Projects & tasks" editor and the
// Collect screen's project/task/condition pickers. Previously each screen kept
// its own local copy, so a project added in Settings never appeared in Collect.
//
// A module-level store (same useSyncExternalStore pattern as collect's batch
// store) makes edits reactive across screens and survive a tab-switch unmount;
// it also persists to localStorage (versioned key) so edits survive a reload.
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

function readInitial(): PlanProject[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return clonePlans(DEFAULT_PLANS);
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isPlanProject)) {
      return parsed as PlanProject[];
    }
    return clonePlans(DEFAULT_PLANS);
  } catch {
    return clonePlans(DEFAULT_PLANS);
  }
}

let currentPlans: PlanProject[] = readInitial();
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
  writeDirty(true);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable — the in-memory catalog still works this session.
  }
  notify();
  pushPlansToServer(next);
}

// ---- server sync -----------------------------------------------------------

/** GET/PUT /api/v1/plans response shape (see routers/plans.py). */
interface PlansServerResponse {
  projects: PlanProject[] | null;
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

function pushPlansToServer(projects: PlanProject[]): void {
  apiPut<PlansServerResponse>('/plans', { projects })
    .then(() => writeDirty(false))
    .catch(() => {
      // Offline / older backend: the dirty flag stays set and the local copy
      // stands; re-pushed on the next edit or page load.
    });
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

// Once per page load (module flag) — later mounts are no-ops.
let plansSyncStarted = false;

/** Reconcile the browser-local catalog with the server, once per page load:
 *  never-set server → seed it from this browser; unsynced local edits → push
 *  them; otherwise adopt the server copy. Any failure keeps the local copy. */
export function ensurePlansSynced(): void {
  if (plansSyncStarted) return;
  plansSyncStarted = true;
  apiGet<PlansServerResponse>('/plans')
    .then((resp) => {
      if (!resp || !Array.isArray(resp.projects)) {
        if (resp && resp.projects === null) pushPlansToServer(getPlans());
        return;
      }
      if (readDirty()) {
        pushPlansToServer(getPlans());
        return;
      }
      adoptServerPlans(resp.projects);
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

/** Test-only: reset the catalog + clear its persistence between cases. */
export function __resetPlansStore(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(DIRTY_KEY);
  } catch {
    /* ignore */
  }
  plansSyncStarted = false;
  currentPlans = clonePlans(DEFAULT_PLANS);
  notify();
}

/** Test-only: re-run the storage-restore path after seeding localStorage. */
export function __rehydratePlansStore(): void {
  currentPlans = readInitial();
  notify();
}
