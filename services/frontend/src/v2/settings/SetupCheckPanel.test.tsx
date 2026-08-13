// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { SetupCheckPanel } from './SetupCheckPanel';

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

test('runs only after an explicit click and renders actionable evidence', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({
      status: 'blocked',
      checked_at: '2026-08-14T10:00:00Z',
      duration_ms: 84,
      robot: 'myrobot',
      ros_domain_id: 7,
      checks: [
        {
          id: 'recorder',
          label: 'Recorder preflight',
          status: 'blocker',
          summary: 'Insufficient free space to start recording.',
          action: 'Resolve the recorder storage or memory condition, then run again.',
        },
      ],
      topics: [
        {
          pattern: '/camera/*',
          status: 'pass',
          summary: '1 publishing topic received.',
          matched_topics: ['/camera/front/image'],
          receiving_topics: ['/camera/front/image'],
          qos: {
            '/camera/front/image': {
              reliability: 'best_effort',
              durability: 'volatile',
            },
          },
        },
      ],
    }),
  );

  renderWithClient(<SetupCheckPanel />);

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(screen.queryByTestId('setup-check-result')).not.toBeInTheDocument();

  fireEvent.click(screen.getByTestId('run-setup-check'));

  await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
  const call = fetchSpy.mock.calls[0];
  expect(call).toBeDefined();
  const [url, init] = call!;
  expect(String(url)).toContain('/api/v1/system/setup-check');
  expect(init?.method).toBe('POST');
  expect(await screen.findByTestId('setup-check-result')).toHaveTextContent('blocked');
  expect(screen.getByTestId('setup-check-result')).toHaveTextContent(
    'Insufficient free space',
  );
  expect(screen.getByTestId('setup-check-result')).toHaveTextContent(
    '/camera/front/image',
  );
  expect(screen.getByTestId('setup-check-result')).toHaveTextContent(
    'best_effort · volatile',
  );
  expect(screen.getByTestId('run-setup-check')).toHaveTextContent('Run again');
});
