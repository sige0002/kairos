import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { DatasetDetail, DatasetEntry, DatasetsResponse } from '../../api/types';
import { useUiStore } from '../../store/uiStore';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { DatasetsScreen } from './DatasetsScreen';
import { slugForTestId, taskTestId } from './data';

/** Mirror the components' data-testid for a (task, condition) group row. */
function groupId(task: string, condition: string | null): string {
  return `dataset-group-${slugForTestId(task)}-${slugForTestId(condition ?? 'none')}`;
}

// ---- fixtures ------------------------------------------------------------
// A small catalog exercising the task -> condition tree: kitchen_pick has two
// conditions (dim, bright) = a collapsible task; shelf_restock has a single
// (null) condition = a leaf task; a legacy unknown_task/operator row = the
// muted bottom bucket. exported_at is staggered so recency sort is testable.

const KP_DIM_A: DatasetEntry = {
  operator: 'op_a',
  task: 'kitchen_pick',
  index: '001',
  dataset_dir: 'op_a/kitchen_pick/001',
  condition: 'dim',
  run_id: 'r1',
  message_count: 100,
  bytes: 1_000_000_000,
  exported_at: '2026-07-20T10:00:00Z',
  task_result: 'success',
  quality: 'good',
  review_status: 'adopted',
  batch_seq: 6,
  batch_id: 'b6',
  index_in_batch: 1,
};
const KP_DIM_B: DatasetEntry = {
  operator: 'op_b',
  task: 'kitchen_pick',
  index: '002',
  dataset_dir: 'op_b/kitchen_pick/002',
  condition: 'dim',
  run_id: 'r2',
  message_count: 120,
  bytes: 500_000_000,
  exported_at: '2026-07-19T10:00:00Z',
  task_result: 'failure',
  failure_reason: 'Grasp missed',
  quality: 'good',
  review_status: 'adopted',
  batch_seq: 6,
  batch_id: 'b6',
  index_in_batch: 2,
};
const KP_BRIGHT_A: DatasetEntry = {
  operator: 'op_a',
  task: 'kitchen_pick',
  index: '003',
  dataset_dir: 'op_a/kitchen_pick/003',
  condition: 'bright',
  run_id: 'r3',
  message_count: 90,
  bytes: 300_000_000,
  exported_at: '2026-07-18T10:00:00Z',
  task_result: 'success',
  quality: 'good',
  review_status: 'adopted',
  batch_seq: 7,
  batch_id: 'b7',
  index_in_batch: 1,
};
const SHELF_A: DatasetEntry = {
  operator: 'op_a',
  task: 'shelf_restock',
  index: '001',
  dataset_dir: 'op_a/shelf_restock/001',
  run_id: 'r4',
  message_count: 48213,
  bytes: 1_200_000_000,
  exported_at: '2026-07-21T10:00:00Z',
  task_result: 'success',
  quality: 'good',
  review_status: 'adopted',
  batch_seq: 2,
  batch_id: 'b2',
  index_in_batch: 1,
};
const LEGACY: DatasetEntry = {
  operator: 'unknown_operator',
  task: 'unknown_task',
  index: '001',
  dataset_dir: 'unknown_operator/unknown_task/001',
  run_id: 'rL',
  message_count: 100,
  exported_at: '2026-06-01T10:00:00Z',
};

const ALL: DatasetEntry[] = [KP_DIM_A, KP_DIM_B, KP_BRIGHT_A, SHELF_A, LEGACY];
const LIST_RESPONSE: DatasetsResponse = { datasets: ALL };

// testid helpers (computed the same way the components do).
const kitchenTask = taskTestId('kitchen_pick');
const shelfLeaf = groupId('shelf_restock', null);
const dimGroup = groupId('kitchen_pick', 'dim');
const brightGroup = groupId('kitchen_pick', 'bright');
const legacyGroup = groupId('unknown_task', null);

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

let deletedUrls: string[] = [];

function mockFetch(opts: MockOpts) {
  const details = opts.details ?? {};
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if ((init as RequestInit | undefined)?.method === 'DELETE') {
      deletedUrls.push(url);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.includes('/jobs')) {
      return Promise.resolve(
        jsonResponse({ job_id: 'job_1', pipeline: 'loss_report', state: 'succeeded' }),
      );
    }
    if (url.endsWith('/datasets')) {
      if (opts.listStatus && opts.listStatus >= 400) {
        return Promise.resolve(
          jsonResponse({ error: { message: 'unreachable' } }, opts.listStatus),
        );
      }
      return Promise.resolve(
        jsonResponse(
          deletedUrls.length > 0 ? { datasets: [] } : (opts.list ?? { datasets: [] }),
        ),
      );
    }
    for (const [key, detail] of Object.entries(details)) {
      if (url.includes(key)) return Promise.resolve(jsonResponse(detail));
    }
    return Promise.resolve(jsonResponse({ error: { message: 'not found' } }, 404));
  });
}

beforeEach(() => {
  setApiBase('/api/v1');
  deletedUrls = [];
  useUiStore.setState({ activeTab: 'datasets' });
});
afterEach(() => vi.restoreAllMocks());

// ---- the task -> condition tree ------------------------------------------

test('folds the flat catalog into a task -> condition tree, not one card per episode', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());

  // shelf_restock is a single-(null-)condition leaf: its own selectable row.
  expect(within(screen.getByTestId(shelfLeaf)).getByText('shelf_restock')).toBeInTheDocument();

  // kitchen_pick has two conditions -> a collapsible header, collapsed by
  // default (its condition rows are NOT rendered yet).
  const header = screen.getByTestId(kitchenTask);
  expect(header).toHaveTextContent('kitchen_pick');
  expect(header).toHaveTextContent('3 eps · 2 conditions');
  expect(screen.queryByTestId(dimGroup)).toBeNull();

  // The legacy unknown_task bucket is present and labeled in plain language.
  expect(screen.getByText('task not recorded')).toBeInTheDocument();
  expect(screen.queryByText('unknown_task')).toBeNull();

  // The counter is honest about how much is shown.
  expect(screen.getByTestId('dataset-count')).toHaveTextContent('showing 5 of 5');
});

test('a group row shows only real aggregates; an unlabeled group says "no labels"', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId(kitchenTask)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(kitchenTask)); // expand

  // dim = 1 success + 1 failure; bright = 1 success, 0 failure.
  expect(within(screen.getByTestId(dimGroup)).getByText('✓1 ✗1')).toBeInTheDocument();
  expect(within(screen.getByTestId(brightGroup)).getByText('✓1 ✗0')).toBeInTheDocument();

  // The legacy group's rows carry no labels -> honest "no labels", not ✓0 ✗0.
  expect(within(screen.getByTestId(legacyGroup)).getByText('no labels')).toBeInTheDocument();
});

test('recency sort lists newest-exported first; A–Z sort lists by task name', async () => {
  mockFetch({ list: LIST_RESPONSE });
  const { container } = renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());

  const firstTaskId = () =>
    container.querySelector('[data-testid^="dataset-task-"]')?.getAttribute('data-testid');

  // Default = recent: shelf_restock exported 07-21 is newest.
  expect(firstTaskId()).toBe(taskTestId('shelf_restock'));

  fireEvent.click(screen.getByTestId('dataset-sort-toggle'));
  // A–Z: kitchen_pick precedes shelf_restock; the legacy bucket stays last.
  expect(firstTaskId()).toBe(kitchenTask);
  const ids = [...container.querySelectorAll('[data-testid^="dataset-task-"]')].map((el) =>
    el.getAttribute('data-testid'),
  );
  expect(ids[ids.length - 1]).toBe(taskTestId('unknown_task'));
});

// ---- selection: group -> episode table -> detail -------------------------

test('selecting a leaf group scopes the top pane to its episodes', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());

  // No group selected -> the whole-catalog scope (title + summary), never blank.
  expect(screen.getByTestId('dataset-scope-title')).toHaveTextContent('All datasets');
  expect(screen.getByTestId('dataset-scope-summary')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId(shelfLeaf));
  expect(screen.getByTestId('dataset-scope-title')).toHaveTextContent('shelf_restock');
  // Scoped to shelf_restock: its episode is listed, the kitchen episodes are not.
  expect(screen.getByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`)).toBeInTheDocument();
  expect(screen.queryByTestId(`dataset-episode-row-${KP_DIM_A.dataset_dir}`)).toBeNull();
});

test('selecting a condition group lists exactly that condition’s episodes', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(kitchenTask)).toBeInTheDocument());

  fireEvent.click(screen.getByTestId(kitchenTask)); // expand
  fireEvent.click(screen.getByTestId(dimGroup));

  expect(screen.getByTestId('dataset-scope-title')).toHaveTextContent('kitchen_pick');
  expect(within(screen.getByTestId('dataset-top-pane')).getByText('dim')).toBeInTheDocument();
  expect(screen.getByTestId(`dataset-episode-row-${KP_DIM_A.dataset_dir}`)).toBeInTheDocument();
  expect(screen.getByTestId(`dataset-episode-row-${KP_DIM_B.dataset_dir}`)).toBeInTheDocument();
  // The bright episode belongs to a different group and is absent.
  expect(screen.queryByTestId(`dataset-episode-row-${KP_BRIGHT_A.dataset_dir}`)).toBeNull();
});

test('an episode row shows its label chips; a failure exposes the reason on the chip', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(kitchenTask)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(kitchenTask));
  fireEvent.click(screen.getByTestId(dimGroup));

  const row = await screen.findByTestId(`dataset-episode-row-${KP_DIM_B.dataset_dir}`);
  const failure = within(row).getByText('FAILURE');
  expect(failure.closest('[title]')?.getAttribute('title')).toBe(
    'Failure reason: Grasp missed',
  );
});

test('a legacy episode row shows the honest "no episode labels" note, no chips', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(legacyGroup)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(legacyGroup));

  const row = await screen.findByTestId(`dataset-episode-row-${LEGACY.dataset_dir}`);
  expect(within(row).getByTestId(`dataset-episode-legacy-${LEGACY.dataset_dir}`)).toHaveTextContent(
    'no episode labels',
  );
  expect(screen.queryByTestId(`dataset-episode-labels-${LEGACY.dataset_dir}`)).toBeNull();
});

test('selecting an episode fetches + shows its real detail below the table', async () => {
  mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(SHELF_A)]: detailFor(SHELF_A) },
  });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());

  fireEvent.click(screen.getByTestId(shelfLeaf));
  fireEvent.click(await screen.findByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`));

  await waitFor(() => expect(screen.getByTestId('dataset-stats')).toBeInTheDocument());
  const stats = screen.getByTestId('dataset-stats');
  expect(within(stats).getByText('48,213')).toBeInTheDocument(); // messages
  expect(within(stats).getByText('1.2 GB')).toBeInTheDocument(); // size
  expect(screen.getByTestId('dataset-detail-name')).toHaveTextContent(
    'op_a / shelf_restock',
  );
  // The rail's real export provenance renders for the selected episode.
  expect(within(screen.getByTestId('export-details')).getByText('r4')).toBeInTheDocument();
});

test('breakdown sections with no real source render an honest note, not a fake chart', async () => {
  mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(SHELF_A)]: detailFor(SHELF_A) },
  });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(shelfLeaf));
  fireEvent.click(await screen.findByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`));

  await waitFor(() => expect(screen.getByTestId('dataset-breakdown-note')).toBeInTheDocument());
  expect(screen.getByTestId('dataset-breakdown-note')).toHaveTextContent(/Phase 2/);
  expect(screen.queryByText('Condition coverage')).not.toBeInTheDocument();
  expect(screen.queryByText('Episodes by operator')).not.toBeInTheDocument();
});

test('selecting a different group clears the episode selection', async () => {
  mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(SHELF_A)]: detailFor(SHELF_A) },
  });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());

  fireEvent.click(screen.getByTestId(shelfLeaf));
  fireEvent.click(await screen.findByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`));
  await waitFor(() => expect(screen.getByTestId('dataset-stats')).toBeInTheDocument());

  // Switch to another group -> the detail (episode selection) is gone, and the
  // bottom pane falls back to that group's summary.
  fireEvent.click(screen.getByTestId(kitchenTask));
  fireEvent.click(screen.getByTestId(dimGroup));
  expect(screen.queryByTestId('dataset-stats')).toBeNull();
  expect(screen.getByTestId('dataset-scope-title')).toHaveTextContent('kitchen_pick');
  expect(screen.getByTestId('dataset-scope-summary')).toBeInTheDocument();
});

// ---- delete flow ---------------------------------------------------------

test('Delete confirms in a modal, calls DELETE, clears selection, and toasts', async () => {
  mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(SHELF_A)]: detailFor(SHELF_A) },
  });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(shelfLeaf));
  fireEvent.click(await screen.findByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`));
  await waitFor(() => expect(screen.getByTestId('dataset-stats')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('op_a/shelf_restock/001');
  expect(deletedUrls).toHaveLength(0);

  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() =>
    expect(deletedUrls[0]).toContain('/datasets/op_a/shelf_restock/001'),
  );
  expect(screen.getByTestId('toast')).toHaveTextContent('Dataset deleted');
  // The list refetches empty -> the honest empty state shows.
  await waitFor(() => expect(screen.getByTestId('dataset-list-empty')).toBeInTheDocument());
});

test('cancelling the delete modal leaves the episode alone', async () => {
  mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(SHELF_A)]: detailFor(SHELF_A) },
  });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(shelfLeaf));
  fireEvent.click(await screen.findByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`));
  await waitFor(() => expect(screen.getByTestId('dataset-stats')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(deletedUrls).toHaveLength(0);
  expect(screen.getByTestId('dataset-stats')).toBeInTheDocument();
});

// ---- search + facets -----------------------------------------------------

test('search narrows the tree by task, operator, and batch seq (# optional)', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());
  const box = screen.getByTestId('dataset-search');

  // Task substring.
  fireEvent.change(box, { target: { value: 'shelf' } });
  expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument();
  expect(screen.queryByTestId(kitchenTask)).toBeNull();
  expect(screen.getByTestId('dataset-count')).toHaveTextContent('showing 1 of 5');

  // Operator substring.
  fireEvent.change(box, { target: { value: 'op_b' } });
  expect(screen.getByTestId('dataset-count')).toHaveTextContent('showing 1 of 5');
  // Only KP_DIM_B survives -> kitchen_pick collapses to a single-condition leaf.
  expect(screen.getByTestId(dimGroup)).toBeInTheDocument();

  // Batch seq, with and without '#' — both find seq 6 (KP_DIM_A + KP_DIM_B).
  fireEvent.change(box, { target: { value: '#6' } });
  expect(screen.getByTestId('dataset-count')).toHaveTextContent('showing 2 of 5');
  fireEvent.change(box, { target: { value: '6' } });
  expect(screen.getByTestId('dataset-count')).toHaveTextContent('showing 2 of 5');
});

test('task-result facet narrows; unlabeled rows only pass "All"', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('dataset-filter-failure'));
  // Only KP_DIM_B is a failure; legacy (unlabeled) and successes drop out.
  expect(screen.getByTestId('dataset-count')).toHaveTextContent('showing 1 of 5');
  expect(screen.queryByTestId(shelfLeaf)).toBeNull();
  expect(screen.queryByTestId(legacyGroup)).toBeNull();

  fireEvent.click(screen.getByTestId('dataset-filter-all'));
  expect(screen.getByTestId('dataset-count')).toHaveTextContent('showing 5 of 5');
});

test('operator facet narrows the tree to one operator', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());

  fireEvent.change(screen.getByTestId('dataset-operator-filter'), {
    target: { value: 'op_b' },
  });
  expect(screen.getByTestId('dataset-count')).toHaveTextContent('showing 1 of 5');
  expect(screen.getByTestId(dimGroup)).toBeInTheDocument();
  expect(screen.queryByTestId(shelfLeaf)).toBeNull();
});

test('an all-hidden filter result explains itself instead of claiming "no datasets"', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());

  fireEvent.change(screen.getByTestId('dataset-search'), { target: { value: 'zzz-nomatch' } });
  const empty = screen.getByTestId('dataset-list-empty');
  expect(empty.textContent).toContain('No datasets match');
  expect(empty.textContent).toContain('5 dataset(s) are hidden');
});

// ---- manifest ------------------------------------------------------------

test('the manifest button counts all filtered rows, or the selected group only', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());

  // No group selected -> all filtered rows.
  expect(screen.getByTestId('dataset-manifest-btn')).toHaveTextContent('Manifest (5)');

  // Select the dim condition group -> restricted to its 2 rows.
  fireEvent.click(screen.getByTestId(kitchenTask));
  fireEvent.click(screen.getByTestId(dimGroup));
  expect(screen.getByTestId('dataset-manifest-btn')).toHaveTextContent('Manifest (2)');
});

test('downloading the manifest emits the selected group’s rows with the group in the filter', async () => {
  mockFetch({ list: LIST_RESPONSE });
  const created: Blob[] = [];
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (b: Blob) => {
    created.push(b);
    return 'blob:test';
  };
  URL.revokeObjectURL = () => {};
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    renderWithClient(<DatasetsScreen />);
    await waitFor(() => expect(screen.getByTestId(kitchenTask)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(kitchenTask));
    fireEvent.click(screen.getByTestId(dimGroup));

    fireEvent.click(screen.getByTestId('dataset-manifest-btn'));
    expect(clickSpy).toHaveBeenCalled();
    const text = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error as Error);
      r.readAsText(created[0]!);
    });
    const manifest = JSON.parse(text) as {
      filter: { group: { task: string; condition: string | null } | null };
      count: number;
      episodes: { path: string; batch_id: string | null }[];
    };
    expect(manifest.filter.group).toEqual({ task: 'kitchen_pick', condition: 'dim' });
    expect(manifest.count).toBe(2);
    expect(manifest.episodes.map((e) => e.path).sort()).toEqual([
      'op_a/kitchen_pick/001',
      'op_b/kitchen_pick/002',
    ]);
    // batch_id stays in the manifest (ML-facing, per 2026-07-14 decision).
    expect(manifest.episodes[0]!.batch_id).toBe('b6');
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    clickSpy.mockRestore();
  }
});

// ---- empty states + static affordances -----------------------------------

test('honest empty state when there are no exported datasets (not a blank panel)', async () => {
  mockFetch({ list: { datasets: [] } });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId('dataset-list-empty')).toBeInTheDocument());
  expect(screen.getByTestId('dataset-list-empty')).toHaveTextContent('No datasets yet.');
  // The center shows the catalog summary (zero episodes) — honest, never blank.
  expect(screen.getByTestId('dataset-scope-summary')).toBeInTheDocument();
  expect(screen.getByTestId('dataset-summary-empty')).toBeInTheDocument();
  expect(screen.getByTestId('build-dataset-btn')).toBeInTheDocument();
});

test('the same honest empty state when the backend is unreachable', async () => {
  mockFetch({ listStatus: 503 });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId('dataset-list-empty')).toBeInTheDocument());
  const empty = screen.getByTestId('dataset-list-empty');
  expect(empty).toHaveTextContent('No datasets yet.');
  expect(empty.textContent).toMatch(/backend/i);
});

test('"+ New" and "Build dataset" only explain Phase 2, with no progress animation', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId('new-dataset-btn')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('new-dataset-btn'));
  expect(screen.getByTestId('toast')).toHaveTextContent('New dataset is a Phase 2 feature');

  fireEvent.click(screen.getByTestId('build-dataset-btn'));
  expect(screen.getByTestId('toast')).toHaveTextContent('requires the Phase 2 recipe model');
  expect(screen.queryByTestId('build-progress')).not.toBeInTheDocument();
});

test('"Go to Review" switches the active tab (Review is the single export surface)', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId('go-to-review')).toBeInTheDocument());
  expect(useUiStore.getState().activeTab).toBe('datasets');
  fireEvent.click(screen.getByTestId('go-to-review'));
  expect(useUiStore.getState().activeTab).toBe('review');
});

// ---- dataset inspection (reused features/inspect) ------------------------

test('dataset inspection posts a loss_report job against the exported dir', async () => {
  const fetchSpy = mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(SHELF_A)]: detailFor(SHELF_A) },
  });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(shelfLeaf));
  fireEvent.click(await screen.findByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`));

  await waitFor(() => expect(screen.getByTestId('run-loss-report-btn')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('run-loss-report-btn'));

  await waitFor(() => {
    const call = fetchSpy.mock.calls.find(
      ([u, i]) => String(u).includes('/jobs') && (i?.method ?? '').toUpperCase() === 'POST',
    );
    expect(call).toBeTruthy();
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body.pipeline).toBe('loss_report');
    expect(body.run_id).toBe('r4');
    expect(body.params.dataset_dir).toBe(SHELF_A.dataset_dir);
  });
});

// ---- center split: panes, episode search, toggle, scope summary ----------

test('the center is a top episode pane over a bottom detail/summary pane', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId('dataset-top-pane')).toBeInTheDocument());

  expect(screen.getByTestId('dataset-bottom-pane')).toBeInTheDocument();
  expect(screen.getByTestId('dataset-summary-row')).toBeInTheDocument();
  // Default (no episode selected) -> the bottom pane shows the scope summary.
  expect(
    within(screen.getByTestId('dataset-bottom-pane')).getByTestId('dataset-scope-summary'),
  ).toBeInTheDocument();
});

test('the episode list has a capped, internally-scrolling region', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId('dataset-episode-scroll')).toBeInTheDocument());
  const scroll = screen.getByTestId('dataset-episode-scroll');
  expect(scroll.className).toContain('overflow-y-auto');
  expect(scroll.className).toContain('max-h-[370px]'); // ~10 rows
});

test('episode search filters rows by index, #set, operator, and failure reason', async () => {
  // Whole-catalog scope lists all five episodes; the episode search narrows them.
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() =>
    expect(screen.getByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`)).toBeInTheDocument(),
  );
  const box = screen.getByTestId('dataset-episode-search');

  // index NNN
  fireEvent.change(box, { target: { value: '002' } });
  expect(screen.getByTestId(`dataset-episode-row-${KP_DIM_B.dataset_dir}`)).toBeInTheDocument();
  expect(screen.queryByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`)).toBeNull();

  // operator
  fireEvent.change(box, { target: { value: 'op_b' } });
  expect(screen.getByTestId(`dataset-episode-row-${KP_DIM_B.dataset_dir}`)).toBeInTheDocument();
  expect(screen.queryByTestId(`dataset-episode-row-${KP_DIM_A.dataset_dir}`)).toBeNull();

  // set seq, # optional -> both KP_DIM rows (batch_seq 6)
  fireEvent.change(box, { target: { value: '#6' } });
  expect(screen.getByTestId(`dataset-episode-row-${KP_DIM_A.dataset_dir}`)).toBeInTheDocument();
  expect(screen.getByTestId(`dataset-episode-row-${KP_DIM_B.dataset_dir}`)).toBeInTheDocument();

  // failure reason
  fireEvent.change(box, { target: { value: 'grasp' } });
  expect(screen.getByTestId(`dataset-episode-row-${KP_DIM_B.dataset_dir}`)).toBeInTheDocument();
  expect(screen.queryByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`)).toBeNull();

  // A no-match search explains itself; the pinned Summary row survives it.
  fireEvent.change(box, { target: { value: 'zzz-none' } });
  expect(screen.getByTestId('dataset-episode-search-empty')).toBeInTheDocument();
  expect(screen.getByTestId('dataset-summary-row')).toBeInTheDocument();
});

test('clicking a selected episode again toggles it off, back to the summary', async () => {
  mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(SHELF_A)]: detailFor(SHELF_A) },
  });
  renderWithClient(<DatasetsScreen />);
  const rowId = `dataset-episode-row-${SHELF_A.dataset_dir}`;
  await waitFor(() => expect(screen.getByTestId(rowId)).toBeInTheDocument());

  fireEvent.click(screen.getByTestId(rowId));
  await waitFor(() => expect(screen.getByTestId('dataset-stats')).toBeInTheDocument());

  // Toggle: clicking the same row again clears the selection.
  fireEvent.click(screen.getByTestId(rowId));
  expect(screen.queryByTestId('dataset-stats')).toBeNull();
  expect(screen.getByTestId('dataset-scope-summary')).toBeInTheDocument();
});

test('the pinned Summary row clears the episode selection', async () => {
  mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(SHELF_A)]: detailFor(SHELF_A) },
  });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() =>
    expect(screen.getByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`)).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`));
  await waitFor(() => expect(screen.getByTestId('dataset-stats')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('dataset-summary-row'));
  expect(screen.queryByTestId('dataset-stats')).toBeNull();
  expect(screen.getByTestId('dataset-scope-summary')).toBeInTheDocument();
});

test('the summary scope is the whole catalog by default, then the selected group', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());

  expect(screen.getByTestId('dataset-summary-scope')).toHaveTextContent('All datasets');
  fireEvent.click(screen.getByTestId(shelfLeaf));
  expect(screen.getByTestId('dataset-summary-scope')).toHaveTextContent('shelf_restock');
});

test('the summary donut rate is over LABELED rows only; unlabeled are surfaced separately', async () => {
  // Catalog: 3 success + 1 failure labeled, 1 unlabeled (LEGACY). 3/4 = 75%.
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId('dataset-outcome-donut')).toBeInTheDocument());

  expect(screen.getByTestId('dataset-success-rate')).toHaveTextContent('75%');
  // The unlabeled row is stated, not folded into the rate as a success.
  expect(screen.getByTestId('dataset-summary-unlabeled')).toHaveTextContent('1 without labels');
  // Quality tallies are real (all four labeled rows are "good").
  expect(screen.getByTestId('dataset-summary-quality')).toHaveTextContent('Good 4');
});

test('a scope with zero labeled rows shows an honest note, not a fabricated donut', async () => {
  mockFetch({ list: { datasets: [LEGACY] } });
  renderWithClient(<DatasetsScreen />);
  // Wait for the (unlabeled) row to load so the scope has episodes but no labels.
  await waitFor(() =>
    expect(screen.getByTestId(`dataset-episode-row-${LEGACY.dataset_dir}`)).toBeInTheDocument(),
  );

  expect(screen.getByTestId('dataset-donut-empty')).toBeInTheDocument();
  expect(screen.queryByTestId('dataset-outcome-donut')).toBeNull();
  expect(screen.queryByTestId('dataset-success-rate')).toBeNull();
});

test('narrowing the catalog cannot leave Delete pointed at an off-screen episode', async () => {
  // Regression (2026-07-27 UX review, blocker): selecting an episode and then
  // typing an unrelated search left the detail pane — and its live Delete —
  // bound to a row the list no longer showed. The operator would be reading one
  // dataset on screen while the destructive control pointed at another.
  mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(SHELF_A)]: detailFor(SHELF_A) },
  });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(shelfLeaf));
  fireEvent.click(await screen.findByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`));
  await waitFor(() => expect(screen.getByTestId('dataset-stats')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();

  // Narrow to something that excludes the selected episode.
  fireEvent.change(screen.getByTestId('dataset-search'), {
    target: { value: 'kitchen' },
  });

  // The detail pane and its Delete are gone; the scope summary takes over.
  await waitFor(() => expect(screen.queryByTestId('dataset-stats')).toBeNull());
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  expect(screen.getByTestId('dataset-scope-summary')).toBeInTheDocument();

  // Clearing the search restores the selection rather than losing it.
  fireEvent.change(screen.getByTestId('dataset-search'), { target: { value: '' } });
  await waitFor(() => expect(screen.getByTestId('dataset-stats')).toBeInTheDocument());
});
