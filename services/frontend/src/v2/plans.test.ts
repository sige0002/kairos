// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { jsonResponse } from '../test/renderWithClient';
import {
  DEFAULT_FAIL_REASONS,
  DEFAULT_PLANS,
  ensurePlansSynced,
  __rehydratePlansStore,
  __resetPlansStore,
  clonePlans,
  findProject,
  findTask,
  getPlansConflict,
  getFailReasons,
  getPlans,
  adoptServerCatalog,
  resolvePlanIds,
  setFailReasons,
  setPlans,
} from './plans';

const KEY = 'kairos.v2.plans.v1';

beforeEach(() => __resetPlansStore());

test('a fresh store holds the default catalog', () => {
  expect(getPlans().map((p) => p.name)).toEqual([
    'Tabletop Manipulation',
    'Bin Picking',
    'Kitchen Mobile',
  ]);
});

test('setPlans updates the snapshot and persists to localStorage', () => {
  const next = clonePlans(getPlans());
  next.push({
    project_id: 'project-warehouse-sort',
    name: 'Warehouse Sort',
    tasks: [
      {
        task_id: 'task-sort-bins',
        name: 'Sort bins',
        conditions: [{ condition_id: 'condition-bin-a', name: 'Bin: A' }],
      },
    ],
  });
  setPlans(next);

  expect(getPlans().some((p) => p.name === 'Warehouse Sort')).toBe(true);
  const persisted = JSON.parse(window.localStorage.getItem(KEY)!) as { name: string }[];
  expect(persisted.some((p) => p.name === 'Warehouse Sort')).toBe(true);
});

test('a persisted catalog is restored on (re)hydration', () => {
  window.localStorage.setItem(
    KEY,
    JSON.stringify([{ name: 'Saved', tasks: [{ name: 'S', conditions: ['x'] }] }]),
  );
  __rehydratePlansStore();
  expect(getPlans()[0]).toMatchObject({
    name: 'Saved',
    tasks: [{ name: 'S', conditions: [{ name: 'x' }] }],
  });
});

test('a corrupt persisted catalog is ignored, falling back to defaults', () => {
  window.localStorage.setItem(KEY, JSON.stringify([{ name: 5, tasks: 'nope' }]));
  __rehydratePlansStore();
  expect(getPlans().map((p) => p.name)).toEqual(DEFAULT_PLANS.map((p) => p.name));
});

test('findProject / findTask fall back gracefully (never throw)', () => {
  const plans = getPlans();
  // Unknown names resolve to the first available project/task.
  expect(findProject(plans, 'nope').name).toBe(plans[0]!.name);
  expect(findTask(plans, 'nope', 'nope').name).toBe(plans[0]!.tasks[0]!.name);
  // An empty catalog yields an empty placeholder rather than crashing.
  expect(findProject([], 'x')).toMatchObject({ name: '—', tasks: [] });
  expect(findTask([], 'x', 'y')).toMatchObject({ name: '—', conditions: [] });
});

test('a rename mutation (via setPlans) replaces the stored value', () => {
  const next = clonePlans(getPlans());
  next[0]!.name = 'Renamed Project';
  setPlans(next);
  expect(getPlans()[0]!.name).toBe('Renamed Project');
  expect(findProject(getPlans(), 'Renamed Project').tasks.length).toBeGreaterThan(0);
});

test('removing a project (via setPlans) drops it and persists the rest', () => {
  const next = clonePlans(getPlans()).filter((p) => p.name !== 'Bin Picking');
  setPlans(next);
  expect(getPlans().some((p) => p.name === 'Bin Picking')).toBe(false);
  const persisted = JSON.parse(window.localStorage.getItem(KEY)!) as { name: string }[];
  expect(persisted.some((p) => p.name === 'Bin Picking')).toBe(false);
});

test('an explicitly empty catalog persists across a reload', () => {
  // Why the Settings editor blocks removing the LAST project: setPlans([]) does
  // write an empty array this session, but readInitial() treats a zero-length
  // catalog as absent and restores the seed, so an all-deleted catalog would
  // silently reappear on reload (and the editor reads plans[idx].name, which an
  // empty catalog would crash). Blocking the last removal is the honest fix.
  setPlans([]);
  expect(getPlans()).toEqual([]);
  __rehydratePlansStore();
  expect(getPlans()).toEqual([]);
});

// ---------------------------------------------------------------------------
// Server sync (GET/PUT /api/v1/plans): seed / adopt / dirty-edit contract.
// ---------------------------------------------------------------------------

interface PutCall {
  base_revision: number;
  projects: { name: string }[];
  operators?: string[];
  failure_reasons?: string[];
}

function mockPlansFetch(getBody: unknown, opts: { putFails?: boolean } = {}) {
  const puts: PutCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/plans') && method === 'GET') {
      const body = getBody as { projects?: unknown } | null;
      return Promise.resolve(
        jsonResponse({ revision: Array.isArray(body?.projects) ? 1 : 0, ...body }),
      );
    }
    if (url.includes('/plans') && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as PutCall;
      puts.push(body);
      if (opts.putFails) {
        return Promise.resolve(jsonResponse({ error: { code: 'io', message: 'down' } }, 500));
      }
      return Promise.resolve(
        jsonResponse({ ...body, updated_at: 't1', revision: body.base_revision + 1 }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  return puts;
}

afterEach(() => vi.restoreAllMocks());

test('a never-set server catalog is seeded from this browser', async () => {
  const puts = mockPlansFetch({ projects: null, updated_at: null });
  ensurePlansSynced();
  await vi.waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]!.projects.map((p) => p.name)).toEqual(DEFAULT_PLANS.map((p) => p.name));
});

test('the server catalog is adopted when no local edits are unsynced', async () => {
  const server = [{ name: 'Server Project', tasks: [{ name: 'T', conditions: ['C'] }] }];
  const puts = mockPlansFetch({
    projects: server,
    failure_reasons: ['Server reason'],
    operators: [],
    updated_at: 't0',
  });
  ensurePlansSynced();
  await vi.waitFor(() => expect(getPlans()[0]?.name).toBe('Server Project'));
  // Adopted (both halves), persisted, and NOT pushed back.
  expect(getFailReasons()).toEqual(['Server reason']);
  expect(JSON.parse(window.localStorage.getItem(KEY)!)).toMatchObject([
    { name: 'Server Project', tasks: [{ name: 'T', conditions: [{ name: 'C' }] }] },
  ]);
  expect(puts).toHaveLength(0);
});

test('an explicitly emptied server catalog is honored (no re-seed)', async () => {
  mockPlansFetch({ projects: [], updated_at: 't0' });
  ensurePlansSynced();
  await vi.waitFor(() => expect(getPlans()).toEqual([]));
});

test('unsynced local edits win the reconcile and are pushed', async () => {
  // A real offline edit leaves BOTH behind: the edited catalog in storage and
  // the dirty flag. (The flag on its own, with nothing restored and nothing
  // edited this session, is the corrupt/failed-write case further down — that
  // one must NOT push, so this setup has to be the genuine article.)
  const local = clonePlans(getPlans());
  local[0]!.name = 'Offline rename';
  window.localStorage.setItem(KEY, JSON.stringify(local));
  window.localStorage.setItem('kairos.v2.plans.dirty.v1', '1');
  __rehydratePlansStore();
  const puts = mockPlansFetch({
    projects: [{ name: 'Server Project', tasks: [] }],
    updated_at: 't0',
  });
  ensurePlansSynced();
  await vi.waitFor(() => expect(puts).toHaveLength(1));
  // The local catalog stands (server copy NOT adopted over the dirty edit) …
  expect(getPlans()).toEqual(local);
  // … and the successful push cleared the dirty flag.
  await vi.waitFor(() =>
    expect(window.localStorage.getItem('kairos.v2.plans.dirty.v1')).toBeNull(),
  );
});

test('a failed push keeps the dirty flag so the edit retries later', async () => {
  const puts = mockPlansFetch({ projects: null, updated_at: null }, { putFails: true });
  const next = clonePlans(getPlans());
  next[0]!.name = 'Offline Edit';
  setPlans(next);
  await vi.waitFor(() => expect(puts).toHaveLength(1));
  expect(window.localStorage.getItem('kairos.v2.plans.dirty.v1')).toBe('1');
  expect(getPlans()[0]!.name).toBe('Offline Edit'); // the edit itself is kept
});

test('a 409 keeps the local draft and only an explicit server adopt clears it', async () => {
  const server = [
    { project_id: 'server-p', name: 'Server project', tasks: [] },
  ];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (String(input).includes('/plans') && method === 'PUT') {
      return Promise.resolve(
        jsonResponse(
          { error: { code: 'plans_conflict', message: 'changed elsewhere' } },
          409,
        ),
      );
    }
    return Promise.resolve(jsonResponse({ projects: server, revision: 3, updated_at: 't3' }));
  });
  const local = clonePlans(getPlans());
  local[0]!.name = 'Local draft';
  setPlans(local);
  await vi.waitFor(() => expect(getPlansConflict()).toBe(true));
  expect(getPlans()[0]!.name).toBe('Local draft');
  adoptServerCatalog();
  await vi.waitFor(() => expect(getPlansConflict()).toBe(false));
  expect(getPlans()[0]!.name).toBe('Server project');
});

test('a response for an older generation cannot clear a newer dirty edit', async () => {
  const resolvers: ((response: Response) => void)[] = [];
  const bodies: PutCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as PutCall);
    return new Promise<Response>((resolve) => resolvers.push(resolve));
  });
  const first = clonePlans(getPlans());
  first[0]!.name = 'First';
  setPlans(first);
  const second = clonePlans(first);
  second[0]!.name = 'Second';
  setPlans(second);
  await vi.waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]!.base_revision).toBe(0);
  resolvers.shift()!(jsonResponse({ revision: 1, updated_at: 't1' }));
  await vi.waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies[1]!.base_revision).toBe(1);
  resolvers.shift()!(jsonResponse({ revision: 2, updated_at: 't2' }));
  await vi.waitFor(() =>
    expect(window.localStorage.getItem('kairos.v2.plans.dirty.v1')).toBeNull(),
  );
  expect(getPlans()[0]!.name).toBe('Second');
});

test('legacy local storage receives deterministic IDs and labels resolve without guessing customs', () => {
  window.localStorage.setItem(
    KEY,
    JSON.stringify([{ name: 'P', tasks: [{ name: 'T', conditions: ['C'] }] }]),
  );
  __rehydratePlansStore();
  const plans = getPlans();
  const first = resolvePlanIds(plans, 'P', 'T', 'C');
  expect(first.project_id).toMatch(/^legacy-project-/);
  expect(first.task_id).toMatch(/^legacy-task-/);
  expect(first.condition_id).toMatch(/^legacy-condition-/);
  expect(resolvePlanIds(plans, 'P', 'custom task', 'C')).toEqual({
    project_id: first.project_id,
    task_id: null,
    condition_id: null,
  });
});

// ---------------------------------------------------------------------------
// Failure-reason vocabulary (the Collect "What failed?" chips).
// ---------------------------------------------------------------------------

test('a fresh store holds the default fail-reason vocabulary', () => {
  expect(getFailReasons()).toEqual(DEFAULT_FAIL_REASONS);
});

test('setFailReasons updates the snapshot and persists to localStorage', () => {
  setFailReasons(['Grasp missed', 'Cable snagged']);
  expect(getFailReasons()).toEqual(['Grasp missed', 'Cable snagged']);
  const persisted = JSON.parse(
    window.localStorage.getItem('kairos.v2.failreasons.v1')!,
  ) as string[];
  expect(persisted).toEqual(['Grasp missed', 'Cable snagged']);
});

test('an empty fail-reason replacement is refused (Failure needs a reason)', () => {
  setFailReasons([]);
  expect(getFailReasons()).toEqual(DEFAULT_FAIL_REASONS);
});

test('a never-set server vocabulary is seeded from this browser', async () => {
  const puts = mockPlansFetch({
    projects: [{ name: 'P', tasks: [] }],
    failure_reasons: null,
    updated_at: 't0',
  });
  ensurePlansSynced();
  await vi.waitFor(() => expect(puts).toHaveLength(1));
  expect(
    (puts[0] as unknown as { failure_reasons: string[] }).failure_reasons,
  ).toEqual(DEFAULT_FAIL_REASONS);
  // The projects half was still adopted, not clobbered by the seed push.
  expect(getPlans()).toMatchObject([{ name: 'P', tasks: [] }]);
});

test('an EMPTY server vocabulary is neither adopted nor re-pushed', async () => {
  const puts = mockPlansFetch({
    projects: [{ name: 'P', tasks: [] }],
    failure_reasons: [],
    operators: [],
    updated_at: 't0',
  });
  ensurePlansSynced();
  await vi.waitFor(() => expect(getPlans()).toMatchObject([{ name: 'P', tasks: [] }]));
  expect(getFailReasons()).toEqual(DEFAULT_FAIL_REASONS); // local copy stands
  expect(puts).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Old / corrupt / unavailable localStorage. Every read here is best-effort, so
// the interesting question is not "does it throw" but what the store CLAIMS
// afterwards: the dirty flag is a promise that this browser is holding an edit
// the server has not seen, and acting on that promise when the edit is gone
// pushes the SEED catalog over the team's real one.
// ---------------------------------------------------------------------------

const DIRTY = 'kairos.v2.plans.dirty.v1';

/** A server holding the team's real, curated catalog. */
const TEAM_CATALOG = [
  { name: 'Team Catalog', tasks: [{ name: 'Curated', conditions: ['by hand'] }] },
];
const TEAM_SERVER = {
  projects: TEAM_CATALOG,
  failure_reasons: ['Team reason'],
  operators: ['yuki'],
  updated_at: 't0',
};

/** Make writes to ONE key fail while the rest of storage keeps working — the
 *  asymmetry a full origin produces (the catalog is kilobytes, the dirty flag
 *  is one byte) and the shape private mode has historically taken. */
function failWritesTo(key: string) {
  const real = window.localStorage.setItem.bind(window.localStorage);
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k: string, v: string) => {
    if (k === key) throw new DOMException('exceeded the quota', 'QuotaExceededError');
    real(k, v);
  });
}

/** What each push would put on the server, across ALL THREE shared vocabularies.
 *  Asserted instead of a bare count so a failure says WHAT went over the wire —
 *  "it pushed" and "it pushed the factory seeds, a blank roster and the default
 *  reasons over the team's three curated lists" are very different findings. */
function pushedVocabularies(puts: PutCall[]): unknown[] {
  return puts.map((p) => ({
    projects: p.projects.map((x) => x.name),
    operators: p.operators,
    failure_reasons: p.failure_reasons,
  }));
}

test('a catalog write that fails leaves no dirty claim behind (write ORDER)', async () => {
  // Entry condition 1: a full origin. The flag is one byte and the catalog is
  // kilobytes, so the second write is the one that fails. Marking dirty first
  // created the inconsistent pair at the source; the setter now persists first
  // and only claims the edit if it actually landed.
  const storageSpy = failWritesTo(KEY);
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(jsonResponse({ error: { code: 'io', message: 'down' } }, 500)),
  );
  const edited = clonePlans(getPlans());
  edited[0]!.name = 'Edited offline';
  setPlans(edited);

  // The edit applies to this session but was not stored — so nothing may claim
  // that a later load could re-push it.
  expect(getPlans()[0]!.name).toBe('Edited offline');
  expect(window.localStorage.getItem(KEY)).toBeNull();
  expect(window.localStorage.getItem(DIRTY)).toBeNull();
  storageSpy.mockRestore();
  vi.restoreAllMocks();

  // And on the next load the team's catalog simply wins.
  const puts = mockPlansFetch(TEAM_SERVER);
  __rehydratePlansStore();
  ensurePlansSynced();
  await vi.waitFor(() => expect(getPlans()[0]).toMatchObject({ name: 'Team Catalog' }));
  expect(pushedVocabularies(puts)).toEqual([]);
});

test('a corrupt stored catalog does not push the seeds over the server', async () => {
  // Entry condition 2, which the write order cannot close: the value was stored
  // fine and went bad afterwards (a crash mid-write, a partial eviction). The
  // flag is legitimately set from the earlier successful edit.
  window.localStorage.setItem(KEY, '[{"name":"Half wri');
  window.localStorage.setItem(DIRTY, '1');
  const puts = mockPlansFetch(TEAM_SERVER);
  __rehydratePlansStore();
  ensurePlansSynced();

  // Settle on a condition true either way — the flag ends up cleared whether it
  // was dropped as stale or cleared by a "successful" push — so the PUT is
  // asserted FIRST and a regression prints what it destroyed.
  await vi.waitFor(() => expect(window.localStorage.getItem(DIRTY)).toBeNull());
  expect(pushedVocabularies(puts)).toEqual([]);
  await vi.waitFor(() => expect(getPlans()[0]).toMatchObject({ name: 'Team Catalog' }));
});

test('a catalog from an OLDER schema does not push the seeds over the server', async () => {
  // Entry condition 3, also beyond the write order: v0 stored tasks as bare
  // strings, before conditions existed. isPlanProject rejects it, so the store
  // falls back to the seeds — and must not then claim those seeds as an edit.
  window.localStorage.setItem(
    KEY,
    JSON.stringify([{ name: 'Old Schema', tasks: ['Pick and Place', 'Stacking'] }]),
  );
  window.localStorage.setItem(DIRTY, '1');
  const puts = mockPlansFetch(TEAM_SERVER);
  __rehydratePlansStore();
  ensurePlansSynced();

  await vi.waitFor(() => expect(window.localStorage.getItem(DIRTY)).toBeNull());
  expect(pushedVocabularies(puts)).toEqual([]);
  await vi.waitFor(() => expect(getPlans()[0]).toMatchObject({ name: 'Team Catalog' }));
  expect(getPlans().some((p) => p.name === 'Old Schema')).toBe(false);
});

test('a RESTORED catalog with a dirty flag still pushes (the guard is not a mute)', async () => {
  // The case the dirty flag exists for: the edit persisted, the push failed.
  // That claim is backed by something, so it must still reach the server.
  window.localStorage.setItem(
    KEY,
    JSON.stringify([{ name: 'Real offline edit', tasks: [{ name: 'T', conditions: [] }] }]),
  );
  window.localStorage.setItem(DIRTY, '1');
  const puts = mockPlansFetch(TEAM_SERVER);
  __rehydratePlansStore();
  ensurePlansSynced();

  await vi.waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]!.projects.map((p) => p.name)).toEqual(['Real offline edit']);
  expect(getPlans()[0]!.name).toBe('Real offline edit'); // server copy not adopted over it
});

test('an edit made while the reconcile is in flight is kept, not overwritten', async () => {
  // A first-ever browser (empty storage) whose GET is still in flight when the
  // operator edits. Nothing was RESTORED, but the edit is real and in memory —
  // the guard must not mistake it for a stale claim and adopt the server copy
  // over it. The GET is held open so the ordering is the scenario's, not the
  // scheduler's: waiting on the first push alone would pass either way, since
  // setPlans pushes on its own before the reconcile ever looks at the flag.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const puts: PutCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
      puts.push(JSON.parse(String(init?.body)) as PutCall);
      // Failing push: the dirty flag stays set, which is what the reconcile
      // then has to judge.
      return Promise.resolve(jsonResponse({ error: { code: 'io', message: 'down' } }, 500));
    }
    return gate.then(() => jsonResponse(TEAM_SERVER));
  });

  ensurePlansSynced();
  const edited = clonePlans(getPlans());
  edited[0]!.name = 'Edited before the sync landed';
  setPlans(edited);
  release();

  // The reconcile finds the flag, sees a real in-session edit behind it, and
  // re-pushes rather than adopting the server copy over the operator's work.
  await vi.waitFor(() => expect(puts.length).toBeGreaterThanOrEqual(1));
  expect(getPlans()[0]!.name).toBe('Edited before the sync landed');
  expect(puts.some((p) => p.projects.some((x) => x.name === 'Edited before the sync landed'))).toBe(
    true,
  );
});

test('storage that THROWS on every access leaves the store usable', () => {
  // Private mode / storage blocked by policy: access itself throws rather than
  // returning null. Reads AND writes have to survive it — the store is imported
  // by every screen, so a throw here is a whole-console outage, not a Settings
  // one.
  const boom = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom);

  expect(() => __rehydratePlansStore()).not.toThrow();
  expect(getPlans().map((p) => p.name)).toEqual(DEFAULT_PLANS.map((p) => p.name));
  // And an edit still works for the session, it just cannot be persisted.
  const next = clonePlans(getPlans());
  next[0]!.name = 'Incognito edit';
  expect(() => setPlans(next)).not.toThrow();
  expect(getPlans()[0]!.name).toBe('Incognito edit');
  expect(() => setFailReasons(['Only reason'])).not.toThrow();
  expect(() => __resetPlansStore()).not.toThrow();
});

test('the module survives being IMPORTED with storage that throws', async () => {
  // The worst case, and the reason this is worth its own test: the reads above
  // run at module scope, and every screen imports this store. A throw there
  // happens while the bundle is evaluating — before React exists — so the root
  // ErrorBoundary cannot catch it and the page is blank with no error card at
  // all, rather than a broken Settings tab.
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
  vi.resetModules();

  const fresh = await import('./plans');
  expect(fresh.getPlans().map((p) => p.name)).toEqual(DEFAULT_PLANS.map((p) => p.name));
  expect(fresh.getFailReasons()).toEqual(DEFAULT_FAIL_REASONS);
  expect(fresh.getOperators()).toEqual([]);
});
