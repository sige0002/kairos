import { expect, test } from 'vitest';
import { ANY_OPERATOR } from './data';
import { DEFAULT_URL_STATE, readDatasetsUrl, writeDatasetsUrl } from './url';

test('an empty query string reads as the default view', () => {
  expect(readDatasetsUrl('')).toEqual(DEFAULT_URL_STATE);
  expect(readDatasetsUrl('?tab=datasets')).toEqual(DEFAULT_URL_STATE);
});

test('the default view writes NO keys of its own', () => {
  // An untouched tab must leave the URL exactly as it found it — no
  // ?dsq=&dssort=recent noise to share around.
  expect(writeDatasetsUrl('?tab=datasets', DEFAULT_URL_STATE)).toBe('tab=datasets');
});

test('keys this module does not own are preserved', () => {
  const out = writeDatasetsUrl('?tab=datasets&solo=1', {
    ...DEFAULT_URL_STATE,
    task: 'kitchen_pick',
  });
  const p = new URLSearchParams(out);
  expect(p.get('tab')).toBe('datasets');
  expect(p.get('solo')).toBe('1');
  expect(p.get('dstask')).toBe('kitchen_pick');
});

test('a full state round-trips', () => {
  const state = {
    search: 'kitchen',
    episodeSearch: '#12',
    sort: 'alpha' as const,
    taskResultFilter: 'failure' as const,
    operatorFilter: 'op_a',
    task: 'kitchen_pick',
    condition: 'dim',
    datasetDir: 'op_a/kitchen_pick/001',
  };
  expect(readDatasetsUrl(writeDatasetsUrl('?tab=datasets', state))).toEqual(state);
});

test('values needing encoding round-trip (spaces, arrows, slashes)', () => {
  const state = {
    ...DEFAULT_URL_STATE,
    task: 'Pick and Place',
    condition: 'Object: Left → Tray: Center',
    datasetDir: 'data/unknown_operator/Pick and Place/011',
  };
  expect(readDatasetsUrl(writeDatasetsUrl('', state))).toEqual(state);
});

test('a task with a null condition is distinguishable from no selection', () => {
  const selected = { ...DEFAULT_URL_STATE, task: 'shelf_restock', condition: null };
  const written = writeDatasetsUrl('', selected);
  expect(new URLSearchParams(written).has('dscond')).toBe(false);
  expect(readDatasetsUrl(written)).toEqual(selected);
  // ...and that is NOT the same as having selected nothing.
  expect(readDatasetsUrl('').task).toBeNull();
});

test('a condition with no task is ignored rather than half-restored', () => {
  expect(readDatasetsUrl('?dscond=dim')).toEqual(DEFAULT_URL_STATE);
  // The writer never emits one either.
  const written = writeDatasetsUrl('', { ...DEFAULT_URL_STATE, condition: 'dim' });
  expect(new URLSearchParams(written).has('dscond')).toBe(false);
});

test('invalid values fall back to the default instead of being trusted', () => {
  const state = readDatasetsUrl('?dssort=sideways&dsresult=maybe');
  expect(state.sort).toBe('recent');
  expect(state.taskResultFilter).toBe('all');
});

test('an absent operator reads as the any-operator sentinel, and writes as absent', () => {
  expect(readDatasetsUrl('').operatorFilter).toBe(ANY_OPERATOR);
  const written = writeDatasetsUrl('?dsop=op_a', {
    ...DEFAULT_URL_STATE,
    operatorFilter: ANY_OPERATOR,
  });
  expect(new URLSearchParams(written).has('dsop')).toBe(false);
});

test('clearing a field removes its key rather than leaving it empty', () => {
  const written = writeDatasetsUrl('?dsq=kitchen&dsep=op_a/kitchen_pick/001', DEFAULT_URL_STATE);
  expect(written).toBe('');
});
