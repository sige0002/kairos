// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { expect, test } from 'vitest';
import { mapCapturesToEpisodes } from './mapCaptures';
import type { CaptureListItem, CaptureState } from '../../api/types';

function capture(partial: Partial<CaptureListItem> & { capture_id: string }): CaptureListItem {
  return {
    state: 'completed',
    review_status: 'pending',
    review_revision: 0,
    ...partial,
  };
}

test('only finished captures are reviewable', () => {
  // Nothing to review until a recording has finished one way or another, and
  // nothing to decide once it is gone.
  const states: CaptureState[] = [
    'recording',
    'stopping',
    'completed',
    'interrupted',
    'failed',
    'delete_pending',
    'discarded',
    'deleted',
  ];
  const rows = mapCapturesToEpisodes(
    states.map((state, i) => capture({ capture_id: `c${i}`, state })),
  );
  expect(rows.map((r) => r.state).sort()).toEqual(
    ['completed', 'failed', 'interrupted'].sort(),
  );
});

test('a capture that did not finish cleanly is Not usable whatever its review says', () => {
  // The backend's verdict about whether the recording completed always wins: no
  // label an operator applies can make an incomplete bag usable.
  const rows = mapCapturesToEpisodes([
    capture({
      capture_id: 'c1',
      state: 'interrupted',
      quality: 'good',
      task_result: 'success',
      review_status: 'adopted',
    }),
  ]);
  expect(rows[0]!.quality).toBe('Not usable');
  expect(rows[0]!.task).toBeNull();
  expect(rows[0]!.issues).toBe('Recording did not complete cleanly');
});

test('review fields come straight off the capture', () => {
  const rows = mapCapturesToEpisodes([
    capture({
      capture_id: 'c1',
      quality: 'needs_review',
      task_result: 'failure',
      failure_reason: 'gripper slipped',
      review_status: 'excluded',
      review_revision: 4,
    }),
  ]);
  expect(rows[0]).toMatchObject({
    quality: 'Needs review',
    task: 'Failure',
    failReason: 'gripper slipped',
    reviewStatus: 'excluded',
    reviewRevision: 4,
  });
});

test('an unreviewed capture leaves quality and task unset rather than guessing', () => {
  const rows = mapCapturesToEpisodes([capture({ capture_id: 'c1' })]);
  expect(rows[0]!.quality).toBeNull();
  expect(rows[0]!.task).toBeNull();
  expect(rows[0]!.reviewRevision).toBe(0);
});

test('the episode number is the server index, so a neighbour leaving cannot renumber it', () => {
  const rows = mapCapturesToEpisodes([
    capture({ capture_id: 'a', started_at: '2026-08-01T10:00:00Z', index_in_batch: 7 }),
    capture({ capture_id: 'b', started_at: '2026-08-01T11:00:00Z', index_in_batch: 9 }),
  ]);
  expect(rows.map((r) => r.ep)).toEqual([7, 9]);
});

test('a capture with no server index has no episode number at all', () => {
  // The position in the list is not an episode number: the server never issued
  // it. A row without one carries null and renders "—", like every other
  // unknown on this screen.
  const rows = mapCapturesToEpisodes([
    capture({ capture_id: 'b', started_at: '2026-08-01T11:00:00Z' }),
    capture({ capture_id: 'a', started_at: '2026-08-01T10:00:00Z' }),
  ]);
  expect(rows.map((r) => r.captureId)).toEqual(['a', 'b']);
  expect(rows.map((r) => r.ep)).toEqual([null, null]);
});

test('an invented number cannot collide with a real index_in_batch', () => {
  // The positional fallback numbered the first row #1 — which is exactly the
  // index the server had already handed to another capture in the same view.
  // Two rows then showed "#1" and neither looked wrong.
  const rows = mapCapturesToEpisodes([
    capture({ capture_id: 'no-index', started_at: '2026-08-01T10:00:00Z' }),
    capture({
      capture_id: 'indexed',
      started_at: '2026-08-01T11:00:00Z',
      index_in_batch: 1,
    }),
  ]);
  expect(rows.map((r) => r.ep)).toEqual([null, 1]);
  const numbered = rows.map((r) => r.ep).filter((ep) => ep !== null);
  expect(new Set(numbered).size).toBe(numbered.length);
});

test('rows still order by started_at, which never depended on the episode number', () => {
  // Dropping the fallback must not touch the reading order: the sort key is the
  // recording time, and a row with no number sorts by it like any other.
  const rows = mapCapturesToEpisodes([
    capture({ capture_id: 'mid', started_at: '2026-08-01T11:00:00Z', index_in_batch: 9 }),
    capture({ capture_id: 'first', started_at: '2026-08-01T10:00:00Z' }),
    capture({ capture_id: 'last', started_at: '2026-08-01T12:00:00Z', index_in_batch: 2 }),
  ]);
  expect(rows.map((r) => r.captureId)).toEqual(['first', 'mid', 'last']);
  expect(rows.map((r) => r.ep)).toEqual([null, 9, 2]);
});

test('captures without a started_at order by capture_id, which is time-ordered', () => {
  // capture_id is UUIDv7, so its lexical order is its creation order — a real
  // fallback rather than an arbitrary one.
  const rows = mapCapturesToEpisodes([
    capture({ capture_id: '01920000-0000-7000-8000-00000000000b' }),
    capture({ capture_id: '01920000-0000-7000-8000-00000000000a' }),
  ]);
  expect(rows.map((r) => r.captureId)).toEqual([
    '01920000-0000-7000-8000-00000000000a',
    '01920000-0000-7000-8000-00000000000b',
  ]);
});

test('the batch label needs a loaded batch; without one it says "—"', () => {
  const rows = mapCapturesToEpisodes([
    capture({ capture_id: 'c1', batch_id: 'batch_1' }),
  ]);
  expect(rows[0]!.batch).toBe('—');
  expect(rows[0]!.batchId).toBe('batch_1');

  const labelled = mapCapturesToEpisodes(
    [capture({ capture_id: 'c1', batch_id: 'batch_1' })],
    () => ({ seq: 3, createdAt: '2026-07-13T09:00:00Z' }),
  );
  expect(labelled[0]!.batch).toBe('07/13 · #3');
  expect(labelled[0]!.condition).toBeNull();

  const withCondition = mapCapturesToEpisodes(
    [capture({ capture_id: "c1", batch_id: "batch_1" })],
    () => ({
      seq: 3,
      createdAt: "2026-07-13T09:00:00Z",
      condition: "Object: left bin",
    }),
  );
  expect(withCondition[0]!.condition).toBe("Object: left bin");
});

test('run_id is carried for display and is never required', () => {
  const rows = mapCapturesToEpisodes([
    capture({ capture_id: 'c1', run_id: 'run_20260801_100000' }),
    capture({ capture_id: 'c2' }),
  ]);
  expect(rows.map((r) => r.runId)).toEqual(['run_20260801_100000', null]);
});

test('a capture with no local replica still maps, and says its copy is awaited', () => {
  // Split deploy: review-before-bytes is the intended order, so this must be a
  // renderable row rather than an error.
  const rows = mapCapturesToEpisodes([
    capture({ capture_id: 'c1', replica: null, quality: 'good' }),
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.transfer).toBe('awaiting');
  expect(rows[0]!.quality).toBe('Good');
});

test('duration is derived from the real timestamps, and stays unset when it cannot be', () => {
  const rows = mapCapturesToEpisodes([
    capture({
      capture_id: 'c1',
      started_at: '2026-08-01T10:00:00Z',
      ended_at: '2026-08-01T10:00:30Z',
    }),
    capture({ capture_id: 'c2', started_at: '2026-08-01T10:00:00Z', ended_at: null }),
  ]);
  expect(rows[0]!.durationMs).toBe(30_000);
  expect(rows[1]!.durationMs).toBeUndefined();
});
