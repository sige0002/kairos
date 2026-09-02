// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { afterEach, describe, expect, it, vi } from 'vitest';
import { forceStopRecord, stopRecord, takeOverRecord } from './record';

describe('record control API', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never sends a normal stop without its capture identity', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ capture_id: 'cap', state: 'completed' }), {
          status: 200,
        }),
      ),
    );
    await stopRecord('cap');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/record/stop',
      expect.objectContaining({ body: JSON.stringify({ capture_id: 'cap' }) }),
    );
  });

  it('keeps takeover and force-stop distinct explicit actions', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ capture_id: 'cap', state: 'completed' }), {
          status: 200,
        }),
      ),
    );
    await takeOverRecord('cap');
    await forceStopRecord('cap');
    expect(String(fetchMock.mock.calls.at(0)?.[0])).toContain('/record/takeover');
    expect(String(fetchMock.mock.calls.at(1)?.[0])).toContain('/record/force-stop');
  });
});
