import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { renderWithClient, jsonResponse } from '../../test/renderWithClient';
import { DatasetTab } from './DatasetTab';

const RUNS = { items: [{ run_id: 'run_001', state: 'completed' }], next_cursor: null };

function mockFetch(convertEnabled: boolean) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/runs')) return Promise.resolve(jsonResponse(RUNS));
    if (url.includes('/pipelines'))
      return Promise.resolve(
        jsonResponse([
          { id: 'fast_validation', name: 'Fast validation', enabled: true },
          { id: 'dataset_convert', name: 'Dataset conversion', enabled: convertEnabled },
        ]),
      );
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

test('disables convert when dataset_convert is a placeholder (enabled:false)', async () => {
  mockFetch(false);
  renderWithClient(<DatasetTab />);

  await waitFor(() => expect(screen.getByText('run_001')).toBeInTheDocument());
  expect(screen.getByText(/未実装/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /変換ジョブを作成/ })).toBeDisabled();
});

test('enables convert when dataset_convert is runnable (enabled:true)', async () => {
  mockFetch(true);
  renderWithClient(<DatasetTab />);

  await waitFor(() => expect(screen.getByText('run_001')).toBeInTheDocument());
  expect(screen.queryByText(/未実装/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /変換ジョブを作成/ })).toBeEnabled();
});
