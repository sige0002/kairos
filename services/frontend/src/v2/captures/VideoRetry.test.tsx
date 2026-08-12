// The retry a failed preview offers has to re-run the SAME work.
//
// A camera tile submits twice with different meaning: the mount job takes the
// short head-only preview, and "Re-encode full episode" submits force + no
// frame cap. Both land on the same mutation, so a Retry that resubmitted the
// mount defaults would answer a question the operator did not ask — quietly,
// because a head-only preview looks like a successful re-encode until someone
// scrubs to the end and finds the episode stops early.

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { VideoCheckSection } from './inspect';
import type { CaptureTopic } from '../../api/types';

const CAP = 'cap-1';
const CAMERAS: CaptureTopic[] = [
  { name: '/cam/head', type: 'sensor_msgs/msg/CompressedImage' },
];

/** The first job succeeds with a head-only preview; every submission after
 *  that never reaches the server. */
function mockVideoJobs() {
  const posted: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/jobs') && method === 'POST') {
      posted.push(JSON.parse(String(init?.body)));
      if (posted.length === 1) {
        return Promise.resolve(
          jsonResponse({ job_id: 'j1', capture_id: CAP, pipeline: 'video_check', state: 'queued' }),
        );
      }
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    if (url.includes('/jobs/j1/status'))
      return Promise.resolve(
        jsonResponse({ job_id: 'j1', capture_id: CAP, pipeline: 'video_check', state: 'succeeded' }),
      );
    if (url.includes('/jobs/j1/result'))
      return Promise.resolve(
        jsonResponse({
          summary: {
            file: 'video/cam-head.mp4',
            frames: 120,
            fps: 30,
            truncated: true,
            total_messages: 4000,
          },
        }),
      );
    return Promise.resolve(jsonResponse({}));
  });
  return { posted };
}

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

test('retrying a failed re-encode asks for the re-encode again, not the preview', async () => {
  const { posted } = mockVideoJobs();
  renderWithClient(<VideoCheckSection topics={CAMERAS} captureId={CAP} />);

  fireEvent.click(screen.getByRole('button', { name: 'All cameras' }));

  // The head-only preview lands, which is what offers the full re-encode.
  const reencode = await screen.findByRole('button', { name: 'Re-encode full episode' });
  expect(posted[0]).toMatchObject({ params: { topic: '/cam/head' } });
  expect(posted[0]!.params).not.toHaveProperty('force');

  // The re-encode is submitted, and never reaches the server.
  fireEvent.click(reencode);
  await waitFor(() => expect(posted).toHaveLength(2));
  expect(posted[1]).toMatchObject({ params: { force: true, max_frames: 0 } });

  const err = await screen.findByTestId('video-submit-error');
  expect(err).toHaveAttribute('data-error-code', 'network_unreachable');

  fireEvent.click(screen.getByTestId('video-submit-error-retry'));

  // The defect: the retry resubmitted the mount defaults, silently turning a
  // full re-encode back into the head-only preview it was asked to replace.
  await waitFor(() => expect(posted).toHaveLength(3));
  expect(posted[2]).toEqual(posted[1]);
});
