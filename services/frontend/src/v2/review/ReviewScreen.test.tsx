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
// the per-run detail the embedded RunInspection loads (GET /runs/{id}), and the
// config/options the validation template is resolved from. Detail defaults to a
// completed run with no topics unless overridden per run id.
function mockApi(items: Record<string, unknown>[], detailById: Record<string, unknown> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    const detailMatch = url.match(/\/runs\/([^/?]+)(?:\?|$)/);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]!);
      const detail = detailById[id] ?? { run_id: id, state: 'completed', topics: [] };
      return Promise.resolve(jsonResponse(detail));
    }
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(CONFIG_OPTIONS));
    if (url.includes('/runs')) return Promise.resolve(jsonResponse({ items, next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
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
