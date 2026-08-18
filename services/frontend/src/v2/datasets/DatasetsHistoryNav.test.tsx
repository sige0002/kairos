// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// E-28, the Datasets half: a history navigation that changes THIS screen's keys.
//
// `App.tsx` adopts the URL's `?tab=` on `popstate`, with a comment saying why:
// after any history navigation the console must show what that URL would show
// on a fresh load — which is what a session restore and a bfcache resume
// actually do. The Datasets screen owns five more addressable keys (`dsid`,
// `dsmem`, the searches, the facets) and has no equivalent listener: it seeds
// them ONCE with `useState(() => readDatasetsUrl(...))` and afterwards mirrors
// its own state back out with `replaceState`.
//
// So a navigation that changes `dsid` under a mounted Datasets screen was
// ignored AND then overwritten — the URL rewritten back to the selection the
// screen was already showing, which is the same "the navigation silently did
// not happen" that App.tsx was fixed for, one level down.
//
// HOW REACHABLE IS IT TODAY. Nothing in src/ calls `pushState`, so in-app
// navigation adds no history entries and Back leaves the console. This is
// therefore a latent asymmetry rather than a bug an operator hits this week —
// which is exactly the ground App.tsx's own listener stands on ("this listener
// is what stops that from becoming a lie the moment a `pushState` appears").
// The behaviour under test is the one the shell already guarantees, so the two
// screens now answer a history navigation the same way instead of two ways.

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { DatasetsScreen } from './DatasetsScreen';
import type { Dataset } from '../../api/types';

const DS_A: Dataset = {
  dataset_id: 'ds-a',
  name: 'kitchen picks',
  operator: 'op_a',
  task: 'pick_place',
  status: 'active',
  created_at: '2026-07-21T08:00:00Z',
  member_count: 0,
};
const DS_B: Dataset = { ...DS_A, dataset_id: 'ds-b', name: 'bin sweeps' };

function mockApi() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    const path = url.replace(/^.*\/api\/v1/, '').split('?')[0] ?? '';
    if (path === '/datasets') {
      return Promise.resolve(jsonResponse({ items: [DS_A, DS_B] }));
    }
    if (path === '/captures') {
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    }
    if (path === '/archive/config') {
      return Promise.resolve(jsonResponse({ roots: [], default_root: null }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

/** What the browser does to a running SPA on Back / Forward / a restore. */
function navigateHistoryTo(search: string): void {
  window.history.replaceState(null, '', search);
  fireEvent.popState(window);
}

function scopeTitle(): HTMLElement {
  return screen.getByTestId('dataset-scope-title');
}

beforeEach(() => {
  setApiBase('/api/v1');
  window.history.replaceState(null, '', '/?tab=datasets');
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

test('a history navigation that changes ?dsid= is followed, not silently undone', async () => {
  mockApi();
  window.history.replaceState(null, '', '/?tab=datasets&dsid=ds-a');
  renderWithClient(<DatasetsScreen />);

  // Positive control: the deep link seeded the selection, so this screen really
  // is showing ds-a before the navigation.
  await waitFor(() => expect(scopeTitle()).toHaveTextContent('kitchen picks'));

  navigateHistoryTo('/?tab=datasets&dsid=ds-b');

  await waitFor(() => expect(scopeTitle()).toHaveTextContent('bin sweeps'));
  // And the URL the browser restored is left alone rather than rewritten back
  // to the old selection — the half that made this "the navigation vanished"
  // rather than merely "the screen was slow".
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get('dsid')).toBe('ds-b'),
  );
  // The shell's own key survives untouched, as it does through every other
  // write this screen makes.
  expect(new URLSearchParams(window.location.search).get('tab')).toBe('datasets');
});

test('a history navigation that drops ?dsid= clears the selection', async () => {
  mockApi();
  window.history.replaceState(null, '', '/?tab=datasets&dsid=ds-a');
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(scopeTitle()).toHaveTextContent('kitchen picks'));

  // A URL naming no dataset would show none on a fresh load, so it shows none
  // here. Keeping the old selection is the mirror of the bug above.
  navigateHistoryTo('/?tab=datasets');

  await waitFor(() =>
    expect(screen.getByTestId('dataset-none-selected')).toBeInTheDocument(),
  );
  expect(new URLSearchParams(window.location.search).get('dsid')).toBeNull();
});

// The other addressable keys travel on the same navigation, and a screen that
// adopted only the selection would leave the operator looking at the restored
// dataset through the PREVIOUS search — a filtered view they did not ask for
// and cannot see the cause of.
test('the search box follows a history navigation too', async () => {
  mockApi();
  window.history.replaceState(null, '', '/?tab=datasets&dsq=kitchen');
  renderWithClient(<DatasetsScreen />);

  const box = await screen.findByTestId('dataset-search');
  await waitFor(() => expect(box).toHaveValue('kitchen'));

  navigateHistoryTo('/?tab=datasets&dsq=bin');

  await waitFor(() => expect(screen.getByTestId('dataset-search')).toHaveValue('bin'));
});
