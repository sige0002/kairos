import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { renderWithClient, jsonResponse } from '../../test/renderWithClient';
import { DatasetTab } from './DatasetTab';

const RUNS = {
  items: [
    { run_id: 'run_001', state: 'completed', operator: 'yuki', task: 'pick' },
  ],
  next_cursor: null,
};

const DATASETS = {
  datasets: [
    {
      operator: 'yuki',
      task: 'pick',
      index: '001',
      dataset_dir: '/data/yuki/pick/001',
      run_id: 'run_000',
      bytes: 2048,
      exported_at: '2026-06-26T00:00:00.000Z',
    },
  ],
};

// GET /datasets/{op}/{task}/{index} — the detail behind the inspection pane.
const DETAIL = {
  operator: 'yuki',
  task: 'pick',
  index: '001',
  path: 'yuki/pick/001',
  dataset_dir: '/data/yuki/pick/001',
  run_id: 'run_000',
  state: 'completed',
  started_at: '2026-06-25T23:00:00.000Z',
  ended_at: '2026-06-25T23:01:00.000Z',
  exported_at: '2026-06-26T00:00:00.000Z',
  bytes: 2048,
  message_count: 9,
  files: ['run_000_0.mcap', 'metadata.yaml'],
  topics: [
    { name: '/cam/image/compressed', type: 'sensor_msgs/msg/CompressedImage' },
    { name: '/tf', type: 'tf2_msgs/msg/TFMessage' },
  ],
  manifest: null,
  dataset: null,
  validation: { result: 'pass' },
  loss: null,
};

let exportBody: Record<string, unknown> | null = null;
let exportAllCalled = false;
let deletedUrl: string | null = null;

beforeEach(() => {
  setApiBase('/api/v1');
  exportBody = null;
  exportAllCalled = false;
  deletedUrl = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.endsWith('/datasets/export-all')) {
      exportAllCalled = true;
      return Promise.resolve(jsonResponse({ exported: [{}], failed: [], total: 1 }));
    }
    if (url.endsWith('/datasets/export')) {
      exportBody = JSON.parse(String((init as RequestInit).body));
      return Promise.resolve(
        jsonResponse({ index: '002', dataset_dir: '/data/yuki/pick/002' }),
      );
    }
    if ((init as RequestInit | undefined)?.method === 'DELETE') {
      deletedUrl = url;
      // Deleted: the datasets list refetch below returns empty.
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.includes('/datasets/yuki/pick/001'))
      return Promise.resolve(jsonResponse(DETAIL));
    if (url.includes('/datasets'))
      return Promise.resolve(
        jsonResponse(deletedUrl ? { datasets: [] } : DATASETS),
      );
    if (url.includes('/runs')) return Promise.resolve(jsonResponse(RUNS));
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => vi.restoreAllMocks());

test('lists exported datasets grouped by operator/task and the completed run', async () => {
  renderWithClient(<DatasetTab />);
  // Datasets section: the exported dataset card.
  await waitFor(() =>
    expect(screen.getByTestId('dataset-dir')).toHaveTextContent('/data/yuki/pick/001'),
  );
  expect(screen.getByText('#001')).toBeInTheDocument();
  // Export section: the completed run with operator/task and an Export button.
  expect(screen.getByText('run_001')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
});

test('exporting a run posts to /datasets/export with the run_id', async () => {
  renderWithClient(<DatasetTab />);
  await waitFor(() => expect(screen.getByText('run_001')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'Export' }));

  await waitFor(() => expect(exportBody).not.toBeNull());
  expect(exportBody).toMatchObject({ run_id: 'run_001' });
});

test('export-all posts to /datasets/export-all and shows the tally', async () => {
  renderWithClient(<DatasetTab />);
  await waitFor(() => expect(screen.getByText('run_001')).toBeInTheDocument());

  fireEvent.click(
    screen.getByRole('button', { name: 'Export all completed recordings' }),
  );

  await waitFor(() => expect(exportAllCalled).toBe(true));
  await waitFor(() =>
    expect(screen.getByTestId('export-all-result')).toHaveTextContent(
      '1 exported, 0 failed',
    ),
  );
});

test('selecting a dataset opens the recording-like detail view', async () => {
  renderWithClient(<DatasetTab />);
  await waitFor(() =>
    expect(screen.getByTestId('dataset-dir')).toHaveTextContent('/data/yuki/pick/001'),
  );
  // Nothing selected yet: no detail pane.
  expect(screen.queryByLabelText('dataset detail')).not.toBeInTheDocument();

  fireEvent.click(screen.getByText('#001'));

  // Detail pane: metadata, topics (with types), and the inspection sections.
  await waitFor(() => expect(screen.getByText('Topics (2)')).toBeInTheDocument());
  expect(screen.getByText('run_000')).toBeInTheDocument();
  expect(screen.getByText('/tf')).toBeInTheDocument();
  expect(screen.getByText('sensor_msgs/msg/CompressedImage')).toBeInTheDocument();
  // The camera topic enables the video check section; loss report is runnable.
  expect(screen.getByText('Video check')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Run loss report' })).toBeEnabled();
  // Validation JSON survived the export and is offered as a block.
  expect(screen.getByText('Validation')).toBeInTheDocument();
});

test('the detail pane minimizes to a slim bar and expands again', async () => {
  renderWithClient(<DatasetTab />);
  await waitFor(() =>
    expect(screen.getByTestId('dataset-dir')).toHaveTextContent('/data/yuki/pick/001'),
  );
  fireEvent.click(screen.getByText('#001'));
  await waitFor(() => expect(screen.getByText('Topics (2)')).toBeInTheDocument());

  // Minimize: the detail pane goes away, a slim bar keeps the selection.
  fireEvent.click(screen.getByRole('button', { name: 'Minimize dataset detail' }));
  expect(screen.queryByText('Topics (2)')).not.toBeInTheDocument();
  const bar = screen.getByRole('button', { name: 'Expand dataset detail' });
  expect(bar).toHaveTextContent('yuki/pick/001');

  // Expand: the same dataset's detail comes back.
  fireEvent.click(bar);
  await waitFor(() => expect(screen.getByText('Topics (2)')).toBeInTheDocument());
});

test('deletes a dataset after confirming in the modal and clears the detail', async () => {
  renderWithClient(<DatasetTab />);
  await waitFor(() =>
    expect(screen.getByTestId('dataset-dir')).toHaveTextContent('/data/yuki/pick/001'),
  );
  fireEvent.click(screen.getByText('#001'));
  await waitFor(() => expect(screen.getByText('Topics (2)')).toBeInTheDocument());

  // The detail Delete button opens a confirm modal; nothing is deleted yet.
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('yuki/pick/001');
  expect(deletedUrl).toBeNull();

  // Confirming issues DELETE /datasets/{op}/{task}/{index}.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() =>
    expect(deletedUrl).toContain('/api/v1/datasets/yuki/pick/001'),
  );

  // The detail pane closes and the refreshed (now empty) list shows through.
  await waitFor(() =>
    expect(screen.queryByLabelText('dataset detail')).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(screen.getByText('No datasets yet.')).toBeInTheDocument());
});

test('cancelling the delete modal leaves the dataset alone', async () => {
  renderWithClient(<DatasetTab />);
  await waitFor(() =>
    expect(screen.getByTestId('dataset-dir')).toHaveTextContent('/data/yuki/pick/001'),
  );
  fireEvent.click(screen.getByText('#001'));
  await waitFor(() => expect(screen.getByText('Topics (2)')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(deletedUrl).toBeNull();
  // The selection (detail pane) is untouched.
  expect(screen.getByText('Topics (2)')).toBeInTheDocument();
});

test('empty datasets show the empty state', async () => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/datasets')) return Promise.resolve(jsonResponse({ datasets: [] }));
    if (url.includes('/runs')) return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<DatasetTab />);
  await waitFor(() => expect(screen.getByText('No datasets yet.')).toBeInTheDocument());
});
