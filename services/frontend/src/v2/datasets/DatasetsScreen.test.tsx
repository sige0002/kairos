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
  /** GET /datasets/archive/config — absent means the feature is off. */
  archive?: { enabled: boolean; roots: string[] };
  /** Terminal state the polled archive job reports (default succeeded). */
  archiveJobState?: string;
}

let deletedUrls: string[] = [];
let archivePosts: { url: string; body: Record<string, unknown> }[] = [];

function mockFetch(opts: MockOpts) {
  const details = opts.details ?? {};
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if ((init as RequestInit | undefined)?.method === 'DELETE') {
      deletedUrls.push(url);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.endsWith('/datasets/archive/config')) {
      return Promise.resolve(
        jsonResponse(opts.archive ?? { enabled: false, roots: [] }),
      );
    }
    if (url.endsWith('/archive') && (init as RequestInit | undefined)?.method === 'POST') {
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      archivePosts.push({ url, body });
      return Promise.resolve(
        jsonResponse(
          {
            job_id: 'job_archive',
            pipeline: 'dataset_archive',
            destination: body.destination,
          },
          202,
        ),
      );
    }
    if (url.includes('/jobs/job_archive/status')) {
      return Promise.resolve(
        jsonResponse({
          job_id: 'job_archive',
          pipeline: 'dataset_archive',
          state: opts.archiveJobState ?? 'succeeded',
        }),
      );
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
  archivePosts = [];
  useUiStore.setState({ activeTab: 'datasets' });
  // The screen seeds its selection/filters from the query string and mirrors
  // them back (see url.ts), and jsdom shares one location across a file — so
  // reset it, or each test would inherit the previous test's selection.
  window.history.replaceState(null, '', '/');
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

  fireEvent.click(screen.getByRole('button', { name: /Delete permanently/ }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('op_a/shelf_restock/001');
  expect(deletedUrls).toHaveLength(0);

  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
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

  fireEvent.click(screen.getByRole('button', { name: /Delete permanently/ }));
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
  // Filtering is debounced (the box stays instant, the catalog work settles),
  // so every assertion below waits rather than reading the same tick.
  fireEvent.change(box, { target: { value: 'shelf' } });
  await waitFor(() =>
    expect(screen.getByTestId('dataset-count')).toHaveTextContent('showing 1 of 5'),
  );
  expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument();
  expect(screen.queryByTestId(kitchenTask)).toBeNull();

  // Operator substring. Waiting on the count alone would be a trap here: the
  // previous query also showed "1 of 5", so the assertion would pass on stale
  // state before the debounce fired. Wait for what DISTINGUISHES the result.
  fireEvent.change(box, { target: { value: 'op_b' } });
  // Only KP_DIM_B survives -> kitchen_pick collapses to a single-condition leaf.
  await waitFor(() => expect(screen.getByTestId(dimGroup)).toBeInTheDocument());
  expect(screen.getByTestId('dataset-count')).toHaveTextContent('showing 1 of 5');

  // Batch seq, with and without '#' — both find seq 6 (KP_DIM_A + KP_DIM_B).
  fireEvent.change(box, { target: { value: '#6' } });
  await waitFor(() =>
    expect(screen.getByTestId('dataset-count')).toHaveTextContent('showing 2 of 5'),
  );
  fireEvent.change(box, { target: { value: 'nothing-matches-this' } });
  await waitFor(() =>
    expect(screen.getByTestId('dataset-count')).toHaveTextContent('showing 0 of 5'),
  );
  fireEvent.change(box, { target: { value: '6' } });
  await waitFor(() =>
    expect(screen.getByTestId('dataset-count')).toHaveTextContent('showing 2 of 5'),
  );
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
  const empty = await screen.findByTestId('dataset-list-empty');
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

  // The episode search is debounced too, so each step waits for the row set to
  // settle rather than reading the same tick.
  // index NNN
  fireEvent.change(box, { target: { value: '002' } });
  await waitFor(() =>
    expect(screen.queryByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`)).toBeNull(),
  );
  expect(screen.getByTestId(`dataset-episode-row-${KP_DIM_B.dataset_dir}`)).toBeInTheDocument();

  // operator
  fireEvent.change(box, { target: { value: 'op_b' } });
  await waitFor(() =>
    expect(screen.queryByTestId(`dataset-episode-row-${KP_DIM_A.dataset_dir}`)).toBeNull(),
  );
  expect(screen.getByTestId(`dataset-episode-row-${KP_DIM_B.dataset_dir}`)).toBeInTheDocument();

  // set seq, # optional -> both KP_DIM rows (batch_seq 6)
  fireEvent.change(box, { target: { value: '#6' } });
  await waitFor(() =>
    expect(
      screen.getByTestId(`dataset-episode-row-${KP_DIM_A.dataset_dir}`),
    ).toBeInTheDocument(),
  );
  expect(screen.getByTestId(`dataset-episode-row-${KP_DIM_B.dataset_dir}`)).toBeInTheDocument();

  // failure reason
  fireEvent.change(box, { target: { value: 'grasp' } });
  await waitFor(() =>
    expect(screen.queryByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`)).toBeNull(),
  );
  expect(screen.getByTestId(`dataset-episode-row-${KP_DIM_B.dataset_dir}`)).toBeInTheDocument();

  // A no-match search explains itself; the pinned Summary row survives it.
  fireEvent.change(box, { target: { value: 'zzz-none' } });
  await waitFor(() =>
    expect(screen.getByTestId('dataset-episode-search-empty')).toBeInTheDocument(),
  );
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
  expect(screen.getByRole('button', { name: /Delete permanently/ })).toBeInTheDocument();

  // Narrow to something that excludes the selected episode.
  fireEvent.change(screen.getByTestId('dataset-search'), {
    target: { value: 'kitchen' },
  });

  // The detail pane and its Delete are gone; the scope summary takes over.
  await waitFor(() => expect(screen.queryByTestId('dataset-stats')).toBeNull());
  expect(screen.queryByRole('button', { name: /Delete permanently/ })).toBeNull();
  expect(screen.getByTestId('dataset-scope-summary')).toBeInTheDocument();

  // Clearing the search restores the selection rather than losing it.
  fireEvent.change(screen.getByTestId('dataset-search'), { target: { value: '' } });
  await waitFor(() => expect(screen.getByTestId('dataset-stats')).toBeInTheDocument());
});

// ---- addressability + the render cap (2026-07-26) -------------------------

/** A catalog big enough to exercise the render cap (one leaf task). */
function bigCatalog(n: number): DatasetsResponse {
  return {
    datasets: Array.from({ length: n }, (_, i) => {
      const index = String(i + 1).padStart(4, '0');
      return {
        operator: 'op_a',
        task: 'bulk_task',
        index,
        dataset_dir: `op_a/bulk_task/${index}`,
        run_id: `r${index}`,
        message_count: 10,
        bytes: 1000,
        exported_at: new Date(Date.UTC(2026, 6, 1, 0, 0, i)).toISOString(),
        task_result: 'success' as const,
        quality: 'good' as const,
        review_status: 'adopted' as const,
        batch_seq: 1,
        batch_id: 'bulk',
        index_in_batch: i + 1,
      };
    }),
  };
}

function episodeRowCount(): number {
  return screen.getAllByTestId(/^dataset-episode-row-/).length;
}

test('a deep link restores the group, expands its task, and opens the episode', async () => {
  window.history.replaceState(
    null,
    '',
    `/?tab=datasets&dstask=kitchen_pick&dscond=dim&dsep=${encodeURIComponent(KP_DIM_A.dataset_dir)}`,
  );
  mockFetch({ list: LIST_RESPONSE, details: { [detailUrlFor(KP_DIM_A)]: detailFor(KP_DIM_A) } });
  renderWithClient(<DatasetsScreen />);

  // The scope is the linked group, not the whole catalog...
  await waitFor(() =>
    expect(screen.getByTestId('dataset-scope-title')).toHaveTextContent('kitchen_pick'),
  );
  // ...the multi-condition task arrives EXPANDED, so the selected child row is
  // actually visible rather than hidden inside a collapsed task...
  expect(screen.getByTestId(dimGroup)).toBeInTheDocument();
  // ...and the linked episode's own detail is open.
  await waitFor(() =>
    expect(screen.getByTestId('dataset-detail-index')).toHaveTextContent(KP_DIM_A.index),
  );
});

test('a deep link with no condition restores the null-condition group', async () => {
  window.history.replaceState(null, '', '/?tab=datasets&dstask=shelf_restock');
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() =>
    expect(screen.getByTestId('dataset-scope-title')).toHaveTextContent('shelf_restock'),
  );
});

test('a deep link to an episode that no longer exists degrades to the summary', async () => {
  window.history.replaceState(null, '', '/?tab=datasets&dsep=op_a/kitchen_pick/999');
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());
  // No phantom detail pane — the scope summary is what shows.
  expect(screen.getByTestId('dataset-scope-summary')).toBeInTheDocument();
  expect(screen.queryByTestId('dataset-stats')).toBeNull();
});

test('selecting a group and an episode makes the view addressable', async () => {
  mockFetch({ list: LIST_RESPONSE, details: { [detailUrlFor(SHELF_A)]: detailFor(SHELF_A) } });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());

  fireEvent.click(screen.getByTestId(shelfLeaf));
  await waitFor(() => {
    const p = new URLSearchParams(window.location.search);
    expect(p.get('dstask')).toBe('shelf_restock');
    // A null condition is written as an ABSENT key, not an empty one.
    expect(p.has('dscond')).toBe(false);
  });

  fireEvent.click(await screen.findByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`));
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get('dsep')).toBe(SHELF_A.dataset_dir),
  );

  // Toggling the row back off drops the key rather than leaving it stale.
  fireEvent.click(screen.getByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`));
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).has('dsep')).toBe(false),
  );
});

test('the search and the facets are addressable too', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());

  fireEvent.change(screen.getByTestId('dataset-search'), { target: { value: 'kitchen' } });
  fireEvent.click(screen.getByTestId('dataset-filter-failure'));

  await waitFor(() => {
    const p = new URLSearchParams(window.location.search);
    expect(p.get('dsq')).toBe('kitchen');
    expect(p.get('dsresult')).toBe('failure');
  });

  // Back to the default view = back to a clean URL (no dsq=&dsresult=all noise).
  fireEvent.change(screen.getByTestId('dataset-search'), { target: { value: '' } });
  fireEvent.click(screen.getByTestId('dataset-filter-all'));
  await waitFor(() => {
    const p = new URLSearchParams(window.location.search);
    expect(p.has('dsq')).toBe(false);
    expect(p.has('dsresult')).toBe(false);
  });
});

test('the episode table pages rather than growing, and states the range', async () => {
  mockFetch({ list: bigCatalog(450) });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId('dataset-episode-pager')).toBeInTheDocument());
  expect(episodeRowCount()).toBe(200);
  expect(screen.getByTestId('dataset-episode-range')).toHaveTextContent(
    '1–200 of 450 episodes',
  );
  expect(screen.getByTestId('dataset-episode-page')).toHaveTextContent('Page 1 / 3');
  // Paging is a RENDER concern only — the manifest still covers every row.
  expect(screen.getByTestId('dataset-manifest-btn')).toHaveTextContent('Manifest (450)');
  expect(screen.getByTestId('dataset-episode-prev')).toBeDisabled();

  fireEvent.click(screen.getByTestId('dataset-episode-next'));
  await waitFor(() =>
    expect(screen.getByTestId('dataset-episode-range')).toHaveTextContent(
      '201–400 of 450 episodes',
    ),
  );
  // A page is always exactly one page — the table does not creep upward as an
  // operator walks a large group.
  expect(episodeRowCount()).toBe(200);

  fireEvent.click(screen.getByTestId('dataset-episode-next'));
  await waitFor(() =>
    expect(screen.getByTestId('dataset-episode-range')).toHaveTextContent(
      '401–450 of 450 episodes',
    ),
  );
  expect(episodeRowCount()).toBe(50); // the last page holds what remains
  expect(screen.getByTestId('dataset-episode-next')).toBeDisabled();

  fireEvent.click(screen.getByTestId('dataset-episode-prev'));
  await waitFor(() => expect(episodeRowCount()).toBe(200));
});

test('a catalog that fits on one page shows no pager at all', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());
  expect(screen.queryByTestId('dataset-episode-pager')).toBeNull();
});

test('a new query returns to page one', async () => {
  mockFetch({ list: bigCatalog(450) });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId('dataset-episode-pager')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('dataset-episode-next'));
  await waitFor(() =>
    expect(screen.getByTestId('dataset-episode-page')).toHaveTextContent('Page 2 / 3'),
  );

  // Every row matches "op_a", so this narrows nothing — but page 2 of a
  // different result set is not where the operator asked to be.
  fireEvent.change(screen.getByTestId('dataset-episode-search'), {
    target: { value: 'op_a' },
  });
  await waitFor(() =>
    expect(screen.getByTestId('dataset-episode-page')).toHaveTextContent('Page 1 / 3'),
  );
});

// ---- topic signature (2026-07-26 ML finding F1) ---------------------------
// A (task, condition) group can silently mix two robots' topic sets — nine
// /hsrb/* episodes and two /camera/* ones sat in one real group behind a single
// success rate. The catalog now carries a per-episode signature; these pin that
// the mix is stated on the list row, in the summary, and on the offending rows.

const HSR_HASH = 'a'.repeat(64);
const CAM_HASH = 'b'.repeat(64);

const MIXED: DatasetEntry[] = [
  { ...KP_DIM_A, topics_hash: HSR_HASH, topic_count: 7 },
  { ...KP_DIM_B, topics_hash: CAM_HASH, topic_count: 8 },
];

test('a group mixing two topic sets says so on its list row and in the summary', async () => {
  mockFetch({ list: { datasets: MIXED } });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId(dimGroup)).toBeInTheDocument());

  // Visible BEFORE selecting: the cost of finding out later is a wasted build.
  expect(screen.getByTestId(dimGroup)).toHaveTextContent('2 topic sets');

  fireEvent.click(screen.getByTestId(dimGroup));

  const callout = await screen.findByTestId('dataset-schema-mixed');
  expect(callout).toHaveTextContent('2 different topic sets in this scope');
  expect(callout).toHaveTextContent("don't share one observation/action space");
  // Each set is named with its real episode + topic counts.
  expect(screen.getByTestId('dataset-schema-variant-A')).toHaveTextContent('1 episode');
  expect(screen.getByTestId('dataset-schema-variant-A')).toHaveTextContent('7 topics');
  expect(screen.getByTestId('dataset-schema-variant-B')).toHaveTextContent('8 topics');

  // And the minority episode is marked in the table.
  expect(screen.getByTestId(`dataset-schema-outlier-${KP_DIM_B.dataset_dir}`)).toBeInTheDocument();
  expect(screen.queryByTestId(`dataset-schema-outlier-${KP_DIM_A.dataset_dir}`)).toBeNull();
});

test('a homogeneous group states its single topic set and marks no rows', async () => {
  const same: DatasetEntry[] = [
    { ...KP_DIM_A, topics_hash: HSR_HASH, topic_count: 7 },
    { ...KP_DIM_B, topics_hash: HSR_HASH, topic_count: 7 },
  ];
  mockFetch({ list: { datasets: same } });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId(dimGroup)).toBeInTheDocument());
  expect(screen.getByTestId(dimGroup)).not.toHaveTextContent('topic sets');

  fireEvent.click(screen.getByTestId(dimGroup));

  const single = await screen.findByTestId('dataset-schema-single');
  expect(single).toHaveTextContent('1 topic set');
  expect(single).toHaveTextContent('7 topics');
  expect(screen.queryByTestId('dataset-schema-mixed')).toBeNull();
  expect(screen.queryByTestId(`dataset-schema-outlier-${KP_DIM_B.dataset_dir}`)).toBeNull();
});

test('exports with no signature say so instead of implying agreement', async () => {
  mockFetch({ list: LIST_RESPONSE }); // the base fixture carries no topics_hash
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(shelfLeaf));

  const unknown = await screen.findByTestId('dataset-schema-unknown');
  expect(unknown).toHaveTextContent("can't be compared");
  expect(screen.queryByTestId('dataset-schema-single')).toBeNull();
  expect(screen.queryByTestId('dataset-schema-mixed')).toBeNull();
});

test('unsigned episodes are excluded from the comparison, not counted into a set', async () => {
  const partial: DatasetEntry[] = [
    { ...KP_DIM_A, topics_hash: HSR_HASH, topic_count: 7 },
    KP_DIM_B, // no signature
  ];
  mockFetch({ list: { datasets: partial } });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() => expect(screen.getByTestId(dimGroup)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(dimGroup));

  // One KNOWN set -> not a mixed scope, and the unsigned row is reported apart.
  expect(await screen.findByTestId('dataset-schema-single')).toHaveTextContent('1 topic set');
  expect(screen.getByTestId('dataset-schema-unsigned')).toHaveTextContent(
    '1 without a topic signature',
  );
  expect(screen.queryByTestId(`dataset-schema-outlier-${KP_DIM_B.dataset_dir}`)).toBeNull();
});

test('the whole-catalog view states the spread neutrally and flags no rows', async () => {
  mockFetch({ list: { datasets: MIXED } });
  renderWithClient(<DatasetsScreen />);

  // No group selected: the scope is the whole catalog, which is EXPECTED to
  // span several topic sets — so it is reported without the build-blocking
  // wording and without marking any row.
  const callout = await screen.findByTestId('dataset-schema-mixed');
  expect(callout).toHaveTextContent('2 different topic sets in this scope');
  expect(callout).toHaveTextContent('expected here');
  expect(callout).not.toHaveTextContent("can't be converted into a single training set");
  expect(screen.queryByTestId(`dataset-schema-outlier-${KP_DIM_B.dataset_dir}`)).toBeNull();
});

test('the header counts what is on screen, not the whole scope', async () => {
  mockFetch({ list: LIST_RESPONSE });
  renderWithClient(<DatasetsScreen />);
  await waitFor(() => expect(screen.getByTestId(kitchenTask)).toBeInTheDocument());

  // Nothing hidden: the plain total.
  expect(screen.getByTestId('dataset-scope-count')).toHaveTextContent('5 episodes');

  // An episode search matching one row must not leave "5 episodes" standing
  // over a single-row table.
  fireEvent.change(screen.getByTestId('dataset-episode-search'), { target: { value: '003' } });
  await waitFor(() =>
    expect(screen.getByTestId('dataset-scope-count')).toHaveTextContent('showing 1 of 5 episodes'),
  );
});

test('the header states the render cap too', async () => {
  mockFetch({ list: bigCatalog(450) });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() =>
    expect(screen.getByTestId('dataset-scope-count')).toHaveTextContent(
      'showing 200 of 450 episodes',
    ),
  );
});

test('a URL whose own filter excludes the linked episode does not resurrect its Delete', async () => {
  window.history.replaceState(
    null,
    '',
    `/?tab=datasets&dstask=kitchen_pick&dscond=dim&dsresult=success&dsep=${encodeURIComponent(
      KP_DIM_B.dataset_dir,
    )}`,
  );
  mockFetch({ list: LIST_RESPONSE, details: { [detailUrlFor(KP_DIM_B)]: detailFor(KP_DIM_B) } });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() =>
    expect(screen.getByTestId('dataset-scope-title')).toHaveTextContent('kitchen_pick'),
  );
  // KP_DIM_B is a FAILURE and the link's own facet is success-only, so the row
  // is not in the filtered set. Restoring from the URL goes through the same
  // reconciliation as a click, so the detail pane — and the live Delete it
  // carries — must stay shut rather than being resurrected by the link.
  expect(screen.getByTestId('dataset-scope-summary')).toBeInTheDocument();
  expect(screen.queryByTestId('dataset-stats')).toBeNull();
  expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();

  // The link isn't discarded either — relaxing the facet brings the episode back.
  fireEvent.click(screen.getByTestId('dataset-filter-all'));
  await waitFor(() => expect(screen.getByTestId('dataset-stats')).toBeInTheDocument());
});

// ---- archive vs delete (2026-07-26) ---------------------------------------
// Archiving is the only control that moves data off this machine, and it sits
// next to the one that destroys it. These pin the two things that make that
// safe: the feature is not offered unless the deployment configured a root,
// and the two controls never read alike.

const ARCHIVE_ON = { enabled: true, roots: ['/mnt/nas/datasets'] };

async function selectShelfEpisode() {
  await waitFor(() => expect(screen.getByTestId(shelfLeaf)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(shelfLeaf));
  fireEvent.click(await screen.findByTestId(`dataset-episode-row-${SHELF_A.dataset_dir}`));
  await waitFor(() => expect(screen.getByTestId('dataset-stats')).toBeInTheDocument());
}

test('no archive control at all when the deployment configured no roots', async () => {
  mockFetch({ list: LIST_RESPONSE, details: { [detailUrlFor(SHELF_A)]: detailFor(SHELF_A) } });
  renderWithClient(<DatasetsScreen />);
  await selectShelfEpisode();

  // Not disabled, not a 400-on-click: absent.
  expect(screen.queryByTestId('archive-dataset-btn')).toBeNull();
  // Delete is still offered, and still states what it does.
  expect(screen.getByTestId('delete-dataset-btn')).toHaveTextContent('Delete permanently');
});

test('the two departures state their own consequence and never read alike', async () => {
  mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(SHELF_A)]: detailFor(SHELF_A) },
    archive: ARCHIVE_ON,
  });
  renderWithClient(<DatasetsScreen />);
  await selectShelfEpisode();

  const archive = await screen.findByTestId('archive-dataset-btn');
  const remove = screen.getByTestId('delete-dataset-btn');
  expect(archive).toHaveTextContent('keeps the data');
  expect(remove).toHaveTextContent('Delete permanently');
  expect(archive.textContent).not.toEqual(remove.textContent);
});

test('the archive dialog composes the destination from an allow-listed root', async () => {
  mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(SHELF_A)]: detailFor(SHELF_A) },
    archive: ARCHIVE_ON,
  });
  renderWithClient(<DatasetsScreen />);
  await selectShelfEpisode();
  fireEvent.click(screen.getByTestId('archive-dataset-btn'));

  const dialog = await screen.findByTestId('archive-dialog');
  // The root is shown as a boundary, not typed by hand…
  expect(screen.getByTestId('archive-root')).toHaveTextContent('/mnt/nas/datasets');
  // …the subpath defaults to the catalog's own coordinates…
  expect(screen.getByTestId('archive-subpath')).toHaveValue('op_a/shelf_restock/001');
  // …and the resulting absolute path is echoed back before committing.
  expect(screen.getByTestId('archive-destination')).toHaveTextContent(
    '/mnt/nas/datasets/op_a/shelf_restock/001',
  );
  // The consequence is stated, in order.
  expect(dialog).toHaveTextContent('verified');
  expect(dialog).toHaveTextContent('Only after it verifies is the copy here removed.');
});

test('archiving posts the destination + reason and drops the dataset once verified', async () => {
  mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(SHELF_A)]: detailFor(SHELF_A) },
    archive: ARCHIVE_ON,
  });
  renderWithClient(<DatasetsScreen />);
  await selectShelfEpisode();
  fireEvent.click(screen.getByTestId('archive-dataset-btn'));
  await screen.findByTestId('archive-dialog');

  fireEvent.change(screen.getByTestId('archive-subpath'), {
    target: { value: 'cold/2026/shelf_001' },
  });
  fireEvent.change(screen.getByTestId('archive-reason'), {
    target: { value: 'moved to the NAS' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Copy, verify, then remove' }));

  await waitFor(() => expect(archivePosts).toHaveLength(1));
  expect(archivePosts[0]!.url).toContain('/datasets/op_a/shelf_restock/001/archive');
  expect(archivePosts[0]!.body).toEqual({
    destination: '/mnt/nas/datasets/cold/2026/shelf_001',
    reason: 'moved to the NAS',
  });
  // The success wording says what actually happened, in the order it happened.
  expect(
    await screen.findByText(/verified at the destination, then removed here/),
  ).toBeInTheDocument();
});

test('a failed archive says the dataset is still here', async () => {
  mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(SHELF_A)]: detailFor(SHELF_A) },
    archive: ARCHIVE_ON,
    archiveJobState: 'failed',
  });
  renderWithClient(<DatasetsScreen />);
  await selectShelfEpisode();
  fireEvent.click(screen.getByTestId('archive-dataset-btn'));
  await screen.findByTestId('archive-dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Copy, verify, then remove' }));

  expect(await screen.findByText(/still here/)).toBeInTheDocument();
});

test('the delete dialog names archive as the way to keep the data, and takes a reason', async () => {
  mockFetch({
    list: LIST_RESPONSE,
    details: { [detailUrlFor(SHELF_A)]: detailFor(SHELF_A) },
    archive: ARCHIVE_ON,
  });
  renderWithClient(<DatasetsScreen />);
  await selectShelfEpisode();
  fireEvent.click(screen.getByTestId('delete-dataset-btn'));

  const dialog = await screen.findByTestId('delete-dialog');
  expect(dialog).toHaveTextContent('destroyed');
  expect(dialog).toHaveTextContent('To keep the data');
  expect(dialog).toHaveTextContent('Archive');

  fireEvent.change(screen.getByTestId('delete-reason'), {
    target: { value: 'teleop aborted' },
  });
  // Scoped to the dialog: the toolbar button carries the same label by design.
  fireEvent.click(
    within(dialog.closest('[role="dialog"]') ?? dialog).getByRole('button', {
      name: 'Delete permanently',
    }),
  );

  await waitFor(() => expect(deletedUrls).toHaveLength(1));
  // The reason travels to the ledger, which is all that will remain.
  expect(deletedUrls[0]).toContain('reason=teleop%20aborted');
});
