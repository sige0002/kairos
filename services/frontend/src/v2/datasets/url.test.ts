// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
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
    datasetId: 'ds-01930000-0000-7000-8000-000000000001',
  });
  const p = new URLSearchParams(out);
  expect(p.get('tab')).toBe('datasets');
  expect(p.get('solo')).toBe('1');
  expect(p.get('dsid')).toBe('ds-01930000-0000-7000-8000-000000000001');
});

test('a full state round-trips', () => {
  const state = {
    search: 'kitchen',
    memberSearch: '#12',
    sort: 'alpha' as const,
    taskResultFilter: 'failure' as const,
    operatorFilter: 'op_a',
    view: 'archived' as const,
    datasetId: 'ds-1',
    membershipId: 'm-7',
  };
  expect(readDatasetsUrl(writeDatasetsUrl('?tab=datasets', state))).toEqual(state);
});

test('values needing encoding round-trip (spaces, arrows, slashes)', () => {
  const state = {
    ...DEFAULT_URL_STATE,
    search: 'Object: Left → Tray: Center',
    memberSearch: 'Pick and Place / retry',
    operatorFilter: 'Ops Team A',
  };
  expect(readDatasetsUrl(writeDatasetsUrl('', state))).toEqual(state);
});

test('a dataset with no member selected is distinguishable from no selection', () => {
  const selected = { ...DEFAULT_URL_STATE, datasetId: 'ds-1', membershipId: null };
  const written = writeDatasetsUrl('', selected);
  expect(new URLSearchParams(written).has('dsmem')).toBe(false);
  expect(readDatasetsUrl(written)).toEqual(selected);
  // ...and that is NOT the same as having selected nothing.
  expect(readDatasetsUrl('').datasetId).toBeNull();
});

test('a membership with no dataset is ignored rather than half-restored', () => {
  expect(readDatasetsUrl('?dsmem=m-7')).toEqual(DEFAULT_URL_STATE);
  // The writer never emits one either.
  const written = writeDatasetsUrl('', { ...DEFAULT_URL_STATE, membershipId: 'm-7' });
  expect(new URLSearchParams(written).has('dsmem')).toBe(false);
});

test('the addressable identities are ids, never a directory path', () => {
  // §6 retired `dataset_dir`; nothing this module writes may reintroduce it as
  // a de-facto identity through the query string.
  const written = writeDatasetsUrl('', {
    ...DEFAULT_URL_STATE,
    datasetId: 'ds-1',
    membershipId: 'm-7',
  });
  const keys = [...new URLSearchParams(written).keys()];
  expect(keys).toEqual(['dsid', 'dsmem']);
  expect(written).not.toContain('dataset_dir');
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
  const written = writeDatasetsUrl('?dsq=kitchen&dsid=ds-1&dsmem=m-7', DEFAULT_URL_STATE);
  expect(written).toBe('');
});
