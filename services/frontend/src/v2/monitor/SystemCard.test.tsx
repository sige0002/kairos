import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { SystemInfo } from '../../api/types';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { SystemCard } from './SystemCard';

const GB = 1e9; // decimal — matches the shared formatBytes convention

function mockSystem(body: SystemInfo) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(jsonResponse(body)));
}

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

test('renders real CPU%/GPU% bars and storage free/total', async () => {
  mockSystem({
    cpu: { model: 'Intel(R) Xeon(R) Gold 6248', cores: 32 },
    gpu: 'NVIDIA GeForce RTX 4090',
    cpu_percent: 42,
    gpu_percent: 17,
    disk: { path: '/data', total_bytes: 500 * GB, free_bytes: 300 * GB },
  });
  renderWithClient(<SystemCard />);

  await waitFor(() => expect(screen.getByTestId('cpu-load')).toHaveTextContent('42%'));
  expect(screen.getByTestId('gpu-load')).toHaveTextContent('17%');
  expect(screen.getByText(/32× Intel\(R\) Xeon\(R\) Gold 6248/)).toBeInTheDocument();
  expect(screen.getByText('NVIDIA GeForce RTX 4090')).toBeInTheDocument();
  expect(screen.getByTestId('system-storage')).toHaveTextContent('300.0 GB free of 500.0 GB');
});

test('omits utilization bars and shows "—" storage when the backend reports no numbers', async () => {
  // An older backend returns only the static CPU/GPU names.
  mockSystem({ cpu: { model: 'AMD EPYC 7763', cores: 16 }, gpu: null });
  renderWithClient(<SystemCard />);

  await waitFor(() => expect(screen.getByText(/16× AMD EPYC 7763/)).toBeInTheDocument());
  // No fabricated bars when cpu_percent / gpu_percent are absent.
  expect(screen.queryByTestId('cpu-load')).not.toBeInTheDocument();
  expect(screen.queryByTestId('gpu-load')).not.toBeInTheDocument();
  // Honest dash instead of an invented free-space figure.
  expect(screen.getByTestId('system-storage')).toHaveTextContent('—');
  expect(screen.getByText('not detected')).toBeInTheDocument();
});

test('shows a CPU bar but no GPU bar when only cpu_percent is present', async () => {
  mockSystem({
    cpu: { model: 'Test CPU', cores: 8 },
    gpu: null,
    cpu_percent: 5,
    disk: { path: '/data', total_bytes: 100 * GB, free_bytes: 12 * GB },
  });
  renderWithClient(<SystemCard />);

  await waitFor(() => expect(screen.getByTestId('cpu-load')).toHaveTextContent('5%'));
  expect(screen.queryByTestId('gpu-load')).not.toBeInTheDocument();
  expect(screen.getByTestId('system-storage')).toHaveTextContent('12.0 GB free of 100.0 GB');
});
