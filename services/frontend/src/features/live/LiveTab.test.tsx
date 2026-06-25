import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { renderWithClient, jsonResponse } from '../../test/renderWithClient';
import { LiveTab } from './LiveTab';
import type { RuntimeConfig } from '../../config';

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: { default_topics: [] },
  schemas: {},
} as RuntimeConfig;

function mockStatus(status: Record<string, unknown>, runDetail?: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status')) return Promise.resolve(jsonResponse(status));
    if (url.match(/\/runs\/[^/]+$/) && runDetail)
      return Promise.resolve(jsonResponse(runDetail));
    if (url.includes('/topics')) return Promise.resolve(jsonResponse([]));
    if (url.includes('/runs')) return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

// Regression: a fresh recorder reports state="created" (run_id=null). That must
// render the IDLE hero (operator/task inputs + 記録を開始) — NOT a stuck 収録中.
test('fresh recorder (state=created) shows the idle hero, not 収録中', async () => {
  mockStatus({ run_id: null, state: 'created' });
  renderWithClient(<LiveTab config={CONFIG} />);

  await waitFor(() => expect(screen.getByText('待機中')).toBeInTheDocument());
  expect(screen.queryByText('収録中')).not.toBeInTheDocument();
  expect(screen.getByLabelText('operator')).toBeInTheDocument();
  expect(screen.getByLabelText('task')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /記録を開始/ })).toBeInTheDocument();
});

test('active recording (state=recording) shows 収録中 + a stop button', async () => {
  mockStatus(
    { run_id: 'run_1', state: 'recording', message_count: 10, bytes: 2048 },
    {
      run_id: 'run_1',
      state: 'recording',
      operator: 'yuki',
      task: 'pick',
      started_at: '2026-06-26T00:00:00Z',
      topics: [{ name: '/a', type: 't' }],
    },
  );
  renderWithClient(<LiveTab config={CONFIG} />);

  await waitFor(() => expect(screen.getByText('収録中')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: /記録を停止/ })).toBeInTheDocument();
  expect(screen.queryByText('待機中')).not.toBeInTheDocument();
});
