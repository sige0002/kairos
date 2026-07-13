import { beforeEach, expect, test } from 'vitest';
import {
  DEFAULT_PLANS,
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
