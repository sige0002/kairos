// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { RuntimeConfig } from '../../config';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { SystemSection } from './SystemSection';

const GB = 1e9; // decimal — matches the shared formatBytes convention

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: { robot_name: 'airoa_hsr', ros_domain_id: 42 },
  schemas: {},
} as unknown as RuntimeConfig;

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      jsonResponse({
        cpu: { model: 'Test CPU', cores: 8 },
        gpu: null,
        disk: { path: '/data', total_bytes: 200 * GB, free_bytes: 120 * GB },
      }),
    ),
  );
}

beforeEach(() => {
  setApiBase('/api/v1');
  useUiStore.setState({ sseStatus: 'open', monitorBridge: 'up' });
  mockFetch();
});
afterEach(() => {
  vi.restoreAllMocks();
  useUiStore.setState({ sseStatus: 'closed', monitorBridge: null });
});

test('shows deployment facts + storage + honest component health', async () => {
  renderWithClient(<SystemSection config={CONFIG} />);

  expect(screen.getByTestId('settings-system')).toHaveTextContent('airoa_hsr');
  expect(screen.getByTestId('settings-system')).toHaveTextContent('42'); // ROS_DOMAIN_ID
  expect(screen.getByTestId('settings-system')).toHaveTextContent('/api/v1');
  await waitFor(() =>
    expect(screen.getByTestId('settings-system')).toHaveTextContent('120.0 GB of 200.0 GB'),
  );
  // Honest component health (not /readyz chips) is embedded.
  expect(screen.getByTestId('health-orchestrator')).toHaveTextContent('reachable');
  // RMW honesty note.
  expect(screen.getByTestId('settings-system')).toHaveTextContent(/RMW/);
});
