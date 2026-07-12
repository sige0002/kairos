import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { DatasetDetail, DatasetEntry, DatasetsResponse } from '../../api/types';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { DatasetsScreen } from './DatasetsScreen';

const ENTRY_A1: DatasetEntry = {
  operator: 'operator_a',
  task: 'pick_and_place',
  index: '001',
  dataset_dir: 'operator_a/pick_and_place/001',
  run_id: 'run_1',
  bytes: 1_200_000_000,
  message_count: 48213,
  exported_at: '2026-07-01T10:00:00Z',
};
const ENTRY_A2: DatasetEntry = {
  operator: 'operator_a',
  task: 'stacking',
  index: '001',
  dataset_dir: 'operator_a/stacking/001',
  run_id: 'run_2',
  bytes: 300_000_000,
  message_count: 9001,
  exported_at: '2026-07-02T08:00:00Z',
};
const ENTRY_B1: DatasetEntry = {
  operator: 'operator_b',
  task: 'pick_and_place',
  index: '001',
  dataset_dir: 'operator_b/pick_and_place/001',
  run_id: 'run_3',
  bytes: 500_000_000,
  message_count: 12000,
  exported_at: '2026-07-03T11:00:00Z',
};

const LIST_RESPONSE: DatasetsResponse = { datasets: [ENTRY_A1, ENTRY_A2, ENTRY_B1] };

function detailFor(entry: DatasetEntry, overrides: Partial<DatasetDetail> = {}): DatasetDetail {
  return {
    operator: entry.operator,
    task: entry.task,
    index: entry.index,
    path: entry.dataset_dir,
    dataset_dir: entry.dataset_dir,
    run_id: entry.run_id ?? null,
    state: 'completed',
    started_at: '2026-07-01T09:00:00Z',
    ended_at: '2026-07-01T09:05:00Z',
    exported_at: entry.exported_at ?? null,
    bytes: entry.bytes ?? null,
    message_count: entry.message_count ?? null,
    files: ['data_0.mcap', 'metadata.yaml', 'manifest.json'],
    topics: [
      { name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' },
      { name: '/hsrb/head_rgbd_sensor/rgb/image_raw', type: 'sensor_msgs/msg/Image' },
    ],
    manifest: null,
    dataset: null,
    validation: null,
    loss: null,
    ...overrides,
  };
}

function detailUrlFor(entry: DatasetEntry): string {
  return `/datasets/${entry.operator}/${entry.task}/${entry.index}`;
}

function mockFetch(opts: { list?: DatasetsResponse; listStatus?: number; details?: Record<string, DatasetDetail> }) {
  const details = opts.details ?? {};
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.endsWith('/datasets')) {
      if (opts.listStatus && opts.listStatus >= 400) {
        return Promise.resolve(jsonResponse({ error: { message: 'unreachable' } }, opts.listStatus));
      }
      return Promise.resolve(jsonResponse(opts.list ?? { datasets: [] }));
    }
    for (const [key, detail] of Object.entries(details)) {
      if (url.includes(key)) return Promise.resolve(jsonResponse(detail));
    }
    return Promise.resolve(jsonResponse({ error: { message: 'not found' } }, 404));
  });
}

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

test('renders the real exported datasets, grouped by operator, with no fabricated names', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId(`dataset-card-${ENTRY_A1.dataset_dir}`)).toBeInTheDocument());
  expect(screen.getByText('operator_a')).toBeInTheDocument();
  expect(screen.getByText('operator_b')).toBeInTheDocument();
  expect(within(screen.getByTestId(`dataset-card-${ENTRY_A1.dataset_dir}`)).getByText('pick_and_place')).toBeInTheDocument();
  expect(within(screen.getByTestId(`dataset-card-${ENTRY_A1.dataset_dir}`)).getByText('48,213 msgs')).toBeInTheDocument();

  // No trace of the earlier fabricated demo catalog anywhere on the screen.
  expect(screen.queryByText(/PickPlace/)).not.toBeInTheDocument();
});

test('selecting a dataset fetches and shows its real detail metadata', async () => {
  mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(ENTRY_A1)]: detailFor(ENTRY_A1) },
  });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId(`dataset-card-${ENTRY_A1.dataset_dir}`)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(`dataset-card-${ENTRY_A1.dataset_dir}`));

  await waitFor(() => expect(screen.getByTestId('dataset-stats')).toBeInTheDocument());
  const stats = screen.getByTestId('dataset-stats');
  expect(within(stats).getByText('48,213')).toBeInTheDocument(); // messages
  expect(within(stats).getByText('1.2 GB')).toBeInTheDocument(); // size
  expect(within(stats).getByText('2')).toBeInTheDocument(); // topics count
  expect(screen.getByTestId('dataset-detail-name')).toHaveTextContent('operator_a / pick_and_place');

  const rail = screen.getByTestId('export-details');
  expect(within(rail).getByText('run_1')).toBeInTheDocument();
  expect(within(rail).getByText('completed')).toBeInTheDocument();
});

test('sections with no real source render an honest note, not a fake chart', async () => {
  mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(ENTRY_A1)]: detailFor(ENTRY_A1) },
  });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId(`dataset-card-${ENTRY_A1.dataset_dir}`)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(`dataset-card-${ENTRY_A1.dataset_dir}`));

  await waitFor(() => expect(screen.getByTestId('dataset-breakdown-note')).toBeInTheDocument());
  expect(screen.getByTestId('dataset-breakdown-note')).toHaveTextContent(/not available yet|Phase 2/);
  // No fake condition-coverage / operator-mix chart content.
  expect(screen.queryByText(/underrepresented/)).not.toBeInTheDocument();
  expect(screen.queryByText('Condition coverage')).not.toBeInTheDocument();
  expect(screen.queryByText('Episodes by operator')).not.toBeInTheDocument();
});

test('shows an honest empty state when there are no exported datasets (not a blank panel)', async () => {
  mockFetch({ list: { datasets: [] } });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId('dataset-list-empty')).toBeInTheDocument());
  const emptyState = screen.getByTestId('dataset-list-empty');
  expect(within(emptyState).getByText('No datasets yet.')).toBeInTheDocument();
  expect(within(emptyState).getByText(/Phase 2/)).toBeInTheDocument();
  // The detail/rail columns still render their static skeleton, never blank.
  expect(screen.getByText('① RECIPE')).toBeInTheDocument();
  expect(screen.getByTestId('build-dataset-btn')).toBeInTheDocument();
});

test('renders the same honest empty state when the backend is unreachable', async () => {
  mockFetch({ listStatus: 503 });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId('dataset-list-empty')).toBeInTheDocument());
  const emptyState = screen.getByTestId('dataset-list-empty');
  expect(within(emptyState).getByText('No datasets yet.')).toBeInTheDocument();
  expect(within(emptyState).getByText(/backend/i)).toBeInTheDocument();
});

test('clicking "+ New" shows the Phase 2 toast', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId(`dataset-card-${ENTRY_A1.dataset_dir}`)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('new-dataset-btn'));

  expect(screen.getByTestId('toast')).toHaveTextContent('New dataset is a Phase 2 feature');
});

test('clicking "Build dataset" toasts that it needs the Phase 2 recipe model, with no progress animation', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId('build-dataset-btn')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('build-dataset-btn'));

  expect(screen.getByTestId('toast')).toHaveTextContent('requires the Phase 2 recipe model');
  expect(screen.queryByTestId('build-progress')).not.toBeInTheDocument();
});
