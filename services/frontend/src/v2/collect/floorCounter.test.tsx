// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// `episodes_recorded` after a rebuild is a LOWER BOUND, and has to say so.
//
// The counter is advanced by the first review save of each capture, and the
// ledger stores facts rather than events — so a rebuild cannot replay those
// saves. It reconstructs the figure by counting the recordings whose
// `record.json` still names the batch, which misses every capture that was
// reviewed in and later deleted. The result is a floor.
//
// Before the server sent the flag the counter simply came back as 0, and a
// finished batch read `0 / 30`. That is fixed server-side; this is the other
// half of it, and the ruling is the reason it is not optional: 下限は「下限」と
// ラベルされて初めて誠実 — a floor presented as a count is a number the
// operator will act on, by re-recording takes they already have.
//
// Two surfaces read the counter and both are covered here, because fixing only
// the one named in the handoff would leave the same lie one card lower.

import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { setApiBase } from '../../api/client';
import { makeTestClient, jsonResponse } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { __resetPlansStore } from '../plans';
import { CollectScreen } from './CollectScreen';
import {
  useBatchMachine,
  __resetBatchStore,
  __setStopFloorMs,
} from './useBatchMachine';

const CONFIG = {
  endpoints: {
    api: '/api/v1',
    events: '/api/v1/events',
    webrtc: 'http://localhost:8002',
  },
  tabs: [],
  defaults: { default_topics: ['/hsrb/joint_states'] },
  schemas: {},
};

const PROJECT = 'Tabletop Manipulation';
const TASK = 'Pick and Place';
const CONDITION = 'Object: Left → Tray: Center';

/** An active batch as the server serves it, with the floor flag under test. */
function batch(isFloor: boolean) {
  return {
    batch_id: 'b1',
    batch_seq: 4,
    project: PROJECT,
    task: TASK,
    condition: CONDITION,
    status: 'active',
    target_episodes: 30,
    episodes_recorded: 12,
    episodes_recorded_is_floor: isFloor,
    episode_count: 12,
    created_at: new Date().toISOString(),
  };
}

function mockApi(isFloor: boolean) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({ run_id: null, state: 'created', live_capture_ids: [] }),
      );
    }
    // Same figures as the batch fixture above, as the coverage endpoint reports
    // them: one condition, 12 recorded, floor flag under test.
    if (url.includes('/batches/coverage')) {
      return Promise.resolve(
        jsonResponse({
          task: TASK,
          rows: [{ condition: CONDITION, recorded: 12, is_floor: isFloor }],
        }),
      );
    }
    if (url.includes('/batches/b1')) {
      return Promise.resolve(jsonResponse({ ...batch(isFloor), captures: [] }));
    }
    if (url.includes('/batches')) {
      return Promise.resolve(jsonResponse({ items: [batch(isFloor)] }));
    }
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
}

function renderCollect(): void {
  const client = makeTestClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(<CollectScreen />, { wrapper: Wrapper });
}

/** The header's Episode cell. */
function episodeCell(): HTMLElement {
  const heading = screen.getAllByText('Episode').find((n) => n.tagName === 'SPAN');
  if (!heading?.parentElement) throw new Error('no Episode cell');
  return heading.parentElement;
}

beforeEach(() => {
  setApiBase('/api/v1');
  __resetBatchStore();
  __resetPlansStore();
  useUiStore.setState({
    activeTab: '',
    // Recording requires an operator since #11, in every configuration —
    // so a suite that records has to say who is recording. The gate itself
    // is exercised where it is the subject, not incidentally here.
    recordOperator: 'tester',
    recordSelected: new Set<string>(),
    recordCustomized: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetPlansStore();
});

test('a reconstructed counter is labelled as a floor in the header', async () => {
  mockApi(true);
  renderCollect();

  // The restore lands, so the header is showing the server's figure.
  await waitFor(() => expect(episodeCell()).toHaveTextContent('12'));
  // It is a lower bound and says so — "12 / 30" is a claim this number cannot
  // support after a rebuild.
  expect(episodeCell()).toHaveTextContent('≥');
});

test('an ordinary counter is NOT labelled as a floor', async () => {
  mockApi(false);
  renderCollect();

  // The control that keeps the label meaningful: if every batch wore it, it
  // would say nothing. Same fixture, one boolean apart.
  await waitFor(() => expect(episodeCell()).toHaveTextContent('12'));
  expect(episodeCell().textContent ?? '').not.toMatch(/≥/);
});

test('the coverage card marks a condition whose total is a floor', async () => {
  mockApi(true);
  renderCollect();

  const row = await screen.findByTestId(`coverage-row-${CONDITION}`);
  await waitFor(() => expect(row).toHaveTextContent('12'));
  expect(row).toHaveTextContent('≥');
});

test('the coverage card leaves an exact total unmarked', async () => {
  mockApi(false);
  renderCollect();

  const row = await screen.findByTestId(`coverage-row-${CONDITION}`);
  await waitFor(() => expect(row).toHaveTextContent('12'));
  expect(row.textContent ?? '').not.toMatch(/≥/);
});

// STICKY (spec, 2026-08-06): a later save moves the counter but does NOT clear
// the marker. The reason is arithmetic — the reconstructed base is still a
// floor, so base + 1 is still a floor, and there is no save that can recover
// the takes whose sidecars are gone. Clearing it on the first new episode would
// be the worst of both: the number stays uncertain and the label that said so
// disappears at the moment the operator is most likely to read it.
//
// It is sticky BY CONSTRUCTION today — `CONFIRM_EPISODE` spreads state and does
// not touch the field — which is exactly the kind of property a later refactor
// drops without any test noticing. Hence an assertion rather than a comment.
test('the floor marker survives a later save that advances the counter', async () => {
  let started = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const cap = {
      capture_id: 'cap_f',
      run_id: 'run_f',
      state: started ? 'completed' : 'recording',
      review_status: 'pending',
      review_revision: 0,
    };
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/record/start')) {
      started = true;
      return Promise.resolve(jsonResponse(cap));
    }
    if (url.includes('/record/stop')) return Promise.resolve(jsonResponse(cap));
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          capture_id: started ? 'cap_f' : null,
          run_id: started ? 'run_f' : null,
          state: started ? 'completed' : 'created',
          live_capture_ids: [],
        }),
      );
    }
    if (url.includes('/review') && method === 'PATCH') {
      return Promise.resolve(
        jsonResponse({ ...cap, review_revision: 1, index_in_batch: 13 }),
      );
    }
    if (url.includes('/batches/b1')) {
      return Promise.resolve(jsonResponse({ ...batch(true), captures: [] }));
    }
    if (url.includes('/batches')) {
      return Promise.resolve(jsonResponse({ items: [batch(true)] }));
    }
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });

  __setStopFloorMs(0);
  const client = makeTestClient();
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  // The restore lands on the reconstructed batch.
  await waitFor(() => expect(result.current.stats.nRecorded).toBe(12));
  expect(result.current.recordedIsFloor).toBe(true);

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  act(() => result.current.pickSuccess());
  act(() => result.current.confirmEpisode());

  // Positive control: the counter really did move, so the assertion below is
  // about stickiness and not about nothing having happened.
  await waitFor(() => expect(result.current.stats.nRecorded).toBe(13));
  expect(result.current.recordedIsFloor).toBe(true);
});
