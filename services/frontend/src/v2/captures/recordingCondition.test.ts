// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { expect, test } from 'vitest';
import type { CaptureListItem } from '../../api/types';
import { resolveCaptureCondition } from './recordingCondition';

function capture(over: Partial<CaptureListItem> = {}): CaptureListItem {
  return {
    capture_id: 'cap-1',
    state: 'completed',
    review_status: 'pending',
    review_revision: 0,
    ...over,
  };
}

test('an immutable snapshot wins over a later Batch label', () => {
  expect(
    resolveCaptureCondition(
      capture({
        collection_context: {
          batch_id: 'batch-a',
          batch_seq: 3,
          project_id: null,
          task_id: null,
          condition_id: null,
          project: null,
          task: null,
          condition: 'Recorded left',
          robot: null,
          operator: null,
        },
      }),
      { status: 'ready', value: 'Current right' },
    ),
  ).toEqual({ status: 'ready', value: 'Recorded left' });
});

test('an explicit empty snapshot never falls back to the current Batch', () => {
  expect(
    resolveCaptureCondition(
      capture({
        collection_context: {
          batch_id: 'batch-a',
          batch_seq: 3,
          project_id: null,
          task_id: null,
          condition_id: null,
          project: null,
          task: null,
          condition: null,
          robot: null,
          operator: null,
        },
      }),
      { status: 'ready', value: 'Current right' },
    ),
  ).toEqual({ status: 'not-recorded', value: null });
});

test('a context-less legacy capture keeps the Batch fallback and its failure state', () => {
  const legacy = capture({ batch_id: 'batch-a' });
  expect(
    resolveCaptureCondition(legacy, { status: 'ready', value: 'Current right' }),
  ).toEqual({
    status: 'ready',
    value: 'Current right',
  });
  expect(resolveCaptureCondition(legacy, { status: 'unavailable' })).toEqual({
    status: 'unavailable',
    value: null,
  });
});
