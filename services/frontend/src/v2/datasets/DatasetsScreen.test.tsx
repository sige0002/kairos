import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  DatasetDetail,
  DatasetEntry,
  DatasetsResponse,
  ExportAllResponse,
  Page,
  RunSummary,
} from '../../api/types';
import { jsonResponse, makeTestClient, renderWithClient } from '../../test/renderWithClient';
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

// Two completed runs (exportable) + one still recording (must be filtered out).
const RUN_DONE_1: RunSummary = {
  run_id: 'run_done_1',
  state: 'completed',
  started_at: '2026-07-10T10:00:00Z',
  operator: 'operator_a',
  task: 'pick_and_place',
};
const RUN_DONE_2: RunSummary = {
  run_id: 'run_done_2',
  state: 'completed',
  started_at: '2026-07-10T11:00:00Z',
  operator: 'operator_b',
  task: 'stacking',
};
const RUN_RECORDING: RunSummary = {
  run_id: 'run_live',
  state: 'recording',
  started_at: '2026-07-10T12:00:00Z',
  operator: 'operator_a',
  task: 'pick_and_place',
};
const RUNS_PAGE: Page<RunSummary> = {
  items: [RUN_DONE_1, RUN_DONE_2, RUN_RECORDING],
  next_cursor: null,
};

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

interface MockOpts {
  list?: DatasetsResponse;
  listStatus?: number;
  details?: Record<string, DatasetDetail>;
  runs?: Page<RunSummary>;
  exportAll?: ExportAllResponse;
}

// Routes every endpoint the Datasets screen now touches. Order matters: the
// specific /datasets/export[-all] and /jobs routes are matched before the
// /datasets list and detail routes.
function mockFetch(opts: MockOpts) {
  const details = opts.details ?? {};
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);

    if (url.includes('/datasets/export-all')) {
      return Promise.resolve(
        jsonResponse(opts.exportAll ?? { exported: [], failed: [], total: 0 }),
      );
    }
    if (url.includes('/datasets/export')) {
      return Promise.resolve(jsonResponse({ run_id: 'run_done_1', dataset_dir: 'x/y/001' }));
    }
    if (url.includes('/jobs')) {
      // Both the create POST and the status poll resolve terminal-succeeded.
      return Promise.resolve(jsonResponse({ job_id: 'job_1', pipeline: 'loss_report', state: 'succeeded' }));
    }
    if (url.includes('/runs')) {
      return Promise.resolve(jsonResponse(opts.runs ?? { items: [], next_cursor: null }));
    }
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

// ---- Export operations (v1 parity) --------------------------------------

test('lists only completed recordings as exportable (filters non-completed)', async () => {
  mockFetch({ list: { datasets: [] }, runs: RUNS_PAGE });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId('export-run-run_done_1')).toBeInTheDocument());
  expect(screen.getByTestId('export-run-run_done_2')).toBeInTheDocument();
  // The still-recording run must never appear as exportable.
  expect(screen.queryByTestId('export-run-run_live')).not.toBeInTheDocument();
  // Count + "Export all (2)" reflect the completed subset only.
  expect(screen.getByTestId('export-all-btn')).toHaveTextContent('Export all (2)');
  expect(within(screen.getByTestId('export-recordings')).getByText('2 completed')).toBeInTheDocument();
});

test('honest empty state when there are no completed recordings to export', async () => {
  mockFetch({ list: { datasets: [] }, runs: { items: [RUN_RECORDING], next_cursor: null } });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId('export-empty')).toBeInTheDocument());
  expect(screen.getByTestId('export-empty')).toHaveTextContent(/No completed recordings/);
  expect(screen.getByTestId('export-all-btn')).toBeDisabled();
});

test('per-run Export moves the run: POST /datasets/export then invalidates BOTH runs and datasets', async () => {
  const fetchSpy = mockFetch({ list: { datasets: [] }, runs: RUNS_PAGE });
  const client = makeTestClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  renderWithClient(<DatasetsScreen />, { client });

  await waitFor(() => expect(screen.getByTestId('export-run-btn-run_done_1')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('export-run-btn-run_done_1'));

  // The export POST carries the clicked run_id.
  await waitFor(() => {
    const call = fetchSpy.mock.calls.find(
      ([u, i]) => String(u).includes('/datasets/export') && (i?.method ?? '').toUpperCase() === 'POST',
    );
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ run_id: 'run_done_1' });
  });

  // MOVE semantics: exactly the v1 double invalidation (runs list + datasets list).
  await waitFor(() => {
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs(undefined) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.datasets });
  });
});

test('Export all reports "N exported, M failed" with a failure list and double invalidation', async () => {
  const exportAll: ExportAllResponse = {
    exported: [{ run_id: 'run_done_1' }],
    failed: [{ run_id: 'run_done_2', error: 'no files on disk' }],
    total: 2,
  };
  mockFetch({ list: { datasets: [] }, runs: RUNS_PAGE, exportAll });
  const client = makeTestClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  renderWithClient(<DatasetsScreen />, { client });

  // The button is disabled until the completed runs load; a click on a disabled
  // button is a no-op, so wait for it to enable first.
  await waitFor(() => expect(screen.getByTestId('export-all-btn')).toBeEnabled());
  fireEvent.click(screen.getByTestId('export-all-btn'));

  await waitFor(() => expect(screen.getByTestId('export-all-result')).toBeInTheDocument());
  expect(screen.getByTestId('export-all-result')).toHaveTextContent('1 exported, 1 failed');
  const failures = screen.getByTestId('export-all-failures');
  expect(within(failures).getByText('run_done_2')).toBeInTheDocument();
  expect(within(failures).getByText(/no files on disk/)).toBeInTheDocument();

  await waitFor(() => {
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs(undefined) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.datasets });
  });
});

// ---- Dataset inspection (v1 parity via features/inspect) -----------------

test('dataset inspection: loss report button posts a loss_report job against the exported dir', async () => {
  const fetchSpy = mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(ENTRY_A1)]: detailFor(ENTRY_A1) },
  });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId(`dataset-card-${ENTRY_A1.dataset_dir}`)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(`dataset-card-${ENTRY_A1.dataset_dir}`));

  await waitFor(() => expect(screen.getByTestId('run-loss-report-btn')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('run-loss-report-btn'));

  await waitFor(() => {
    const call = fetchSpy.mock.calls.find(
      ([u, i]) => String(u).includes('/jobs') && (i?.method ?? '').toUpperCase() === 'POST',
    );
    expect(call).toBeTruthy();
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body.pipeline).toBe('loss_report');
    expect(body.run_id).toBe('run_1');
    expect(body.params.dataset_dir).toBe(ENTRY_A1.dataset_dir);
  });
});

test('dataset inspection: shows the loss table + video check, and JSON sidecars when present', async () => {
  mockFetch({
    list: LIST_RESPONSE,
    details: {
      [detailUrlFor(ENTRY_A1)]: detailFor(ENTRY_A1, {
        manifest: { compression: 'zstd' },
        loss: {
          run_id: 'run_1',
          topics: [{ name: '/hsrb/joint_states', hz: 40, loss_rate: 0, gap_max_ms: 30 }],
        },
      }),
    },
  });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId(`dataset-card-${ENTRY_A1.dataset_dir}`)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(`dataset-card-${ENTRY_A1.dataset_dir}`));

  await waitFor(() => expect(screen.getByTestId('dataset-inspection')).toBeInTheDocument());
  const inspection = screen.getByTestId('dataset-inspection');
  // Reused LossTable renders the computed per-topic row.
  expect(within(inspection).getByText('/hsrb/joint_states')).toBeInTheDocument();
  // Reused VideoCheckSection appears (there is a camera/image topic).
  expect(within(inspection).getByText('Video check')).toBeInTheDocument();
  // Reused JsonBlock renders the manifest sidecar.
  expect(within(inspection).getByText('Manifest')).toBeInTheDocument();
});
