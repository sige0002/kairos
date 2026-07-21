import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { setSplitMode } from './splitMode';
import { setFiltersCollapsed } from './filtersRail';
import { ReviewScreen } from './ReviewScreen';

const FILTERS_KEY = 'kairos.v2.review.filtersCollapsed.v1';

const CONFIG_OPTIONS = {
  active_robot: 'airoa_hsr',
  robots: [],
  aspects: {
    recording: { active: 'default', options: [] },
    stream: { active: 'default', options: [] },
    validation: { active: 'default', options: [] },
    validators: { active: 'default', options: [] },
  },
};

// A fetch mock covering everything the Review screen touches: the /runs list,
// the per-run detail the embedded RunInspection loads (GET /runs/{id}), the
// config/options the validation template is resolved from, and DELETE
// /runs/{id} (removes it from the live list). Detail defaults to a completed
// run with no topics unless overridden per run id.
function mockApi(initial: Record<string, unknown>[], detailById: Record<string, unknown> = {}) {
  let items = [...initial];
  const deleteCalls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const detailMatch = url.match(/\/runs\/([^/?]+)(?:\?|$)/);
    if (method === 'DELETE' && detailMatch) {
      const id = decodeURIComponent(detailMatch[1]!);
      deleteCalls.push(id);
      items = items.filter((r) => r.run_id !== id);
      return Promise.resolve(jsonResponse({}, 200));
    }
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]!);
      const detail = detailById[id] ?? { run_id: id, state: 'completed', topics: [] };
      return Promise.resolve(jsonResponse(detail));
    }
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(CONFIG_OPTIONS));
    if (url.includes('/runs')) return Promise.resolve(jsonResponse({ items: [...items], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
  return { deleteCalls };
}

// Exclude the episode in the given row (opens the confirm, then confirms).
function excludeRow(ep: number) {
  fireEvent.click(screen.getByTestId(`review-archive-${ep}`));
  fireEvent.click(screen.getByTestId('review-confirm-exclude'));
}

beforeEach(() => {
  setApiBase('/api/v1');
  useUiStore.setState({ activeTab: '', pendingRun: null });
  setFiltersCollapsed(false);
  window.localStorage.removeItem(FILTERS_KEY);
});
afterEach(() => {
  vi.restoreAllMocks();
  setSplitMode(false); // reset the module-level flag between tests
  setFiltersCollapsed(false);
  window.localStorage.removeItem(FILTERS_KEY);
});

test('renders the episode list and real detail panel from real runs', async () => {
  mockApi([{ run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z', duration_ms: 30000 }]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-episodes-count')).toHaveTextContent('1 shown'));
  expect(screen.getByTestId('review-row-1')).toBeInTheDocument();
  expect(screen.getByTestId('review-detail-header')).toHaveTextContent('Episode #1');
  // The real per-run inspection panel loads (GET /runs/{id}).
  await waitFor(() => expect(screen.getByTestId('review-inspection')).toBeInTheDocument());
});

test('the detail panel shows real run fields, not fabricated ones', async () => {
  mockApi(
    [{ run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }],
    {
      'ep-a': {
        run_id: 'ep-a',
        state: 'completed',
        operator: 'alice',
        task: 'Pick and Place',
        message_count: 1057,
        bytes: 7975674,
        topics: [{ name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' }],
      },
    },
  );
  renderWithClient(<ReviewScreen />);
  const inspection = await screen.findByTestId('review-inspection');
  expect(within(inspection).getByText('alice')).toBeInTheDocument();
  expect(within(inspection).getByText('Pick and Place')).toBeInTheDocument();
  expect(within(inspection).getByText('1,057')).toBeInTheDocument();
  expect(within(screen.getByTestId('review-topics')).getByText('/hsrb/joint_states')).toBeInTheDocument();
});

test('selecting a row updates the detail panel', async () => {
  mockApi([
    { run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z' },
    { run_id: 'ep-b', state: 'completed', started_at: '2026-07-13T09:05:00Z' },
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-episodes-count')).toHaveTextContent('2 shown'));

  // ep-b (started later) is #2 and renders first (newest-first); it's the
  // default selection, so click #1 (ep-a) and confirm the detail panel follows.
  fireEvent.click(screen.getByTestId('review-row-1'));
  await waitFor(() => expect(screen.getByTestId('review-detail-header')).toHaveTextContent('Episode #1'));
});

test('Final quality starts at "—" and becomes Good on the first click', async () => {
  mockApi([{ run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-detail-header')).toBeInTheDocument());

  const finalCell = screen.getByTestId('review-final-quality');
  expect(within(finalCell).getByText('—')).toBeInTheDocument();
  fireEvent.click(finalCell);
  await waitFor(() => expect(within(finalCell).getByText('Good')).toBeInTheDocument());
});

test('a failed /runs request shows an honest error, not a fabricated demo set', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('down')));
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't load recordings/));
  expect(screen.queryByTestId('review-detail-header')).not.toBeInTheDocument();
});

test('SPLIT_MODE off by default: no transfer UI renders', async () => {
  mockApi([{ run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-detail-header')).toBeInTheDocument());
  expect(screen.queryByTestId('review-transfer-all')).not.toBeInTheDocument();
  expect(screen.queryByTestId('review-transfer-button')).not.toBeInTheDocument();
  expect(screen.queryByText('Data is on the robot PC')).not.toBeInTheDocument();
});

test('the delete-from-disk action appears only after an episode is excluded', async () => {
  mockApi([{ run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z', bytes: 1048576 }]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-detail-header')).toBeInTheDocument());

  // Not excluded yet: no per-episode delete, no bulk delete.
  expect(screen.queryByTestId('review-delete-one')).not.toBeInTheDocument();
  expect(screen.queryByTestId('review-bulk-delete')).not.toBeInTheDocument();

  excludeRow(1);
  await waitFor(() => expect(screen.getByTestId('review-delete-one')).toBeInTheDocument());
  expect(screen.getByText('Excluded — kept on disk')).toBeInTheDocument();
});

test('the single delete dialog shows the run_id and size, and is cancelable', async () => {
  mockApi([{ run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z', bytes: 1048576 }]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-detail-header')).toBeInTheDocument());
  excludeRow(1);

  fireEvent.click(await screen.findByTestId('review-delete-one'));
  expect(screen.getByTestId('review-delete-runid')).toHaveTextContent('ep-a');
  expect(screen.getByTestId('review-delete-size')).toHaveTextContent('1.0 MB');

  // Cancel closes the dialog and leaves the excluded run in place (its
  // delete affordance is still there — nothing was deleted).
  fireEvent.click(screen.getByText('Cancel'));
  await waitFor(() => expect(screen.queryByTestId('review-delete-runid')).not.toBeInTheDocument());
  expect(screen.getByTestId('review-delete-one')).toBeInTheDocument();
});

test('bulk delete: count, listed run_ids, and list refresh after a mocked success', async () => {
  const { deleteCalls } = mockApi([
    { run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z', bytes: 1000 },
    { run_id: 'ep-b', state: 'completed', started_at: '2026-07-13T09:05:00Z', bytes: 2000 },
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-episodes-count')).toHaveTextContent('2 shown'));

  excludeRow(1); // ep-a (older, #1)
  excludeRow(2); // ep-b (newer, #2)
  const bulk = await screen.findByTestId('review-bulk-delete');
  expect(bulk).toHaveTextContent('Delete excluded (2)');

  fireEvent.click(bulk);
  const list = await screen.findByTestId('review-bulk-list');
  expect(within(list).getByText('ep-a')).toBeInTheDocument();
  expect(within(list).getByText('ep-b')).toBeInTheDocument();

  fireEvent.click(screen.getByText('Delete 2'));
  await waitFor(() => expect(deleteCalls.sort()).toEqual(['ep-a', 'ep-b']));
  // Both gone → empty state, modal closed, bulk action gone.
  await waitFor(() => expect(screen.getByText('No episodes to review yet.')).toBeInTheDocument());
  expect(screen.queryByTestId('review-bulk-delete')).not.toBeInTheDocument();
});

test('SPLIT_MODE on: transfer UI appears and a transfer can be started', async () => {
  setSplitMode(true);
  // bag_local=false — the server says the finalised MCAP is still robot-only.
  mockApi([
    {
      run_id: 'ep-a',
      state: 'completed',
      started_at: '2026-07-13T09:00:00Z',
      bag_local: false,
    },
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-row-1')).toBeInTheDocument());

  // The row is on_robot, so the detail panel shows the transfer placeholder
  // instead of inspecting an MCAP that's still on the robot PC.
  await waitFor(() => expect(screen.getByText('Data is on the robot PC')).toBeInTheDocument());

  // Clicking posts the real pull; with no completion from the mock server the
  // panel honestly stays in the indeterminate transferring state (no fake %).
  fireEvent.click(screen.getByTestId('review-transfer-button'));
  await waitFor(() =>
    expect(screen.getByTestId('review-transferring')).toBeInTheDocument(),
  );
  expect(screen.queryByTestId('review-transfer-button')).not.toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Exception-review lanes (READY / NEEDS CHECK / EXCLUDED) + one-click export.
// ---------------------------------------------------------------------------

function ep(review_status: string, quality = 'good', task_result = 'success') {
  return {
    episode_id: `ep_${review_status}_${quality}`,
    batch_id: 'b1',
    index_in_batch: 1,
    task_result,
    quality,
    review_status,
    batch_seq: 3,
  };
}

test('a good-quality run is READY with zero clicks (row + detail header chip)', async () => {
  mockApi([
    { run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z', episode: ep('pending', 'good') },
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-row-1')).toBeInTheDocument());
  expect(screen.getByTestId('review-status-1')).toHaveTextContent('READY');
  await waitFor(() => expect(screen.getByTestId('review-detail-status')).toHaveTextContent('READY'));
});

test('a needs-review run is NEEDS CHECK until "Mark OK — include" flips it to READY', async () => {
  mockApi([
    { run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z', episode: ep('pending', 'needs_review') },
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-status-1')).toHaveTextContent('NEEDS CHECK'));

  fireEvent.click(screen.getByTestId('review-mark-ok'));
  expect(screen.getByTestId('review-status-1')).toHaveTextContent('READY');
  expect(screen.getByTestId('review-detail-status')).toHaveTextContent('READY');
});

test('the decision buttons live in the pinned bar, not in the scrolling body', async () => {
  // The operator must never scroll past the inspection to reach Mark OK /
  // Exclude (user-reported UX pain) — they sit in a bar pinned below the
  // scroll region, and the READY Export CTA is pinned there too.
  mockApi([
    { run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z', episode: ep('pending', 'needs_review') },
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-detail-status')).toHaveTextContent('NEEDS CHECK'));

  const bar = screen.getByTestId('review-decision-bar');
  expect(within(bar).getByTestId('review-mark-ok')).toBeInTheDocument();
  expect(within(bar).getByTestId('review-decision-exclude')).toBeInTheDocument();
  // The bar is a sibling BELOW the scroll region (overflow-y-auto), not inside it.
  const scrollRegion = bar.parentElement!.querySelector('.overflow-y-auto');
  expect(scrollRegion).not.toBeNull();
  expect(scrollRegion!.contains(bar)).toBe(false);

  // After Mark OK the episode is READY: the Export CTA appears in the same bar.
  fireEvent.click(within(bar).getByTestId('review-mark-ok'));
  expect(within(bar).getByTestId('review-export-cta')).toBeInTheDocument();
});

test('the header shows real lane and task tallies over the shown rows', async () => {
  // OP2 (R2): "no at-a-glance day tally — I scan the column by hand."
  mockApi([
    { run_id: 'ep-a', state: 'completed', started_at: '2026-07-14T09:00:00Z', episode: ep('pending', 'good', 'success') },
    { run_id: 'ep-b', state: 'completed', started_at: '2026-07-14T09:05:00Z', episode: ep('pending', 'needs_review', 'failure') },
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-episodes-count')).toHaveTextContent('2 shown'));

  expect(screen.getByTestId('review-lane-tally')).toHaveTextContent('1 ready · 1 needs check · 0 excluded');
  expect(screen.getByTestId('review-task-tally')).toHaveTextContent('1 success · 1 failure');
});

test('Export ready lists the READY completed runs + the include-failed toggle', async () => {
  mockApi([
    { run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z', episode: ep('pending', 'good') },
    { run_id: 'ep-b', state: 'completed', started_at: '2026-07-13T09:05:00Z', episode: ep('pending', 'needs_review') },
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-episodes-count')).toHaveTextContent('2 shown'));

  expect(screen.getByTestId('review-adopt-explainer')).toHaveTextContent(/READY.*NEEDS CHECK.*Datasets/);
  expect(screen.getByTestId('review-include-failed')).toBeInTheDocument();

  const exportBtn = screen.getByTestId('review-export-ready');
  expect(exportBtn).toHaveTextContent('Export ready (1)'); // only the good (READY) run
  fireEvent.click(exportBtn);

  const list = await screen.findByTestId('review-export-list');
  expect(within(list).getByText('ep-a')).toBeInTheDocument();
  expect(within(list).queryByText('ep-b')).toBeNull();

  // Cancel — never run a real export in the UI check.
  fireEvent.click(screen.getByText('Cancel'));
  await waitFor(() => expect(screen.queryByTestId('review-export-list')).toBeNull());
});

test('Export ready reads (0), is disabled, and is styled to LOOK disabled when nothing is READY', async () => {
  // A single NEEDS CHECK run → nothing is exportable yet.
  mockApi([
    { run_id: 'ep-b', state: 'completed', started_at: '2026-07-13T09:05:00Z', episode: ep('pending', 'needs_review') },
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-episodes-count')).toHaveTextContent('1 shown'));

  const exportBtn = screen.getByTestId('review-export-ready');
  expect(exportBtn).toHaveTextContent('Export ready (0)');
  // Functionally disabled …
  expect(exportBtn).toBeDisabled();
  // … and styled to read disabled (a muted look, not the live teal CTA) so the
  // count-zero button doesn't invite a dead click (Apple P2).
  expect(exportBtn).toHaveClass('disabled:bg-gray-200');
  expect(exportBtn).toHaveClass('disabled:cursor-not-allowed');
});

test('the pipeline strip is present; a READY run shows the inline Export CTA', async () => {
  mockApi([
    { run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z', episode: ep('pending', 'good') },
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-pipeline-strip')).toBeInTheDocument());
  // Good → READY → the inline CTA + the Ready/Export strip steps are present.
  expect(screen.getByTestId('review-export-cta')).toHaveTextContent(/Export now \(1\)/);
  expect(screen.getByTestId('review-pipeline-strip')).toHaveTextContent('Ready');
});

// ---------------------------------------------------------------------------
// Retention advisory banner (surface-only; never deletes).
// ---------------------------------------------------------------------------

function mockApiWithRetention(
  items: Record<string, unknown>[],
  retention: Record<string, unknown>,
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/retention')) return Promise.resolve(jsonResponse(retention));
    if (url.match(/\/runs\/[^/?]+(\?|$)/) && method === 'GET')
      return Promise.resolve(jsonResponse({ run_id: 'x', state: 'completed', topics: [] }));
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(CONFIG_OPTIONS));
    if (url.includes('/runs')) return Promise.resolve(jsonResponse({ items, next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
}

test('retention banner surfaces old recordings and its CTA filters the table without deleting', async () => {
  mockApiWithRetention(
    [
      { run_id: 'old', state: 'completed', started_at: '2020-01-01T00:00:00Z', bytes: 1048576 },
      { run_id: 'fresh', state: 'completed', started_at: '2026-07-13T09:00:00Z', bytes: 2000 },
    ],
    {
      days: 30,
      total_bytes: 1048576,
      candidates: [{ run_id: 'old', state: 'completed', has_episode: false, bytes: 1048576 }],
    },
  );
  renderWithClient(<ReviewScreen />);

  const banner = await screen.findByTestId('review-retention-banner');
  expect(banner).toHaveTextContent('older than 30 days');
  expect(banner).toHaveTextContent('review and delete what you no longer need');
  // Both runs are shown before the filter is applied.
  await waitFor(() => expect(screen.getByTestId('review-episodes-count')).toHaveTextContent('2 shown'));

  // The CTA narrows the table to the candidate only (no deletion happened).
  fireEvent.click(screen.getByTestId('review-retention-review'));
  await waitFor(() => expect(screen.getByTestId('review-episodes-count')).toHaveTextContent('1 shown'));
  // A "Show all" affordance returns to the full list.
  fireEvent.click(screen.getByTestId('review-retention-show-all'));
  await waitFor(() => expect(screen.getByTestId('review-episodes-count')).toHaveTextContent('2 shown'));
});

test('retention banner is dismissible', async () => {
  mockApiWithRetention(
    [{ run_id: 'old', state: 'completed', started_at: '2020-01-01T00:00:00Z', bytes: 1000 }],
    { days: 30, total_bytes: 1000, candidates: [{ run_id: 'old', state: 'completed', has_episode: false, bytes: 1000 }] },
  );
  renderWithClient(<ReviewScreen />);
  fireEvent.click(await screen.findByTestId('review-retention-dismiss'));
  await waitFor(() =>
    expect(screen.queryByTestId('review-retention-banner')).not.toBeInTheDocument(),
  );
});

test('no retention banner when the feature is disabled (days 0)', async () => {
  mockApiWithRetention(
    [{ run_id: 'a', state: 'completed', started_at: '2020-01-01T00:00:00Z' }],
    { days: 0, total_bytes: 0, candidates: [] },
  );
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-episodes-count')).toBeInTheDocument());
  expect(screen.queryByTestId('review-retention-banner')).not.toBeInTheDocument();
});

test('Return to review PATCHes review_status=pending (from an excluded run)', async () => {
  const patchBodies: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/episodes/') && method === 'PATCH') {
      patchBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(jsonResponse({ episode_id: 'ep_excluded' }));
    }
    if (url.match(/\/runs\/[^/?]+(\?|$)/)) return Promise.resolve(jsonResponse({ run_id: 'ep-a', state: 'completed', topics: [] }));
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(CONFIG_OPTIONS));
    if (url.includes('/runs')) {
      return Promise.resolve(
        jsonResponse({
          items: [{ run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z', episode: ep('excluded', 'not_usable') }],
          next_cursor: null,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<ReviewScreen />);
  // An excluded run shows Return-to-review.
  await waitFor(() => expect(screen.getByTestId('review-return-to-review')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('review-return-to-review'));
  await waitFor(() => expect(patchBodies.some((b) => b.review_status === 'pending')).toBe(true));
});

// ---- FiltersRail collapse (variable-width layout, feature 1) ----------------

test('the filters rail collapse toggle flips aria-expanded and persists', async () => {
  mockApi([{ run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-episodes-count')).toHaveTextContent('1 shown'));

  const toggle = screen.getByTestId('review-filters-toggle');
  expect(toggle).toHaveAttribute('aria-expanded', 'true');

  fireEvent.click(toggle);
  await waitFor(() =>
    expect(screen.getByTestId('review-filters-toggle')).toHaveAttribute('aria-expanded', 'false'),
  );
  // Collapsed rail is shown and the choice is persisted.
  expect(screen.getByTestId('review-filters-collapsed')).toBeInTheDocument();
  expect(window.localStorage.getItem(FILTERS_KEY)).toBe('1');

  // Expanding again clears the persisted flag.
  fireEvent.click(screen.getByTestId('review-filters-toggle'));
  await waitFor(() =>
    expect(screen.getByTestId('review-filters-toggle')).toHaveAttribute('aria-expanded', 'true'),
  );
  expect(window.localStorage.getItem(FILTERS_KEY)).toBeNull();
});

test('collapse restores focus to the toggle (keyboard flow)', async () => {
  mockApi([{ run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-episodes-count')).toHaveTextContent('1 shown'));

  fireEvent.click(screen.getByTestId('review-filters-toggle'));
  await waitFor(() => expect(screen.getByTestId('review-filters-toggle')).toHaveFocus());
});

test('an active operator filter surfaces a dot on the collapsed rail', async () => {
  mockApi([
    { run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z', operator: 'alice' },
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-episodes-count')).toHaveTextContent('1 shown'));

  // No filter yet → no dot even when collapsed.
  fireEvent.click(screen.getByTestId('review-filters-toggle'));
  await waitFor(() => expect(screen.getByTestId('review-filters-collapsed')).toBeInTheDocument());
  expect(screen.queryByTestId('review-filters-active-dot')).toBeNull();

  // Expand, pick an operator, collapse again → the active-filter dot appears.
  fireEvent.click(screen.getByTestId('review-filters-toggle'));
  await waitFor(() => expect(screen.getByTestId('review-operator-filter')).toBeInTheDocument());
  fireEvent.change(screen.getByTestId('review-operator-filter'), { target: { value: 'alice' } });
  fireEvent.click(screen.getByTestId('review-filters-toggle'));
  await waitFor(() => expect(screen.getByTestId('review-filters-active-dot')).toBeInTheDocument());
});
