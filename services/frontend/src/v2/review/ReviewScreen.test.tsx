import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { setSplitMode } from './splitMode';
import { ReviewScreen } from './ReviewScreen';

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
});
afterEach(() => {
  vi.restoreAllMocks();
  setSplitMode(false); // reset the module-level flag between tests
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
  mockApi([{ run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-row-1')).toBeInTheDocument());

  // The single run seeds on_robot, so the detail panel shows the transfer
  // placeholder instead of inspecting an MCAP that's still on the robot PC.
  await waitFor(() => expect(screen.getByText('Data is on the robot PC')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('review-transfer-button'));
  await waitFor(
    () => expect(screen.queryByTestId('review-transfer-button')).not.toBeInTheDocument(),
    { timeout: 3000 },
  );
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
