import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { DatasetDetail, DatasetEntry, DatasetsResponse, RunEpisode } from '../../api/types';
import { useUiStore } from '../../store/uiStore';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { DatasetsScreen } from './DatasetsScreen';

/** A server episode join for the label-chip cases. */
function epJoin(overrides: Partial<RunEpisode> = {}): RunEpisode {
  return {
    episode_id: 'e_1',
    batch_id: 'b_4',
    index_in_batch: 1,
    task_result: 'success',
    quality: 'good',
    review_status: 'adopted',
    batch_seq: 4,
    batch_created_at: '2026-07-13T09:00:00Z',
    ...overrides,
  };
}

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

interface MockOpts {
  list?: DatasetsResponse;
  listStatus?: number;
  details?: Record<string, DatasetDetail>;
}

// Routes the endpoints the catalog-only Datasets screen touches: the /jobs
// route (post-export inspection) matches before the /datasets list and detail
// routes. There is no per-run export path here anymore (Review owns export).
function mockFetch(opts: MockOpts) {
  const details = opts.details ?? {};
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);

    if (url.includes('/jobs')) {
      // Both the create POST and the status poll resolve terminal-succeeded.
      return Promise.resolve(jsonResponse({ job_id: 'job_1', pipeline: 'loss_report', state: 'succeeded' }));
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

beforeEach(() => {
  setApiBase('/api/v1');
  // The Go-to-Review pointer flips the shared tab store; reset it between tests.
  useUiStore.setState({ activeTab: 'datasets' });
});
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

// ---- Catalog-only: export lives in Review now ---------------------------

test('the per-run export panel is gone; the rail points to Review instead', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId('review-pointer')).toBeInTheDocument());
  // The old ExportRecordings working panel and its controls no longer exist.
  expect(screen.queryByTestId('export-recordings')).toBeNull();
  expect(screen.queryByTestId('export-all-btn')).toBeNull();
  // The rail explains where export moved to.
  expect(
    within(screen.getByTestId('review-pointer')).getByText(/reviewed and exported in/),
  ).toBeInTheDocument();
});

test('"Go to Review" switches the active tab to Review (real tab switch)', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId('go-to-review')).toBeInTheDocument());
  expect(useUiStore.getState().activeTab).toBe('datasets');
  fireEvent.click(screen.getByTestId('go-to-review'));
  expect(useUiStore.getState().activeTab).toBe('review');
});

// ---- Block 3: dataset label chips (only when the backend attributes them) --

const ENTRY_LABELED: DatasetEntry = {
  operator: 'operator_a',
  task: 'folding',
  index: '002',
  dataset_dir: 'operator_a/folding/002',
  run_id: 'run_lab',
  message_count: 5000,
  exported_at: '2026-07-13T12:00:00Z',
  // The list serves the label subset FLAT (episode.json is nested only on the
  // detail payload) — mirror the real backend shape.
  quality: 'good',
  task_result: 'success',
  review_status: 'adopted',
  batch_seq: 4,
  index_in_batch: 2,
};
const ENTRY_LEGACY: DatasetEntry = {
  operator: 'unknown_operator',
  task: 'unknown_task',
  index: '001',
  dataset_dir: 'unknown_operator/unknown_task/001',
  run_id: 'run_leg',
  message_count: 100,
  exported_at: '2026-06-01T12:00:00Z',
};

test('a dataset card shows episode label chips when the backend attributes them', async () => {
  mockFetch({ list: { datasets: [ENTRY_LABELED] } });
  renderWithClient(<DatasetsScreen />);

  const testId = `dataset-card-labels-${ENTRY_LABELED.dataset_dir}`;
  await waitFor(() => expect(screen.getByTestId(testId)).toBeInTheDocument());
  const labels = screen.getByTestId(testId);
  expect(within(labels).getByText('GOOD')).toBeInTheDocument();
  expect(within(labels).getByText('SUCCESS')).toBeInTheDocument();
  expect(within(labels).getByText(/#4/)).toBeInTheDocument();
});

test('a dataset card shows NO label chips when the episode is absent (no fabrication)', async () => {
  // ENTRY_A1 carries no `episode` field.
  mockFetch({ list: { datasets: [ENTRY_A1] } });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId(`dataset-card-${ENTRY_A1.dataset_dir}`)).toBeInTheDocument());
  expect(screen.queryByTestId(`dataset-card-labels-${ENTRY_A1.dataset_dir}`)).toBeNull();
});

test('an unattributed export gets a muted "legacy (pre-label) export" treatment', async () => {
  mockFetch({ list: { datasets: [ENTRY_LEGACY] } });
  renderWithClient(<DatasetsScreen />);

  const legacyId = `dataset-card-legacy-${ENTRY_LEGACY.dataset_dir}`;
  await waitFor(() => expect(screen.getByTestId(legacyId)).toBeInTheDocument());
  expect(screen.getByTestId(legacyId)).toHaveTextContent(/legacy \(pre-label\) export/);
});

test('the dataset detail shows episode label chips when present', async () => {
  const detail = detailFor(ENTRY_LABELED, {
    episode: epJoin({ quality: 'good', task_result: 'success', batch_seq: 4 }),
  });
  mockFetch({
    list: { datasets: [ENTRY_LABELED] },
    details: { [detailUrlFor(ENTRY_LABELED)]: detail },
  });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId(`dataset-card-${ENTRY_LABELED.dataset_dir}`)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(`dataset-card-${ENTRY_LABELED.dataset_dir}`));

  await waitFor(() => expect(screen.getByTestId('dataset-detail-labels')).toBeInTheDocument());
  const labels = screen.getByTestId('dataset-detail-labels');
  expect(within(labels).getByText('GOOD')).toBeInTheDocument();
  expect(within(labels).getByText('SUCCESS')).toBeInTheDocument();
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

