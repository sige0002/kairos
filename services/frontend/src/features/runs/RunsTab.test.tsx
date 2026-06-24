import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { RunsTab } from './RunsTab';

beforeEach(() => {
  setApiBase('/api/v1');
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/runs/run-1')) {
      if ((init as RequestInit | undefined)?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(
        jsonResponse({
          run_id: 'run-1',
          state: 'completed',
          started_at: '2026-06-24T01:00:00.000Z',
          ended_at: '2026-06-24T01:05:00.000Z',
          topics: [{ name: '/tf', type: 'tf2_msgs/TFMessage' }],
          compression: 'zstd',
          manifest: { version: 1 },
        }),
      );
    }
    if (url.includes('/runs')) {
      return Promise.resolve(
        jsonResponse({
          items: [
            { run_id: 'run-1', state: 'completed' },
            { run_id: 'run-2', state: 'recording' },
          ],
          next_cursor: null,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => vi.restoreAllMocks());

test('lists runs and opens a detail view with manifest', async () => {
  renderWithClient(<RunsTab />);

  await waitFor(() => expect(screen.getByText('run-1')).toBeInTheDocument());
  expect(screen.getByText('run-2')).toBeInTheDocument();

  // Open detail.
  fireEvent.click(screen.getByRole('button', { name: /run-1/ }));

  await waitFor(() => expect(screen.getByText('/tf')).toBeInTheDocument());
  expect(screen.getByText('zstd')).toBeInTheDocument();
  // Manifest is rendered in a collapsible JSON block.
  expect(screen.getByText('Manifest')).toBeInTheDocument();
});

test('deletes a run after confirm and clears the detail', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  renderWithClient(<RunsTab />);

  await waitFor(() => expect(screen.getByText('run-1')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /run-1/ }));
  await waitFor(() => expect(screen.getByText('/tf')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

  // A DELETE request is issued for the run.
  await waitFor(() => {
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      calls.some(
        (c) =>
          String(c[0]).includes('/runs/run-1') &&
          (c[1] as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toBe(true);
  });
  // Detail is cleared back to the placeholder.
  await waitFor(() =>
    expect(screen.getByText(/Select a run to see details/)).toBeInTheDocument(),
  );
});
