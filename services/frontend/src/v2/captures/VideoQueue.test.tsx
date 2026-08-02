// The real defect (operator's live session): the video section mounts one
// VideoPlayer per camera topic and each auto-submitted on mount, so a
// five-camera robot fired five simultaneous POST /jobs for the SAME capture.
// The §7.1 lease is per capture, so one won and four were refused with 409 —
// which the operator experienced as "the video doesn't show".

import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { VideoCheckSection } from './inspect';
import { __resetJobQueue } from './jobQueue';
import type { CaptureTopic } from '../../api/types';

const CAP = 'cap-1';

const CAMERAS: CaptureTopic[] = [
  { name: '/cam/head', type: 'sensor_msgs/msg/CompressedImage' },
  { name: '/cam/left', type: 'sensor_msgs/msg/CompressedImage' },
  { name: '/cam/right', type: 'sensor_msgs/msg/CompressedImage' },
  { name: '/cam/wrist', type: 'sensor_msgs/msg/CompressedImage' },
  { name: '/cam/scene', type: 'sensor_msgs/msg/CompressedImage' },
];

/**
 * A server that models the ONE rule this is about: while a job holds the
 * capture, another submission is refused with 409 capture_busy. If the UI ever
 * submits two at once, `refusals` records it — the assertion is that it stays
 * at zero, which is what the operator's nginx log did not show.
 */
function mockJobs(opts: { failJobFor?: string; holdFirst?: boolean } = {}) {
  let holder: string | null = null;
  let seq = 0;
  const submitted: string[] = [];
  let refusals = 0;
  const jobs = new Map<string, { topic: string; state: string }>();

  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.endsWith('/jobs') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as {
        capture_id: string;
        params: { topic: string };
      };
      if (holder !== null) {
        refusals += 1;
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 'capture_busy',
                message: `Another job is working on ${body.capture_id}`,
                details: { lease_owner: holder },
              },
            },
            409,
          ),
        );
      }
      const jobId = `j${++seq}`;
      holder = jobId;
      submitted.push(body.params.topic);
      jobs.set(jobId, { topic: body.params.topic, state: 'running' });
      return Promise.resolve(
        jsonResponse({
          job_id: jobId,
          capture_id: CAP,
          pipeline: 'video_check',
          state: 'running',
          progress: 0,
        }),
      );
    }

    const statusMatch = url.match(/\/jobs\/([^/]+)\/status$/);
    if (statusMatch) {
      const jobId = statusMatch[1]!;
      const job = jobs.get(jobId);
      // `holdFirst` keeps job 1 running forever, so the waiters behind it stay
      // observably queued instead of the queue draining before an assertion.
      const held = opts.holdFirst && jobId === 'j1';
      if (job && !held) {
        // Terminal on the first poll: succeeded, or failed for one nominated
        // topic so the release-on-failure path is exercised.
        job.state = job.topic === opts.failJobFor ? 'failed' : 'succeeded';
        if (holder === jobId) holder = null;
      }
      return Promise.resolve(
        jsonResponse({
          job_id: jobId,
          capture_id: CAP,
          pipeline: 'video_check',
          state: job?.state ?? 'succeeded',
          progress: 1,
        }),
      );
    }

    const resultMatch = url.match(/\/jobs\/([^/]+)\/result$/);
    if (resultMatch) {
      const job = jobs.get(resultMatch[1]!);
      if (job?.state === 'failed') {
        return Promise.resolve(
          jsonResponse({ summary: { error: { message: 'decode failed' } } }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          summary: { capture_id: CAP, topic: job?.topic, frames: 10, file: 'x.mp4' },
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });

  return {
    submitted,
    /** How many submissions the server had to refuse. Must stay 0. */
    get refusals() {
      return refusals;
    },
  };
}

beforeEach(() => {
  setApiBase('/api/v1');
  __resetJobQueue();
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetJobQueue();
});

test('five camera previews submit one at a time, never two in flight', async () => {
  const server = mockJobs();
  renderWithClient(<VideoCheckSection topics={CAMERAS} captureId={CAP} />);

  // "All cameras" is what the operator pressed; each tile then auto-submits.
  screen.getByRole('button', { name: 'All cameras' }).click();

  await waitFor(() => expect(server.submitted).toHaveLength(CAMERAS.length), {
    timeout: 10000,
  });
  // The whole point: the server never had to refuse one.
  expect(server.refusals).toBe(0);
  // And every camera actually got its preview, rather than four being lost.
  expect(new Set(server.submitted).size).toBe(CAMERAS.length);
}, 20000);

test('a preview waiting its turn says so, and is not an error', async () => {
  // The first job never finishes, so the other four stay where the operator
  // would see them: waiting, not failed.
  mockJobs({ holdFirst: true });
  renderWithClient(<VideoCheckSection topics={CAMERAS} captureId={CAP} />);
  screen.getByRole('button', { name: 'All cameras' }).click();

  await waitFor(() =>
    expect(screen.getAllByTestId('video-queued')).toHaveLength(CAMERAS.length - 1),
  );
  // Whoever is behind the holder explains itself rather than showing a failure.
  for (const tile of screen.getAllByTestId('video-queued')) {
    expect(tile).toHaveTextContent(/Queued behind \d other preview/);
  }
  expect(screen.queryByTestId('video-submit-error')).toBeNull();
});

test('a failed preview releases the capture so the rest still run', async () => {
  // The first tile's job fails. Holding the slot for it would strand every
  // preview behind it — one broken topic becoming a section that never loads.
  const server = mockJobs({ failJobFor: '/cam/head' });
  renderWithClient(<VideoCheckSection topics={CAMERAS} captureId={CAP} />);
  screen.getByRole('button', { name: 'All cameras' }).click();

  await waitFor(() => expect(server.submitted).toHaveLength(CAMERAS.length), {
    timeout: 10000,
  });
  expect(server.refusals).toBe(0);
}, 20000);
