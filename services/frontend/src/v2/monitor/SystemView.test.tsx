import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { RuntimeConfig } from '../../config';
import type { SystemInfo } from '../../api/types';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { SystemView } from './SystemView';

const GB = 1024 ** 3;

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: { robot_name: 'airoa_hsr', ros_domain_id: 42 },
  schemas: {},
} as unknown as RuntimeConfig;

function mockSystem(body: SystemInfo) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse(body)));
}

beforeEach(() => {
  setApiBase('/api/v1');
  useUiStore.setState({ sseStatus: 'open', monitorBridge: 'up' });
});
afterEach(() => {
  vi.restoreAllMocks();
  useUiStore.setState({ sseStatus: 'closed', monitorBridge: null });
});

test('renders real host facts + utilization + endpoints from /system and the config', async () => {
  mockSystem({
    cpu: { model: 'Intel Xeon Gold 6248', cores: 32 },
    gpu: 'NVIDIA RTX 4090',
    cpu_percent: 40,
    gpu_percent: 12,
    disk: { path: '/data', total_bytes: 500 * GB, free_bytes: 300 * GB },
  });
  renderWithClient(<SystemView config={CONFIG} />);

  await waitFor(() => expect(screen.getByTestId('sys-cpu')).toHaveTextContent('32× Intel Xeon Gold 6248'));
  expect(screen.getByTestId('sys-cpu-load')).toHaveTextContent('40%');
  expect(screen.getByTestId('sys-gpu')).toHaveTextContent('NVIDIA RTX 4090');
  expect(screen.getByTestId('sys-gpu-load')).toHaveTextContent('12%');
  expect(screen.getByTestId('sys-disk-free')).toHaveTextContent('300.0 GB of 500.0 GB');
  expect(screen.getByTestId('sys-domain')).toHaveTextContent('42');
  expect(screen.getByTestId('sys-api')).toHaveTextContent('/api/v1');
  // Honest component health, not /readyz chips.
  expect(screen.getByTestId('health-orchestrator')).toHaveTextContent('reachable');
});

test('omits GPU/CPU bars and shows honest fallbacks when the host cannot measure them', async () => {
  mockSystem({ cpu: { model: 'AMD EPYC 7763', cores: 16 }, gpu: null });
  renderWithClient(<SystemView config={CONFIG} />);

  await waitFor(() => expect(screen.getByTestId('sys-cpu')).toHaveTextContent('16× AMD EPYC 7763'));
  expect(screen.queryByTestId('sys-cpu-load')).not.toBeInTheDocument();
  expect(screen.queryByTestId('sys-gpu-load')).not.toBeInTheDocument();
  expect(screen.getByTestId('sys-gpu')).toHaveTextContent('not detected');
  // No disk → honest note, not a fabricated figure.
  expect(screen.getByText(/Disk usage unavailable/)).toBeInTheDocument();
});
