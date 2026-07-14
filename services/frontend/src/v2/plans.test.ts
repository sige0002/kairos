import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { jsonResponse } from '../test/renderWithClient';
import {
  DEFAULT_PLANS,
  ensurePlansSynced,
  __rehydratePlansStore,
  __resetPlansStore,
  clonePlans,
  findProject,
  findTask,
  getPlans,
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
  const puts = mockPlansFetch({ projects: server, updated_at: 't0' });
  ensurePlansSynced();
  await vi.waitFor(() => expect(getPlans()[0]?.name).toBe('Server Project'));
  // Adopted, persisted, and NOT pushed back.
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
