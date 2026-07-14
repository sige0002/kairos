import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { ValidationSection } from './ValidationSection';

const OPTIONS = {
  active_robot: 'airoa_hsr',
  robots: [{ id: 'airoa_hsr', local: false }],
  aspects: {
    recording: { active: 'default', options: [] },
    stream: { active: 'default', options: [] },
    validation: {
      active: 'default',
      options: [
        { id: 'default', path: '/x', local: false, meta: { name: 'airoa_hsr', version: 1, required_topics: [] } },
        { id: 'strict', path: '/y', local: false, meta: { name: 'strict', version: 2, required_topics: [{ name: '/a' }] } },
      ],
    },
    validators: {
      active: 'loss_report',
      options: [{ id: 'loss_report', path: '/z', local: false, meta: {} }],
    },
  },
};

const PRESETS = {
  items: [
    { id: 'fast', name: 'Fast validation', description: 'Required-topic check', pipeline: 'fast_validation', total: 5, pending: 2, pending_run_ids: ['r1', 'r2'] },
    { id: 'loss', name: 'Loss report', pipeline: 'loss_report', total: 5, pending: 0, pending_run_ids: [] },
  ],
};

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/validation/presets')) return Promise.resolve(jsonResponse(PRESETS));
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(OPTIONS));
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => {
  setApiBase('/api/v1');
  useUiStore.setState({ activeTab: 'settings' });
  mockFetch();
});
afterEach(() => vi.restoreAllMocks());

test('exposes the validation + validators aspect pickers', async () => {
  renderWithClient(<ValidationSection />);
  const validation = (await screen.findByLabelText('validation option')) as HTMLSelectElement;
  expect(validation.value).toBe('default');
  expect(screen.getByLabelText('validators option')).toBeInTheDocument();
});

test('lists presets with live pending counts (and up-to-date when zero)', async () => {
  renderWithClient(<ValidationSection />);
  await waitFor(() => expect(screen.getByTestId('preset-fast')).toBeInTheDocument());
  expect(screen.getByTestId('preset-fast')).toHaveTextContent('2 pending');
  expect(screen.getByTestId('preset-loss')).toHaveTextContent('up to date');
});

test('links to the Validation tab for execution (no run UI here)', async () => {
  renderWithClient(<ValidationSection />);
  fireEvent.click(await screen.findByTestId('validation-goto-tab'));
  expect(useUiStore.getState().activeTab).toBe('validation');
});
