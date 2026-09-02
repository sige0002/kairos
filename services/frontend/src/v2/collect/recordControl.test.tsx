// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Browser recording-control recovery paths: a lease is an operational control,
// not authentication.  These cases protect the operator from an accidental
// normal Stop after another terminal has taken over.

import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { setApiBase } from '../../api/client';
import { i18n, I18nProvider } from '../../i18n';
import { useUiStore } from '../../store/uiStore';
import {
  jsonResponse,
  makeTestClient,
  renderWithClient,
} from '../../test/renderWithClient';
import {
  __resetBatchStore,
  __setStopConfirmMs,
  __setStopFloorMs,
  useBatchMachine,
} from './useBatchMachine';
import { TakeoverStopModal } from './Modals';
import type { BatchMachine } from './machine/contract';

const BATCH_STORAGE_KEY = 'kairos.collect.batch';
const CONTROL_CAPTURE = 'cap_control';

function captureBody(state = 'recording') {
  return {
    capture_id: CONTROL_CAPTURE,
    run_id: `run_${CONTROL_CAPTURE}`,
    state,
    review_status: 'pending',
    review_revision: 0,
    topics: [],
    operator: 'operator',
  };
}

function foreignStatus(controlledByThisClient = false) {
  return {
    capture_id: CONTROL_CAPTURE,
    run_id: `run_${CONTROL_CAPTURE}`,
    state: 'recording',
    live_capture_ids: [CONTROL_CAPTURE],
    started_at: new Date().toISOString(),
    control: {
      capture_id: CONTROL_CAPTURE,
      controlled_by_this_client: controlledByThisClient,
      lease_known: true,
    },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = makeTestClient();
  return (
    <I18nProvider>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </I18nProvider>
  );
}

function foreignRecordingFetch(
  overrides: {
    takeover?: () => Promise<Response>;
    forceStop?: () => Promise<Response>;
    stop?: () => Promise<Response>;
  } = {},
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/takeover')) {
      return overrides.takeover?.() ?? Promise.resolve(jsonResponse({}));
    }
    if (url.includes('/record/force-stop')) {
      return (
        overrides.forceStop?.() ??
        Promise.resolve(jsonResponse(captureBody('completed')))
      );
    }
    if (url.includes('/record/stop')) {
      return (
        overrides.stop?.() ?? Promise.resolve(jsonResponse(captureBody('completed')))
      );
    }
    if (url.includes(`/captures/${CONTROL_CAPTURE}`)) {
      return Promise.resolve(jsonResponse(captureBody()));
    }
    if (url.includes('/captures')) {
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    }
    if (url.includes('/record/status'))
      return Promise.resolve(jsonResponse(foreignStatus()));
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(async () => {
  setApiBase('/api/v1');
  __resetBatchStore();
  __setStopFloorMs(0);
  __setStopConfirmMs(0, 1);
  window.localStorage.clear();
  useUiStore.setState({
    recordOperator: 'tester',
    operatorHydrated: true,
    recordSelected: new Set<string>(),
    recordCustomized: false,
  });
  await i18n.changeLanguage('en');
});

afterEach(() => vi.restoreAllMocks());

test('a local recording that loses control exposes recovery and never sends ordinary Stop', async () => {
  let started = false;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      started = true;
      return Promise.resolve(jsonResponse(captureBody()));
    }
    if (url.includes('/record/stop'))
      return Promise.resolve(jsonResponse(captureBody('completed')));
    if (url.includes(`/captures/${CONTROL_CAPTURE}`)) {
      return Promise.resolve(jsonResponse(captureBody()));
    }
    if (url.includes('/captures')) {
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse(
          started ? foreignStatus(false) : { state: 'completed', live_capture_ids: [] },
        ),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  await waitFor(() => expect(result.current.takeover?.captureId).toBe(CONTROL_CAPTURE));
  expect(result.current.canStop).toBe(false);

  act(() => result.current.stopRecording());
  expect(
    fetchMock.mock.calls.some(([url]) => String(url).includes('/record/stop')),
  ).toBe(false);
});

test('takeover targets the recorder capture instead of an older live catalog row', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/takeover')) return Promise.resolve(jsonResponse({}));
    if (url.includes(`/captures/${CONTROL_CAPTURE}`)) {
      return Promise.resolve(jsonResponse(captureBody()));
    }
    if (url.includes('/captures')) {
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          ...foreignStatus(),
          live_capture_ids: ['cap_stale', CONTROL_CAPTURE],
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.takeover?.captureId).toBe(CONTROL_CAPTURE));

  act(() => result.current.confirmTakeoverStop());
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/record/takeover') &&
          String((init as RequestInit | undefined)?.body).includes(CONTROL_CAPTURE),
      ),
    ).toBe(true),
  );
});

test('a failed Take control leaves the recovery modal and card available', async () => {
  const fetchMock = foreignRecordingFetch({
    takeover: () =>
      Promise.resolve(
        jsonResponse(
          { error: { code: 'record_control_changed', message: 'lease moved' } },
          409,
        ),
      ),
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.takeover?.captureId).toBe(CONTROL_CAPTURE));

  act(() => result.current.openTakeoverStopModal());
  act(() => result.current.confirmTakeoverStop());
  await waitFor(() => expect(result.current.toast).toContain('lease moved'));

  expect(result.current.takeoverStopModalOpen).toBe(true);
  expect(result.current.takeover?.captureId).toBe(CONTROL_CAPTURE);
  expect(result.current.toast).toContain('lease moved');
  expect(
    fetchMock.mock.calls.filter(([url]) => String(url).includes('/record/takeover')),
  ).toHaveLength(1);
});

test('emergency Stop uses only force-stop, suppresses repeats, and keeps recovery after failure', async () => {
  let resolveForce: (response: Response) => void = () => undefined;
  const forcePending = new Promise<Response>((resolve) => {
    resolveForce = resolve;
  });
  const fetchMock = foreignRecordingFetch({ forceStop: () => forcePending });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.takeover?.captureId).toBe(CONTROL_CAPTURE));

  act(() => result.current.openTakeoverStopModal());
  act(() => {
    result.current.forceTakeoverStop();
    result.current.forceTakeoverStop();
  });
  await waitFor(() => expect(result.current.isTakeoverStopping).toBe(true));
  expect(
    fetchMock.mock.calls.filter(([url]) => String(url).includes('/record/force-stop')),
  ).toHaveLength(1);
  expect(
    fetchMock.mock.calls.some(([url]) => String(url).includes('/record/stop')),
  ).toBe(false);

  await act(async () => {
    resolveForce(
      jsonResponse(
        { error: { code: 'recorder_busy', message: 'recorder unavailable' } },
        503,
      ),
    );
  });
  await waitFor(() => expect(result.current.isTakeoverStopping).toBe(false));
  expect(result.current.takeoverStopModalOpen).toBe(true);
  expect(result.current.takeover?.captureId).toBe(CONTROL_CAPTURE);
  expect(result.current.toast).toContain('recorder unavailable');
});

test('the pending recovery modal blocks Escape and its emergency action is visibly pending', () => {
  const closeModals = vi.fn();
  const machine = {
    takeoverStopModalOpen: true,
    isTakeoverStopping: true,
    takeoverOperation: 'force-stop',
    closeModals,
    confirmTakeoverStop: vi.fn(),
    forceTakeoverStop: vi.fn(),
  } as unknown as BatchMachine;
  renderWithClient(<TakeoverStopModal machine={machine} />);

  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(document.querySelector('[aria-hidden="true"]') as HTMLElement);
  expect(closeModals).not.toHaveBeenCalled();
  // Only the operation in flight claims progress; the other action stays
  // truthfully named while disabled.
  expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Take control' })).toBeDisabled();
});

test('a same-session reload with server control can normally stop its capture', async () => {
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({ lastCaptureId: CONTROL_CAPTURE, episodes: [] }),
  );
  const fetchMock = foreignRecordingFetch({
    stop: () => Promise.resolve(jsonResponse(captureBody('completed'))),
  });
  // This is the cookie-backed reload state: no token is in JS/localStorage;
  // the status comparison says that this browser's session owns the lease.
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/stop'))
      return Promise.resolve(jsonResponse(captureBody('completed')));
    if (url.includes(`/captures/${CONTROL_CAPTURE}`))
      return Promise.resolve(jsonResponse(captureBody()));
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    if (url.includes('/record/status'))
      return Promise.resolve(jsonResponse(foreignStatus(true)));
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.takeoverOwned).toBe(true));

  act(() => result.current.stopOwnedTakeover());
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/record/stop')),
    ).toHaveLength(1),
  );
});
