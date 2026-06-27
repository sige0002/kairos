import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { RunsTab } from './RunsTab';

beforeEach(() => {
  setApiBase('/api/v1');
  // Each video_check job gets a distinct id (one per camera topic) so multiple
  // players poll independently; the result file is derived from the topic.
  const videoJobs: Record<string, string> = {};
  let videoCounter = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/jobs') && (init as RequestInit | undefined)?.method === 'POST') {
      const body = String((init as RequestInit | undefined)?.body ?? '');
      if (body.includes('video_check')) {
        const topic = (JSON.parse(body).params?.topic as string) ?? '';
        const jobId = `job-video-${++videoCounter}`;
        videoJobs[jobId] = topic;
        return Promise.resolve(
          jsonResponse({ job_id: jobId, run_id: 'run-1', pipeline: 'video_check', state: 'queued' }),
        );
      }
      return Promise.resolve(
        jsonResponse({ job_id: 'job-loss', run_id: 'run-1', pipeline: 'loss_report', state: 'queued' }),
      );
    }
    if (url.includes('/jobs/job-loss/status')) {
      return Promise.resolve(jsonResponse({ job_id: 'job-loss', state: 'succeeded' }));
    }
    const vStatus = url.match(/\/jobs\/(job-video-\d+)\/status/);
    if (vStatus) {
      return Promise.resolve(jsonResponse({ job_id: vStatus[1], state: 'succeeded' }));
    }
    const vResult = url.match(/\/jobs\/(job-video-\d+)\/result/);
    if (vResult) {
      const topic = videoJobs[vResult[1]!] ?? '';
      const slug = topic.replace(/^\//, '').replace(/\//g, '_');
      const file = `report/video_check/run-1/${slug}.mp4`;
      return Promise.resolve(
        jsonResponse({
          summary: { run_id: 'run-1', topic, frames: 120, fps: 15, file },
          artifacts: [file],
        }),
      );
    }
    if (url.includes('/runs/run-1')) {
      if ((init as RequestInit | undefined)?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(
        jsonResponse({
          run_id: 'run-1',
          state: 'completed',
          started_at: '2026-06-24T01:00:00.000Z',
          ended_at: '2026-06-24T01:05:00.000Z',
          topics: [
            { name: '/tf', type: 'tf2_msgs/TFMessage' },
            { name: '/cam/image_raw/compressed', type: 'sensor_msgs/CompressedImage' },
            { name: '/cam2/image_raw/compressed', type: 'sensor_msgs/CompressedImage' },
          ],
          compression: 'zstd',
          manifest: { version: 1 },
          loss: {
            run_id: 'run-1',
            topics: [
              { name: '/scan', type: 'sensor_msgs/LaserScan', hz: 10, loss_rate: 0, gap_max_ms: 105 },
            ],
          },
        }),
      );
    }
    if (url.includes('/runs')) {
      return Promise.resolve(
        jsonResponse({
          items: [
            { run_id: 'run-1', state: 'completed' },
            { run_id: 'run-2', state: 'recording' },
          ],
          next_cursor: null,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => vi.restoreAllMocks());

test('lists runs and opens a detail view with manifest', async () => {
  renderWithClient(<RunsTab />);

  await waitFor(() => expect(screen.getByText('run-1')).toBeInTheDocument());
  expect(screen.getByText('run-2')).toBeInTheDocument();

  // Open detail.
  fireEvent.click(screen.getByRole('button', { name: /run-1/ }));

  await waitFor(() => expect(screen.getByText('/tf')).toBeInTheDocument());
  expect(screen.getByText('zstd')).toBeInTheDocument();
  // Manifest is rendered in a collapsible JSON block.
  expect(screen.getByText('Manifest')).toBeInTheDocument();
});

test('renders the loss table and runs a loss_report job', async () => {
  renderWithClient(<RunsTab />);

  await waitFor(() => expect(screen.getByText('run-1')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /run-1/ }));
  await waitFor(() => expect(screen.getByText('/tf')).toBeInTheDocument());

  // The loss section + its table (from run.loss) are present for a completed run.
  expect(screen.getByText('Loss report')).toBeInTheDocument();
  expect(screen.getByText('Max gap (ms)')).toBeInTheDocument();
  expect(screen.getByText('0%')).toBeInTheDocument();

  // Launching the job POSTs a loss_report job for this run.
  fireEvent.click(screen.getByRole('button', { name: 'Run loss report' }));
  await waitFor(() => {
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      calls.some(
        (c) =>
          String(c[0]).includes('/jobs') &&
          (c[1] as RequestInit | undefined)?.method === 'POST' &&
          String((c[1] as RequestInit).body).includes('loss_report'),
      ),
    ).toBe(true);
  });
});

test('renders the video-check section and plays the mp4 after a job', async () => {
  renderWithClient(<RunsTab />);

  await waitFor(() => expect(screen.getByText('run-1')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /run-1/ }));
  await waitFor(() => expect(screen.getByText('/tf')).toBeInTheDocument());

  // The camera topic from run.topics is offered as a <select> option.
  expect(screen.getByText('Video check')).toBeInTheDocument();
  const select = screen.getByLabelText('camera topic') as HTMLSelectElement;
  expect(select.value).toBe('/cam/image_raw/compressed');

  // Pressing the button POSTs a video_check job for the selected topic.
  fireEvent.click(screen.getByRole('button', { name: 'Generate mp4' }));
  await waitFor(() => {
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      calls.some(
        (c) =>
          String(c[0]).includes('/jobs') &&
          (c[1] as RequestInit | undefined)?.method === 'POST' &&
          String((c[1] as RequestInit).body).includes('video_check') &&
          String((c[1] as RequestInit).body).includes('/cam/image_raw/compressed'),
      ),
    ).toBe(true);
  });

  // On success the served mp4 is rendered in a <video> element.
  await waitFor(() => {
    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toContain(
      '/api/v1/files/report/video_check/run-1/cam_image_raw_compressed.mp4',
    );
  });
});

// Regression (KI-VAL-01): a FAILED video_check must surface its error instead of
// spinning on "Generating…" forever (the player used to fetch the result only on
// `succeeded`).
test('surfaces a failed video_check instead of spinning on "Generating…"', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method;
    if (url.includes('/jobs') && method === 'POST') {
      return Promise.resolve(
        jsonResponse({ job_id: 'job-v-fail', run_id: 'run-1', pipeline: 'video_check', state: 'queued' }),
      );
    }
    if (url.includes('/jobs/job-v-fail/status')) {
      return Promise.resolve(jsonResponse({ job_id: 'job-v-fail', state: 'failed' }));
    }
    if (url.includes('/jobs/job-v-fail/result')) {
      return Promise.resolve(
        jsonResponse({
          summary: {
            result: 'fail',
            error: {
              error: { code: 'topic_required', message: "video_check requires a camera 'topic' param." },
            },
          },
          artifacts: [],
        }),
      );
    }
    if (url.includes('/runs/run-1')) {
      return Promise.resolve(
        jsonResponse({
          run_id: 'run-1',
          state: 'completed',
          started_at: '2026-06-24T01:00:00.000Z',
          ended_at: '2026-06-24T01:05:00.000Z',
          topics: [{ name: '/cam/image_raw/compressed', type: 'sensor_msgs/CompressedImage' }],
        }),
      );
    }
    if (url.includes('/runs')) {
      return Promise.resolve(
        jsonResponse({ items: [{ run_id: 'run-1', state: 'completed' }], next_cursor: null }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });

  renderWithClient(<RunsTab />);
  await waitFor(() => expect(screen.getByText('run-1')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /run-1/ }));
  await waitFor(() => expect(screen.getByText('Video check')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'Generate mp4' }));

  // The failure (topic_required) is shown; "Generating…" must not persist.
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/topic_required/));
  expect(screen.queryByText('Generating…')).not.toBeInTheDocument();
});

test('"All cameras" renders one player per camera topic', async () => {
  renderWithClient(<RunsTab />);
  await waitFor(() => expect(screen.getByText('run-1')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /run-1/ }));
  await waitFor(() => expect(screen.getByText('Video check')).toBeInTheDocument());

  // Two camera topics in the run -> "All cameras" generates two players.
  fireEvent.click(screen.getByRole('button', { name: 'All cameras' }));
  await waitFor(() => expect(document.querySelectorAll('video').length).toBe(2));
});

test('deletes a run after confirm and clears the detail', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  renderWithClient(<RunsTab />);

  await waitFor(() => expect(screen.getByText('run-1')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /run-1/ }));
  await waitFor(() => expect(screen.getByText('/tf')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

  // A DELETE request is issued for the run.
  await waitFor(() => {
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      calls.some(
        (c) =>
          String(c[0]).includes('/runs/run-1') &&
          (c[1] as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toBe(true);
  });
  // Detail is cleared back to the placeholder.
  await waitFor(() =>
    expect(screen.getByText(/Select a run to see details/)).toBeInTheDocument(),
  );
});
