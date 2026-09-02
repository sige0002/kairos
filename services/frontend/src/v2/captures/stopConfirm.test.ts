// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { beforeEach, expect, test, vi } from 'vitest';

const recordApi = vi.hoisted(() => ({
  getRecordStatus: vi.fn(),
}));

vi.mock('../../api/record', () => recordApi);

import {
  __resetStopConfirmMs,
  __setStopConfirmMs,
  confirmRecorderStopped,
} from './stopConfirm';

beforeEach(() => {
  recordApi.getRecordStatus.mockReset();
  __setStopConfirmMs(0, 1);
});

test('a newer active capture does not keep confirmation for the stopped capture waiting', async () => {
  recordApi.getRecordStatus.mockResolvedValue({
    state: 'recording',
    capture_id: 'cap_new',
    live_capture_ids: ['cap_new'],
  });

  await expect(confirmRecorderStopped('cap_stopped')).resolves.toBeUndefined();
  __resetStopConfirmMs();
});

test('the named capture still being live fails confirmation', async () => {
  recordApi.getRecordStatus.mockResolvedValue({
    state: 'recording',
    capture_id: 'cap_stopped',
    live_capture_ids: ['cap_stopped'],
  });

  await expect(confirmRecorderStopped('cap_stopped')).rejects.toMatchObject({
    code: 'stop_not_confirmed',
  });
  __resetStopConfirmMs();
});
