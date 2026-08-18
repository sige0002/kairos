// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Editing a capture's operator / task / robot from Review.
//
// The case that motivates it: an imported bag arrives with all three unset —
// the recorder stamps them on a take it started, nothing stamps them on a
// directory that came from somewhere else — so until now such a capture stayed
// unlabelled for good, and invisible to every operator/task filter.
//
// The three ride the SAME compare-and-swap save as the rest of the review, so
// these tests also pin that a refused edit stays refused: nothing on screen may
// claim a label that the server did not take (§12).

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { setSplitMode } from '../captures/splitMode';
import { setFiltersCollapsed } from './filtersRail';
import { ReviewScreen } from './ReviewScreen';
import type { Capture } from '../../api/types';

const FILTERS_KEY = 'kairos.v2.review.filtersCollapsed.v1';
const IMPORTED = 'cap_imported';

const CONFIG_OPTIONS = {
  active_robot: 'airoa_hsr',
  robots: [],
  aspects: {
    recording: { active: 'default', options: [] },
    stream: { active: 'default', options: [] },
    validation: { active: 'default', options: [] },
    validators: { active: 'default', options: [] },
  },
};

function capture(partial: Partial<Capture> & { capture_id: string }): Capture {
  return {
    state: 'completed',
    review_status: 'pending',
    review_revision: 3,
    // Present and verified, so the inspection (and with it the label rows)
    // renders rather than the "no local copy" placeholder.
    replica: { instance_id: 'inst', state: 'present_verified' },
    digest_state: 'complete',
    topics: [],
    ...partial,
  };
}

/** An imported bag: a run_id with the import prefix and not one label set. */
const importedBag = () =>
  capture({ capture_id: IMPORTED, run_id: 'imported_20260807_101500' });

function mockApi(
  initial: Capture[],
  options: { reviewError?: { status: number; code: string; message: string } } = {},
) {
  const items = initial.map((c) => ({ ...c }));
  const reviewCalls: { captureId: string; body: Record<string, unknown> }[] = [];

  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};

    if (method === 'PATCH' && url.includes('/review')) {
      const id = decodeURIComponent(url.match(/\/captures\/([^/?]+)\/review/)![1]!);
      reviewCalls.push({ captureId: id, body });
      if (options.reviewError) {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: options.reviewError.code,
                message: options.reviewError.message,
              },
            },
            options.reviewError.status,
          ),
        );
      }
      const idx = items.findIndex((c) => c.capture_id === id);
      items[idx] = {
        ...items[idx]!,
        ...(body as Partial<Capture>),
        review_revision: items[idx]!.review_revision + 1,
      } as Capture;
      return Promise.resolve(jsonResponse(items[idx]!));
    }

    const detail = url.match(/\/captures\/([^/?]+)$/);
    if (method === 'GET' && detail) {
      const id = decodeURIComponent(detail[1]!);
      return Promise.resolve(
        jsonResponse(items.find((c) => c.capture_id === id) ?? capture({ capture_id: id })),
      );
    }
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(CONFIG_OPTIONS));
    if (url.includes('/transfer/status'))
      return Promise.resolve(jsonResponse({ available: false }));
    if (url.includes('/retention'))
      return Promise.resolve(jsonResponse({ days: 0, candidates: [], total_bytes: 0 }));
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [...items], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
  return { reviewCalls };
}

beforeEach(() => {
  setApiBase('/api/v1');
  useUiStore.setState({ activeTab: '', pendingRun: null });
  setFiltersCollapsed(false);
  setSplitMode(false);
  window.localStorage.removeItem(FILTERS_KEY);
});
afterEach(() => {
  vi.restoreAllMocks();
  setSplitMode(false);
  setFiltersCollapsed(false);
  window.localStorage.removeItem(FILTERS_KEY);
});

/** Select the capture and open its label editor. */
async function openEditor(captureId = IMPORTED) {
  fireEvent.click(await screen.findByTestId(`review-row-${captureId}`));
  fireEvent.click(await screen.findByTestId('label-edit-operator'));
  await screen.findByTestId('label-input-operator');
}

test('an unlabelled import invites the labels instead of showing a dash', async () => {
  mockApi([importedBag()]);
  renderWithClient(<ReviewScreen />);

  fireEvent.click(await screen.findByTestId(`review-row-${IMPORTED}`));

  // The whole point for an imported bag: the blank reads as something to fill
  // in, not as a value somebody chose.
  expect(await screen.findByTestId('label-edit-operator')).toHaveTextContent(
    'Set operator…',
  );
  expect(screen.getByTestId('label-edit-task')).toHaveTextContent('Set task…');
  expect(screen.getByTestId('label-edit-robot')).toHaveTextContent('Set robot…');
});

test('the three labels save together and the panel shows them', async () => {
  const { reviewCalls } = mockApi([importedBag()]);
  renderWithClient(<ReviewScreen />);
  await openEditor();

  fireEvent.change(screen.getByTestId('label-input-operator'), {
    target: { value: '  alice  ' },
  });
  fireEvent.change(screen.getByTestId('label-input-task'), {
    target: { value: 'pick-and-place' },
  });
  fireEvent.change(screen.getByTestId('label-input-robot'), {
    target: { value: 'myrobot' },
  });
  fireEvent.click(screen.getByTestId('label-save'));

  // ONE request carrying all three, on the review's own CAS token.
  await waitFor(() => expect(reviewCalls).toHaveLength(1));
  expect(reviewCalls[0]!.captureId).toBe(IMPORTED);
  expect(reviewCalls[0]!.body).toMatchObject({
    operator: 'alice', // trimmed
    task: 'pick-and-place',
    robot: 'myrobot',
    base_revision: 3,
  });

  // The editor closes and the rows read back the saved values — the detail this
  // panel renders is a different cache entry from the list the save
  // invalidates, so this also pins that the reply was folded in.
  await waitFor(() =>
    expect(screen.getByTestId('label-edit-operator')).toHaveTextContent('alice'),
  );
  expect(screen.getByTestId('label-edit-task')).toHaveTextContent('pick-and-place');
  expect(screen.getByTestId('label-edit-robot')).toHaveTextContent('myrobot');
  expect(screen.queryByTestId('label-input-operator')).toBeNull();
});

test('clearing a field sends null, not an empty label', async () => {
  const { reviewCalls } = mockApi([
    capture({ capture_id: IMPORTED, operator: 'alice', task: 'pick', robot: 'myrobot' }),
  ]);
  renderWithClient(<ReviewScreen />);
  await openEditor();

  // Whitespace only — the operator meant to empty it, not to store a space.
  fireEvent.change(screen.getByTestId('label-input-operator'), {
    target: { value: '   ' },
  });
  fireEvent.click(screen.getByTestId('label-save'));

  await waitFor(() => expect(reviewCalls).toHaveLength(1));
  // Explicit null is the contract's "clear it" (back to the manifest's value);
  // '' would store a label that is present and says nothing.
  expect(reviewCalls[0]!.body.operator).toBeNull();
  // The untouched fields still go, so the save is one whole statement.
  expect(reviewCalls[0]!.body).toMatchObject({ task: 'pick', robot: 'myrobot' });

  await waitFor(() =>
    expect(screen.getByTestId('label-edit-operator')).toHaveTextContent('Set operator…'),
  );
});

test('a refused edit keeps what was typed and never claims it saved', async () => {
  mockApi([importedBag()], {
    reviewError: {
      status: 409,
      code: 'review_conflict',
      message: 'Someone else saved a review for this recording first.',
    },
  });
  renderWithClient(<ReviewScreen />);
  await openEditor();

  fireEvent.change(screen.getByTestId('label-input-operator'), {
    target: { value: 'alice' },
  });
  fireEvent.click(screen.getByTestId('label-save'));

  // The refusal is stated in the words of the thing that was refused.
  const error = await screen.findByTestId('label-error');
  expect(error).toHaveTextContent(/saved a review for this recording first/i);

  // Still open, still holding the typed value: the operator can retry without
  // re-typing, and nothing on screen says the label took.
  expect(screen.getByTestId('label-input-operator')).toHaveValue('alice');
  expect(screen.queryByTestId('label-edit-operator')).toBeNull();
});

test('Cancel leaves the stored labels alone', async () => {
  const { reviewCalls } = mockApi([capture({ capture_id: IMPORTED, operator: 'alice' })]);
  renderWithClient(<ReviewScreen />);
  await openEditor();

  fireEvent.change(screen.getByTestId('label-input-operator'), {
    target: { value: 'bob' },
  });
  fireEvent.click(screen.getByTestId('label-cancel'));

  await waitFor(() =>
    expect(screen.getByTestId('label-edit-operator')).toHaveTextContent('alice'),
  );
  expect(reviewCalls).toHaveLength(0);
});
