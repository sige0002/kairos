import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { RuntimeConfig } from '../../config';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { PipelinesTab } from './PipelinesTab';

const CONFIG: RuntimeConfig = {
  endpoints: {
    api: '/api/v1',
    events: '/api/v1/events',
    webrtc: 'http://localhost:8002',
  },
  tabs: [],
  defaults: {},
  schemas: {
    pipeline_forms: {
      fast_validation: {
        type: 'object',
        required: ['template'],
        properties: { template: { title: 'Template', type: 'string' } },
      },
    },
  },
};

beforeEach(() => {
  setApiBase('/api/v1');
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/pipelines')) {
      return Promise.resolve(
        jsonResponse([{ id: 'fast_validation', name: 'Fast validation' }]),
      );
    }
    if (url.endsWith('/jobs')) {
      return Promise.resolve(
        jsonResponse({ job_id: 'job-1', pipeline: 'fast_validation', state: 'queued' }),
      );
    }
    if (url.includes('/jobs/job-1/status')) {
      return Promise.resolve(
        jsonResponse({
          job_id: 'job-1',
          pipeline: 'fast_validation',
          state: 'running',
          progress: 0.5,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => vi.restoreAllMocks());

test('submits a schema-driven pipeline job and shows job status', async () => {
  renderWithClient(<PipelinesTab config={CONFIG} />);

  // Pick the pipeline -> its form renders from config.schemas.pipeline_forms.
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Fast validation' })).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Fast validation' }));

  fireEvent.change(screen.getByLabelText(/Template/), {
    target: { value: 'hsr_default' },
  });
  fireEvent.click(screen.getByRole('button', { name: /Run pipeline/i }));

  // POST /jobs with the pipeline + params.
  await waitFor(() => {
    const body = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).endsWith('/jobs'),
    )?.[1] as RequestInit | undefined;
    expect(body).toBeTruthy();
    expect(JSON.parse(String(body?.body))).toMatchObject({
      pipeline: 'fast_validation',
      params: { template: 'hsr_default' },
    });
  });

  // Job status appears (seeded from the submit response: state "queued").
  await waitFor(() => expect(screen.getByText(/job-1/)).toBeInTheDocument());
  expect(screen.getByText(/queued/)).toBeInTheDocument();
});
