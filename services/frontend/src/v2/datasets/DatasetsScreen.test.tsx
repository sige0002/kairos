import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DatasetsScreen } from './DatasetsScreen';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  act(() => {
    vi.runOnlyPendingTimers();
  });
  vi.useRealTimers();
});

test('defaults to the first dataset and shows its stats in the detail column', () => {
  render(<DatasetsScreen />);

  expect(screen.getByTestId('dataset-detail-name')).toHaveTextContent('PickPlace_Left2Center');
  expect(within(screen.getByTestId('dataset-detail-version')).getByText('v1')).toBeInTheDocument();
  const stats = screen.getByTestId('dataset-stats');
  expect(within(stats).getByText('1,240')).toBeInTheDocument();
  expect(within(stats).getByText('1,102')).toBeInTheDocument();
});

test('selecting another dataset card switches the detail column content', () => {
  render(<DatasetsScreen />);

  fireEvent.click(screen.getByTestId('dataset-card-1'));

  expect(screen.getByTestId('dataset-detail-name')).toHaveTextContent('PickPlace_All');
  expect(within(screen.getByTestId('dataset-detail-version')).getByText('v2')).toBeInTheDocument();
  const stats = screen.getByTestId('dataset-stats');
  expect(within(stats).getByText('3,652')).toBeInTheDocument();
  // Recipe & output rail follows the selection too (Operators row uses ds.ops).
  expect(screen.getByText('A, B, C')).toBeInTheDocument();
});

test('the dataset list renders a version chip per card, teal on the selected one', () => {
  render(<DatasetsScreen />);

  const first = screen.getByTestId('dataset-card-0');
  const second = screen.getByTestId('dataset-card-1');
  expect(within(first).getByText('v1')).toBeInTheDocument();
  expect(within(second).getByText('v2')).toBeInTheDocument();

  fireEvent.click(second);
  // After selecting card 1, its version chip should carry the "selected" teal tone class.
  const chip = within(screen.getByTestId('dataset-card-1')).getByText('v2');
  expect(chip.className).toMatch(/teal/);
});

test('the recipe & output rail renders the recipe rows and the build button', () => {
  render(<DatasetsScreen />);

  expect(screen.getByText('Source query')).toBeInTheDocument();
  expect(screen.getByText('batches 1–5 · adopted')).toBeInTheDocument();
  expect(screen.getByText('LeRobot v3')).toBeInTheDocument();
  expect(screen.getByTestId('build-dataset-btn')).toBeInTheDocument();
});

test('clicking "+ New" shows the Phase 2 toast', () => {
  render(<DatasetsScreen />);

  fireEvent.click(screen.getByTestId('new-dataset-btn'));

  expect(screen.getByTestId('toast')).toHaveTextContent('New dataset is a Phase 2 feature');
});

test('clicking "Rebuild as v2…" toasts with the selected dataset name', () => {
  render(<DatasetsScreen />);

  fireEvent.click(screen.getByTestId('rebuild-btn'));

  expect(screen.getByTestId('toast')).toHaveTextContent('Rebuild queued as PickPlace_Left2Center v2');
});

test('building runs a progress animation then completes with a toast', () => {
  render(<DatasetsScreen />);

  fireEvent.click(screen.getByTestId('build-dataset-btn'));
  expect(screen.getByTestId('build-progress')).toBeInTheDocument();

  act(() => {
    vi.advanceTimersByTime(120 * 25);
  });

  expect(screen.queryByTestId('build-progress')).not.toBeInTheDocument();
  expect(screen.getByTestId('toast')).toHaveTextContent(
    'Build complete — LeRobot v3 artifact written for PickPlace_Left2Center v1',
  );
});

test('condition coverage section renders all buckets', () => {
  render(<DatasetsScreen />);

  expect(screen.getByText('Left → Center')).toBeInTheDocument();
  expect(screen.getByText('Right → Center')).toBeInTheDocument();
  expect(screen.getByText(/underrepresented/)).toBeInTheDocument();
});
