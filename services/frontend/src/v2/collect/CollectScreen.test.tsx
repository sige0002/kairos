import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { CollectScreen } from './CollectScreen';

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: { default_topics: [] },
  schemas: {},
};

function mockFetch(recordStartBody: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/record/start')) return Promise.resolve(jsonResponse(recordStartBody));
    if (url.includes('/record/stop')) return Promise.resolve(jsonResponse({ run_id: 'run_1', state: 'completed' }));
    return Promise.resolve(jsonResponse({}));
  });
}

function phaseTitle() {
  return screen.getByTestId('phase-title');
}

beforeEach(() => {
  setApiBase('/api/v1');
  useUiStore.setState({ activeTab: '', sseStatus: 'closed', monitorBridge: null });
});
afterEach(() => vi.restoreAllMocks());

test('READY phase: shows the Start recording control and context bar', async () => {
  mockFetch({ run_id: 'run_1', state: 'recording' });
  renderWithClient(<CollectScreen />);

  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  expect(screen.getByRole('button', { name: /Start recording/ })).toBeInTheDocument();
  // Context bar cells.
  expect(screen.getByText('Tabletop Manipulation')).toBeInTheDocument();
  expect(screen.getByText('Pick and Place')).toBeInTheDocument();
  // Episode strip.
  expect(screen.getByTestId('episode-strip-count')).toHaveTextContent('0 / 30');
});

test('Start recording arms, then flips to RECORDING once /record/start succeeds', async () => {
  mockFetch({ run_id: 'run_1', state: 'recording' });
  renderWithClient(<CollectScreen />);

  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));

  await waitFor(() => expect(phaseTitle()).toHaveTextContent('ARMING…'));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  expect(screen.getByRole('button', { name: /Stop recording/ })).toBeInTheDocument();
});

test('a rejected start shows the failed banner and stays on READY', async () => {
  mockFetch({
    run_id: 'run_1',
    state: 'failed',
    error: { code: 'NO_TOPICS', message: 'no matching topics' },
  });
  renderWithClient(<CollectScreen />);

  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));

  await waitFor(() => expect(screen.getByText(/NO_TOPICS/)).toBeInTheDocument());
  expect(phaseTitle()).toHaveTextContent('READY');
});

test('Stop recording moves to SAVING', async () => {
  mockFetch({ run_id: 'run_1', state: 'recording' });
  renderWithClient(<CollectScreen />);

  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));

  fireEvent.click(screen.getByRole('button', { name: /Stop recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('SAVING…'));
});
