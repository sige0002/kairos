// E-7, the frontend half: the episode number the SERVER actually stored.
//
// `index_in_batch` is a proposal, not a decision. Collect sends
// `recordedCount + 1`, and the orchestrator renumbers on collision and returns
// the value it really wrote (§ E-7: 衝突時はサーバーが再採番し実際に保存した値を
// 応答で返す。クライアントは応答値を採用する). `saveReview` returns the whole
// `Capture`, so the answer is already in hand — it was simply dropped.
//
// WHY THIS IS NOT COSMETIC, AND WHY IT DOES NOT SELF-CORRECT. The handoff note
// said the strip chip fixes itself on the next captures refetch. It does not:
// the strip places chips by `machine.episodes[].index`, which is local state,
// and the only path that adopts server indices is the once-per-page-load
// hydrate (`if (serverHydrated) return`) — which the invalidation in
// `confirmEpisode` does not re-run. Nothing corrects the number until a reload.
//
// Left alone, a renumber therefore parks a chip on a slot that is not its own,
// and a LATER episode whose local number happens to equal the adopted one lands
// on the same slot — `byIndex.set` keeps the last, so one take vanishes from
// the strip while both exist on the server.

import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { setApiBase } from '../../api/client';
import { makeTestClient, jsonResponse } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import {
  useBatchMachine,
  __resetBatchStore,
  __setStopFloorMs,
} from './useBatchMachine';

const CAP = 'cap_e7';

function wrapper({ children }: { children: ReactNode }) {
  const client = makeTestClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** A full take, with the server storing *storedIndex* whatever we proposed.
 *  `null` models a backend that answers without the field at all. */
function mockFlow(storedIndex: number | null | undefined) {
  const sent: (number | null | undefined)[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = (state: string, extra: Record<string, unknown> = {}) =>
      jsonResponse({
        capture_id: CAP,
        run_id: `run_${CAP}`,
        state,
        review_status: 'pending',
        review_revision: 0,
        ...extra,
      });
    if (url.includes('/record/start')) return Promise.resolve(body('recording'));
    if (url.includes('/record/stop')) return Promise.resolve(body('completed'));
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          capture_id: CAP,
          run_id: `run_${CAP}`,
          state: 'completed',
          live_capture_ids: [],
        }),
      );
    }
    if (url.includes('/batches') && method === 'POST') {
      return Promise.resolve(
        jsonResponse({ batch_id: 'b1', batch_seq: 3, project: 'p', task: 't' }),
      );
    }
    if (url.includes('/review') && method === 'PATCH') {
      sent.push(
        (JSON.parse(String(init?.body ?? '{}')) as { index_in_batch?: number | null })
          .index_in_batch,
      );
      return Promise.resolve(
        body('completed', { review_revision: 1, index_in_batch: storedIndex }),
      );
    }
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
  return { sent };
}

/** Record one take and label it Success. */
async function recordAndConfirm(result: {
  current: ReturnType<typeof useBatchMachine>;
}) {
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  act(() => result.current.pickSuccess());
  act(() => result.current.confirmEpisode());
  await waitFor(() => expect(result.current.stats.nRecorded).toBe(1));
}

beforeEach(() => {
  setApiBase('/api/v1');
  __setStopFloorMs(0);
  __resetBatchStore();
  useUiStore.setState({
    activeTab: '',
    recordOperator: '',
    recordSelected: new Set<string>(),
    recordCustomized: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('E-7: a renumbered episode takes the number the server stored, not the one we proposed', async () => {
  const { sent } = mockFlow(7);
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  await recordAndConfirm(result);

  // Positive control: we really did propose 1, so 7 can only have come from the
  // response. Without this the assertion below would also pass if the client
  // had simply sent 7 in the first place.
  expect(sent).toEqual([1]);

  expect(result.current.episodes[0]?.index).toBe(7);
  await waitFor(() => expect(result.current.toast).toMatch(/Episode 7\b/));
  expect(result.current.toast).not.toMatch(/Episode 1\b/);
});

test('E-7: the strip flash points at the stored number too', async () => {
  mockFlow(7);
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  await recordAndConfirm(result);

  // `lastSavedIndex` is the slot the strip flashes as "just saved". Flashing the
  // proposed number highlights a slot that belongs to a different take.
  expect(result.current.lastSavedIndex).toBe(7);
});

test('E-7: an unchanged index behaves exactly as before', async () => {
  mockFlow(1);
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  await recordAndConfirm(result);

  expect(result.current.episodes[0]?.index).toBe(1);
  await waitFor(() => expect(result.current.toast).toMatch(/Episode 1\b/));
});

// A backend that answers without the field must not blank the chip: an episode
// with no number cannot be placed on the strip at all. The proposal stands, and
// it is the same number this client has always used.
test('E-7: a response with no index_in_batch falls back to the proposed number', async () => {
  mockFlow(null);
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  await recordAndConfirm(result);

  expect(result.current.episodes[0]?.index).toBe(1);
});

// The two new recorder error codes (2026-08-06) both arrive as codes this
// screen has never heard of: `label_too_long` on start/prepare when an operator
// or task name exceeds 255 bytes, and `stop_capture_unfiled` on stop in the
// narrow case where the recorder is live but its capture cannot be filed.
//
// Neither needs its own copy — `ERROR_COPY` is a courtesy layer over known
// codes and everything else falls through to the server's message, which in
// both cases already names the specific thing (the field, or the capture_id).
// But that fallback was the load-bearing part of "no frontend change required"
// and nothing pinned it, so a future edit that mapped unknown codes to a
// generic "Recording failed" would silently swallow both messages and no test
// would notice.
test('an unrecognised recorder error surfaces the SERVER message, not a generic one', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(
        jsonResponse(
          {
            error: {
              code: 'label_too_long',
              message: 'operator must be at most 255 bytes (UTF-8).',
              details: { field: 'operator' },
            },
          },
          400,
        ),
      );
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({ run_id: null, state: 'created', live_capture_ids: [] }),
      );
    }
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());

  await waitFor(() => expect(result.current.startError).not.toBeNull());
  // The code is carried so the banner can show it muted …
  expect(result.current.startError?.code).toBe('label_too_long');
  // … and the message is the server's own, naming which field was too long.
  // A generic string here is the failure: the operator cannot tell whether it
  // was the operator name or the task.
  expect(result.current.startError?.message).toMatch(/operator/);
  expect(result.current.startError?.message).toMatch(/255 bytes/);
});
