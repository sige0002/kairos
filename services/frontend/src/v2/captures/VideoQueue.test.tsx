// Camera previews submit in PARALLEL — all of a capture's cameras at once.
//
// This file used to pin the opposite ("one at a time, never two in flight"),
// and that was right at the time: §7.1's lease was per capture and exclusive,
// so five tiles auto-submitting on mount meant one winner and four 409
// capture_busy refusals — which the operator experienced as "the video doesn't
// show". The client serialised them behind a queue to stop generating that
// contention.
//
// §7.1 now grants a SHARED reader lease: read-only jobs on one capture no
// longer exclude each other, so there is nothing left for the client to
// serialise, and taking turns only made five previews take five times as long.
// What limits real parallelism is the server's own KAIROS_DORA_MAX_CONCURRENCY
// — which is where a queue belongs, next to the work.
//
// The discriminator below is deliberate: with every job held `running`, the old
// serialised client submits exactly ONE and waits. Asserting that all five
// arrive cannot pass against it.

import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { VideoCheckSection } from './inspect';
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
 * A server that accepts concurrent read-only jobs on one capture, as the
 * shared reader lease now does. It records what was submitted and how many
 * were in flight at once, so "in parallel" is measured rather than assumed.
 */
function mockJobs(opts: { failJobFor?: string; holdAll?: boolean } = {}) {
  let seq = 0;
  const submitted: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const jobs = new Map<string, { topic: string; state: string }>();

  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.endsWith('/jobs') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as {
        capture_id: string;
        params: { topic: string };
      };
      const jobId = `j${++seq}`;
      submitted.push(body.params.topic);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
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
      if (job && !opts.holdAll && job.state === 'running') {
        // Terminal on the first poll: succeeded, or failed for one nominated
        // topic so the "one bad topic does not take the others down" path runs.
        job.state = job.topic === opts.failJobFor ? 'failed' : 'succeeded';
        inFlight -= 1;
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
    /** The most submissions outstanding at any one moment. */
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

test('every camera submits at once, without waiting for the one before it', async () => {
  // Nothing ever finishes. A client that took turns would sit on ONE
  // submission forever, so this is the assertion the old behaviour fails.
  const server = mockJobs({ holdAll: true });
  renderWithClient(<VideoCheckSection topics={CAMERAS} captureId={CAP} />);
  screen.getByRole('button', { name: 'All cameras' }).click();

  await waitFor(() => expect(server.submitted).toHaveLength(CAMERAS.length));
  // Measured, not inferred: all five were outstanding together.
  expect(server.maxInFlight).toBe(CAMERAS.length);
  expect(new Set(server.submitted)).toEqual(new Set(CAMERAS.map((c) => c.name)));
});

test('there is no queue position to report any more', async () => {
  mockJobs({ holdAll: true });
  renderWithClient(<VideoCheckSection topics={CAMERAS} captureId={CAP} />);
  screen.getByRole('button', { name: 'All cameras' }).click();

  await waitFor(() => expect(screen.getAllByText('Generating…')).toHaveLength(5));
  // Waiting-in-line was the only thing this said; with nothing to wait behind,
  // a tile is either generating, done, or failed. Nothing is refused, either.
  expect(screen.queryByTestId('video-queued')).toBeNull();
  expect(screen.queryByTestId('video-submit-error')).toBeNull();
});

test('each camera is submitted exactly once', async () => {
  // The submit gate changed from "this tile holds the capture" to "this tile
  // wants an answer", and a gate that re-fires would now spend a real job on
  // every render instead of merely losing a race.
  const server = mockJobs();
  renderWithClient(<VideoCheckSection topics={CAMERAS} captureId={CAP} />);
  screen.getByRole('button', { name: 'All cameras' }).click();

  await waitFor(() => expect(server.submitted).toHaveLength(CAMERAS.length));
  // Let any stray re-submission land before claiming there was none.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(server.submitted).toHaveLength(CAMERAS.length);
  expect(new Set(server.submitted).size).toBe(CAMERAS.length);
});

test('one camera that fails does not stop the others', async () => {
  const server = mockJobs({ failJobFor: '/cam/head' });
  renderWithClient(<VideoCheckSection topics={CAMERAS} captureId={CAP} />);
  screen.getByRole('button', { name: 'All cameras' }).click();

  await waitFor(() => expect(server.submitted).toHaveLength(CAMERAS.length));
  // The broken topic says so, and the other four still produce their preview —
  // previously this depended on the failure releasing the queue; now they were
  // never behind it.
  await waitFor(() => expect(screen.getByText(/decode failed/)).toBeInTheDocument());
  await waitFor(() =>
    expect(document.querySelectorAll('video')).toHaveLength(CAMERAS.length - 1),
  );
});
