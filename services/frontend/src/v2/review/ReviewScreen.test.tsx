import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { setSplitMode } from './splitMode';
import { ReviewScreen } from './ReviewScreen';

function mockRuns(items: Record<string, unknown>[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
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

test('renders the episode list and detail panel from real runs', async () => {
  mockRuns([
    { run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z', duration_ms: 30000 },
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-episodes-count')).toHaveTextContent('1 shown'));
  expect(screen.getByTestId('review-row-1')).toBeInTheDocument();
  expect(screen.getByTestId('review-detail-header')).toHaveTextContent('Episode #1');
});

test('selecting a row updates the detail panel', async () => {
  mockRuns([
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

test('cycling Final quality updates the detail panel badge', async () => {
  mockRuns([{ run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-detail-header')).toBeInTheDocument());

  const finalCell = screen.getByTestId('review-final-quality');
  const before = within(finalCell).getByText(/Good|Needs review|Not usable/).textContent;
  fireEvent.click(finalCell);
  await waitFor(() => {
    const after = within(finalCell).getByText(/Good|Needs review|Not usable/).textContent;
    expect(after).not.toBe(before);
  });
});

test('falls back to the built-in demo set (no blank screen) when the API is down', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('down')));
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-detail-header')).toBeInTheDocument());
  expect(screen.queryByText('No episodes to review yet.')).not.toBeInTheDocument();
});

test('SPLIT_MODE off by default: no transfer UI renders', async () => {
  mockRuns([{ run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-detail-header')).toBeInTheDocument());
  expect(screen.queryByTestId('review-transfer-all')).not.toBeInTheDocument();
  expect(screen.queryByTestId('review-transfer-button')).not.toBeInTheDocument();
  expect(screen.queryByText('Data is on the robot PC')).not.toBeInTheDocument();
});

test('SPLIT_MODE on: transfer UI appears and a transfer can be started', async () => {
  setSplitMode(true);
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('down')));
  renderWithClient(<ReviewScreen />);
  // demo_ep_26 is seeded on_robot in the fallback set (mapRuns.ts).
  await waitFor(() => expect(screen.getByTestId('review-row-26')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('review-row-26'));
  await waitFor(() => expect(screen.getByText('Data is on the robot PC')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('review-transfer-button'));
  await waitFor(
    () => expect(screen.queryByTestId('review-transfer-button')).not.toBeInTheDocument(),
    { timeout: 3000 },
  );
});
