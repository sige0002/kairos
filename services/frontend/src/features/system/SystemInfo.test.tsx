import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { SystemInfo, type SystemInfoResponse } from './SystemInfo';

function mockSystem(body: SystemInfoResponse) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(jsonResponse(body)));
}

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

test('renders CPU "cores× model" and GPU when both present', async () => {
  mockSystem({
    cpu: { model: 'Intel(R) Xeon(R) Gold 6248', cores: 32 },
    gpu: 'NVIDIA GeForce RTX 4090',
  });
  renderWithClient(<SystemInfo />);

  await waitFor(() => expect(screen.getByTestId('system-info')).toBeInTheDocument());
  expect(screen.getByText(/32× Intel\(R\) Xeon\(R\) Gold 6248/)).toBeInTheDocument();
  expect(screen.getByText('NVIDIA GeForce RTX 4090')).toBeInTheDocument();
  expect(screen.getByText('GPU')).toBeInTheDocument();
});

test('omits the GPU fact when gpu is null', async () => {
  mockSystem({ cpu: { model: 'AMD EPYC 7763', cores: 16 }, gpu: null });
  renderWithClient(<SystemInfo />);

  await waitFor(() => expect(screen.getByTestId('system-info')).toBeInTheDocument());
  expect(screen.getByText(/16× AMD EPYC 7763/)).toBeInTheDocument();
  expect(screen.queryByText('GPU')).not.toBeInTheDocument();
});

test('renders nothing while the query is pending (no data yet)', () => {
  // A fetch that never resolves keeps the query pending.
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
  const { container } = renderWithClient(<SystemInfo />);
  expect(container).toBeEmptyDOMElement();
});

test('renders nothing when CPU and GPU are all null', async () => {
  mockSystem({ cpu: { model: null, cores: null }, gpu: null });
  const { container } = renderWithClient(<SystemInfo />);

  // Give the query a tick to resolve, then confirm we still render nothing.
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
  expect(container.querySelector('[data-testid="system-info"]')).toBeNull();
});

test('renders nothing when the fetch fails', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(jsonResponse({ error: { code: 'boom' } }, 500)),
  );
  const { container } = renderWithClient(<SystemInfo />);

  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
  expect(container.querySelector('[data-testid="system-info"]')).toBeNull();
});
