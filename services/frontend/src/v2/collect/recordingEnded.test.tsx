// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The screen noticing that a recording ENDED without it.
//
// A take can finish while this console is watching and healthy: the recorder's
// `MAX_RECORD_SECONDS` backstop auto-stops an unattended run, and another
// terminal can stop ours. Until now the only detection was gated behind an
// OUTAGE (`wasUnreachableRef`) — the screen checked whether the take had
// survived only after the recorder had been unreachable and came back. A take
// that ended while the poll never missed a beat left this screen showing
// RECORDING, with a running clock, forever.
//
// THE SHAPE OF THE FIX IS DECIDED BY WHICH ERROR IS WORSE. Abandoning a LIVE
// take is worse than being slow to notice a dead one: the operator is told
// their recording is over, stops trusting the screen, and may start another
// take over the top of one that is still writing. So the trigger is three
// conditions AT ONCE (plan §1103):
//
//   1. the recorder is reachable — otherwise we know nothing,
//   2. it reports a TERMINAL state for OUR capture — not for whatever capture
//      it has moved on to, and
//   3. our capture is absent from a live array that EXISTS, having previously
//      been NAMED in one.
//
// (3) carries the §10 rule that `live_capture_ids` is a POSITIVE liveness
// signal only: `null` means "we could not tell", and reading it as "nothing is
// live" is exactly how a running take gets abandoned. `[]` is an answer; `null`
// is not.
//
// The second half of (3) — having been seen live at least once — was not in the
// original three and was added on evidence. A bare absence is not a transition:
// the ordinary reason our capture is missing from the live array is that the
// recorder has not caught up to a take that just started. Shipping without it
// turned 38 existing tests red, every one a flow where the recorder never named
// the capture live, which is the exact false positive this effect exists to
// avoid. Only live -> not-live is evidence that something ENDED.
//
// The mirror tests are therefore the point of this file, not the happy path:
// each condition is removed on its own and the screen must do NOTHING. A
// single-condition implementation would pass the happy path.
//
// HOW A "NOTHING HAPPENED" TEST EARNS BELIEF. The first version of this file
// was worthless and mutation testing is what proved it: all four conditions
// could be deleted from the implementation and all six tests stayed green. The
// cause was the harness, not the assertions — the recorder is polled every
// 5000 ms and the mirrors only waited 1200 ms, so the changed status was never
// delivered and each mirror was asserting "still recording" against a view
// nothing had touched yet. "The screen did not react" and "the screen was never
// told" are indistinguishable unless the test forces delivery and SEES it.
//
// So every mirror now invalidates the query to force an immediate refetch and
// waits for the request count to advance before asserting. `statusReads` is
// that proof, and it is asserted in each mirror rather than assumed.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { setApiBase } from '../../api/client';
import { makeTestClient, jsonResponse } from '../../test/renderWithClient';
import { queryKeys } from '../../api/queryKeys';
import { useUiStore } from '../../store/uiStore';
import {
  useBatchMachine,
  __resetBatchStore,
  __setStopFloorMs,
} from './useBatchMachine';

const CAP = 'cap_ended';
const OTHER = 'cap_someone_else';

interface RecorderView {
  state: string;
  capture_id: string | null;
  /** `undefined` omits the key entirely — the §10 "we cannot tell" shape. */
  live_capture_ids?: string[];
}

/** A recorder whose reported status this test can change mid-take.
 *  `statusReads` counts served polls, so a test can prove a new view landed. */
function mockRecorder(initial: RecorderView) {
  const view = { current: initial, reachable: true, statusReads: 0 };
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status')) {
      view.statusReads += 1;
      if (!view.reachable) {
        return Promise.resolve(
          jsonResponse(
            { error: { code: 'recorder_unreachable', message: 'unreachable' } },
            503,
          ),
        );
      }
      const { state, capture_id, live_capture_ids } = view.current;
      return Promise.resolve(
        jsonResponse({
          capture_id,
          run_id: capture_id ? `run_${capture_id}` : null,
          state,
          started_at: '2026-08-01T00:00:00.000Z',
          ...(live_capture_ids === undefined ? {} : { live_capture_ids }),
        }),
      );
    }
    if (url.includes('/record/start')) {
      return Promise.resolve(
        jsonResponse({
          capture_id: CAP,
          run_id: `run_${CAP}`,
          state: 'recording',
          review_status: 'pending',
          review_revision: 0,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  return view;
}

/** Start a take and settle into RECORDING with the recorder confirming it.
 *  The client is returned so a test can force the next poll instead of waiting
 *  out the 5 s interval. */
async function startTake() {
  const view = mockRecorder({
    state: 'recording',
    capture_id: CAP,
    live_capture_ids: [CAP],
  });
  const client = makeTestClient();
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const hook = renderHook(() => useBatchMachine({ defaultTopics: [] }), { wrapper });
  act(() => hook.result.current.startRecording());
  await waitFor(() => expect(hook.result.current.phase).toBe('recording'));
  return { view, result: hook.result, client };
}

/**
 * Force the changed view to be DELIVERED, and prove it was.
 *
 * Returning without this is how the first version of these mirrors passed
 * against an implementation with every guard deleted: they asserted on a screen
 * that had not yet been told anything. The refetch is awaited by request count,
 * then a render is allowed to settle.
 */
async function deliverStatus(
  view: { statusReads: number },
  client: QueryClient,
): Promise<void> {
  const before = view.statusReads;
  await act(async () => {
    await client.invalidateQueries({ queryKey: queryKeys.recordStatus });
  });
  await waitFor(() => expect(view.statusReads).toBeGreaterThan(before));
  // A second round trip, so the render caused by the first has settled and any
  // effect reacting to it has run.
  const after = view.statusReads;
  await act(async () => {
    await client.invalidateQueries({ queryKey: queryKeys.recordStatus });
  });
  await waitFor(() => expect(view.statusReads).toBeGreaterThan(after));
}

beforeEach(() => {
  setApiBase('/api/v1');
  __setStopFloorMs(0);
  __resetBatchStore();
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
});

test('all three conditions: the screen leaves RECORDING and offers the take', async () => {
  const { view, result, client } = await startTake();

  // The backstop auto-stopped it: reachable, terminal for OUR capture, and the
  // live array exists and no longer names us.
  view.current = { state: 'completed', capture_id: CAP, live_capture_ids: [] };

  await deliverStatus(view, client);
  expect(result.current.phase).not.toBe('recording');
  expect(result.current.toast).toMatch(/recording ended/i);
}, 20000);

// ---- the mirror: each condition removed on its own -------------------------

// WHAT THIS PINS, AND WHAT ENFORCES IT — they are not the same, and mutation
// testing is how that came out. Deleting the `recorderReachable` guard from the
// implementation leaves this test GREEN, because the guard is strictly
// subsumed: `readRecordStatus` returns `live: null` on any failed poll
// (useRecordStatus.ts, the `if (failed || !status)` branch), so condition 3
// rejects an unreachable recorder before condition 1 is consulted. The explicit
// check is kept because the spec names three conditions and it states the
// intent locally, but no test can isolate it while that subsumption holds — so
// this test pins the OUTCOME, and says which guard actually delivers it.
test('mirror 1 — an UNREACHABLE recorder proves nothing, so nothing happens', async () => {
  const { view, result, client } = await startTake();

  // The same terminal view it would have sent, but we cannot read it.
  view.current = { state: 'completed', capture_id: CAP, live_capture_ids: [] };
  view.reachable = false;

  await deliverStatus(view, client);
  expect(result.current.phase).toBe('recording');
  // The card knows it cannot see the recorder — so this is the guard holding,
  // not the poll having stopped.
  expect(result.current.recorderUnreachable).toBe(true);
}, 20000);

test('mirror 2 — a NON-TERMINAL state is a take still being written', async () => {
  const { view, result, client } = await startTake();

  // Absent from the live array but still `recording`: the two disagree, and the
  // safe reading of a disagreement is that the take is alive.
  view.current = { state: 'recording', capture_id: CAP, live_capture_ids: [] };

  await deliverStatus(view, client);
  expect(result.current.phase).toBe('recording');
}, 20000);

test('mirror 3 — a MISSING live array is "cannot tell", never "not live"', async () => {
  const { view, result, client } = await startTake();

  // §10: an answer without `live_capture_ids` is an unreachable-or-too-old
  // recorder. Terminal state or not, this must not end a take.
  view.current = { state: 'completed', capture_id: CAP };

  await deliverStatus(view, client);
  expect(result.current.phase).toBe('recording');
}, 20000);

test('mirror 4 — a terminal state about SOMEONE ELSE’s capture says nothing about ours', async () => {
  const { view, result, client } = await startTake();

  // The recorder moved on to another session and reports THAT one as completed.
  // §10: the singular `capture_id` names the LAST capture, so reading its state
  // as ours is how another operator's stop ends our take.
  //
  // Our capture is deliberately ABSENT from the live array here. An earlier
  // version left it present, and that made the test worthless: the live check
  // rejected the payload on its own and deleting the capture_id guard kept
  // every test green. With our id gone, the capture_id match is the only thing
  // standing between this payload and a take being ended by someone else's stop.
  view.current = { state: 'completed', capture_id: OTHER, live_capture_ids: [] };

  await deliverStatus(view, client);
  expect(result.current.phase).toBe('recording');
}, 20000);

// The positive control for the whole mirror: the harness CAN move this screen
// out of RECORDING. Without it, every mirror test above would also pass against
// a build where the poll was broken and nothing ever arrived.
test('control — the same harness does end the take when all three hold', async () => {
  const { view, result, client } = await startTake();

  await deliverStatus(view, client);
  expect(result.current.phase).toBe('recording'); // stable while the take lives

  view.current = { state: 'completed', capture_id: CAP, live_capture_ids: [] };
  await deliverStatus(view, client);
  expect(result.current.phase).not.toBe('recording');
}, 20000);

test('mirror 5 — a capture never seen LIVE has not been seen to end either', async () => {
  // The recorder has not caught up: it is answering, but has never named our
  // capture in a live array. Then it reports a terminal state for it.
  const view = mockRecorder({
    state: 'created',
    capture_id: null,
    live_capture_ids: [],
  });
  const client = makeTestClient();
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const hook = renderHook(() => useBatchMachine({ defaultTopics: [] }), { wrapper });
  act(() => hook.result.current.startRecording());
  await waitFor(() => expect(hook.result.current.phase).toBe('recording'));

  view.current = { state: 'completed', capture_id: CAP, live_capture_ids: [] };
  await deliverStatus(view, client);

  // Absence without a prior sighting is not a transition — it is a recorder we
  // have not heard from about this take yet.
  expect(hook.result.current.phase).toBe('recording');
}, 20000);
