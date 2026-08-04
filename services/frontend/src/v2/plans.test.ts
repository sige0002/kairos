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
  getFailReasons,
  getPlans,
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
  next.push({ name: 'Warehouse Sort', tasks: [{ name: 'Sort bins', conditions: ['Bin: A'] }] });
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
  expect(getPlans()).toEqual([{ name: 'Saved', tasks: [{ name: 'S', conditions: ['x'] }] }]);
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
  expect(findProject([], 'x')).toEqual({ name: '—', tasks: [] });
  expect(findTask([], 'x', 'y')).toEqual({ name: '—', conditions: [] });
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

test('an empty catalog is not persisted — a reload restores the defaults', () => {
  // Why the Settings editor blocks removing the LAST project: setPlans([]) does
  // write an empty array this session, but readInitial() treats a zero-length
  // catalog as absent and restores the seed, so an all-deleted catalog would
  // silently reappear on reload (and the editor reads plans[idx].name, which an
  // empty catalog would crash). Blocking the last removal is the honest fix.
  setPlans([]);
  expect(getPlans()).toEqual([]);
  __rehydratePlansStore();
  expect(getPlans().map((p) => p.name)).toEqual(DEFAULT_PLANS.map((p) => p.name));
});

// ---------------------------------------------------------------------------
// Server sync (GET/PUT /api/v1/plans): seed / adopt / dirty-edit contract.
// ---------------------------------------------------------------------------

interface PutCall {
  projects: { name: string }[];
}

function mockPlansFetch(getBody: unknown, opts: { putFails?: boolean } = {}) {
  const puts: PutCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/plans') && method === 'GET') {
      return Promise.resolve(jsonResponse(getBody));
    }
    if (url.includes('/plans') && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as PutCall;
      puts.push(body);
      if (opts.putFails) {
        return Promise.resolve(jsonResponse({ error: { code: 'io', message: 'down' } }, 500));
      }
      return Promise.resolve(jsonResponse({ ...body, updated_at: 't1' }));
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
  expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual(server);
  expect(puts).toHaveLength(0);
});

test('an explicitly emptied server catalog is honored (no re-seed)', async () => {
  mockPlansFetch({ projects: [], updated_at: 't0' });
  ensurePlansSynced();
  await vi.waitFor(() => expect(getPlans()).toEqual([]));
});

test('unsynced local edits win the reconcile and are pushed', async () => {
  window.localStorage.setItem('kairos.v2.plans.dirty.v1', '1');
  const local = getPlans();
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
  expect(getPlans()).toEqual([{ name: 'P', tasks: [] }]);
});

test('an EMPTY server vocabulary is neither adopted nor re-pushed', async () => {
  const puts = mockPlansFetch({
    projects: [{ name: 'P', tasks: [] }],
    failure_reasons: [],
    operators: [],
    updated_at: 't0',
  });
  ensurePlansSynced();
  await vi.waitFor(() => expect(getPlans()).toEqual([{ name: 'P', tasks: [] }]));
  expect(getFailReasons()).toEqual(DEFAULT_FAIL_REASONS); // local copy stands
  expect(puts).toHaveLength(0);
});
