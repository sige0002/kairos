import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { renderWithClient, jsonResponse } from '../../test/renderWithClient';
import { DatasetTab } from './DatasetTab';

const RUNS = {
  items: [
    { run_id: 'run_001', state: 'completed', operator: 'yuki', task: 'pick' },
  ],
  next_cursor: null,
};

const DATASETS = {
  datasets: [
    {
      operator: 'yuki',
      task: 'pick',
      index: '001',
      dataset_dir: '/data/yuki/pick/001',
      run_id: 'run_000',
      bytes: 2048,
      exported_at: '2026-06-26T00:00:00.000Z',
    },
  ],
};

let exportBody: Record<string, unknown> | null = null;
let exportAllCalled = false;

beforeEach(() => {
  setApiBase('/api/v1');
  exportBody = null;
  exportAllCalled = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.endsWith('/datasets/export-all')) {
      exportAllCalled = true;
      return Promise.resolve(jsonResponse({ exported: [{}], failed: [], total: 1 }));
    }
    if (url.endsWith('/datasets/export')) {
      exportBody = JSON.parse(String((init as RequestInit).body));
      return Promise.resolve(
        jsonResponse({ index: '002', dataset_dir: '/data/yuki/pick/002' }),
      );
    }
    if (url.includes('/datasets')) return Promise.resolve(jsonResponse(DATASETS));
    if (url.includes('/runs')) return Promise.resolve(jsonResponse(RUNS));
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => vi.restoreAllMocks());

test('lists exported datasets grouped by operator/task and the completed run', async () => {
  renderWithClient(<DatasetTab />);
  // Datasets section: the exported dataset card.
  await waitFor(() =>
    expect(screen.getByTestId('dataset-dir')).toHaveTextContent('/data/yuki/pick/001'),
  );
  expect(screen.getByText('#001')).toBeInTheDocument();
  // Export section: the completed run with operator/task and an Export button.
  expect(screen.getByText('run_001')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
});

test('exporting a run posts to /datasets/export with the run_id', async () => {
  renderWithClient(<DatasetTab />);
  await waitFor(() => expect(screen.getByText('run_001')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'Export' }));

  await waitFor(() => expect(exportBody).not.toBeNull());
  expect(exportBody).toMatchObject({ run_id: 'run_001' });
});

test('export-all posts to /datasets/export-all and shows the tally', async () => {
  renderWithClient(<DatasetTab />);
  await waitFor(() => expect(screen.getByText('run_001')).toBeInTheDocument());

  fireEvent.click(
    screen.getByRole('button', { name: 'Export all completed recordings' }),
  );

  await waitFor(() => expect(exportAllCalled).toBe(true));
  await waitFor(() =>
    expect(screen.getByTestId('export-all-result')).toHaveTextContent(
      '1 exported, 0 failed',
    ),
  );
});

test('empty datasets show the empty state', async () => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/datasets')) return Promise.resolve(jsonResponse({ datasets: [] }));
    if (url.includes('/runs')) return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<DatasetTab />);
  await waitFor(() => expect(screen.getByText('No datasets yet.')).toBeInTheDocument());
});
