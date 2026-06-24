import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { RuntimeConfig } from '../../config';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { RecordTab } from './RecordTab';

const CONFIG: RuntimeConfig = {
  endpoints: {
    api: '/api/v1',
    events: '/api/v1/events',
    webrtc: 'http://localhost:8002',
  },
  tabs: [],
  defaults: {},
  schemas: {},
};

let recordState = 'idle';

beforeEach(() => {
  setApiBase('/api/v1');
  recordState = 'idle';
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      recordState = 'recording';
      return Promise.resolve(jsonResponse({ run_id: 'run-1', state: 'recording' }));
    }
    if (url.includes('/record/stop')) {
      recordState = 'idle';
      return Promise.resolve(jsonResponse({ run_id: 'run-1', state: 'completed' }));
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          run_id: recordState === 'idle' ? null : 'run-1',
          state: recordState,
        }),
      );
    }
    void init;
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => vi.restoreAllMocks());

test('starts a recording: posts /record/start and reflects recording state', async () => {
  renderWithClient(<RecordTab config={CONFIG} />);

  // Wait for idle status to load.
  await waitFor(() =>
    expect(screen.getByTestId('record-state')).toHaveTextContent('idle'),
  );

  // The default form renders a topics selector; choose "all" then start.
  fireEvent.click(screen.getByLabelText('all topics'));
  const startForm = screen.getByLabelText('start recording');
  fireEvent.click(within(startForm).getByRole('button', { name: /Start recording/i }));

  await waitFor(() => {
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]),
    );
    expect(calls.some((u) => u.includes('/record/start'))).toBe(true);
  });

  // Status query is invalidated and re-fetches -> shows recording.
  await waitFor(() =>
    expect(screen.getByTestId('record-state')).toHaveTextContent('recording'),
  );

  // Stop button appears while active.
  expect(screen.getByRole('button', { name: /Stop recording/i })).toBeInTheDocument();
});

test('disables the start form while a session is active (no double start)', async () => {
  recordState = 'recording';
  renderWithClient(<RecordTab config={CONFIG} />);

  await waitFor(() =>
    expect(screen.getByTestId('record-state')).toHaveTextContent('recording'),
  );

  const startForm = screen.getByLabelText('start recording');
  expect(
    within(startForm).getByRole('button', { name: /Start recording/i }),
  ).toBeDisabled();
  expect(screen.getByText(/stop it before starting another/i)).toBeInTheDocument();
});
