import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeTestClient } from '../../test/renderWithClient';
import { setApiBase } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { RuntimeConfig } from '../../config';
import { GraphTab } from './GraphTab';

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: '' },
  tabs: [],
  defaults: { default_topics: [], expected_hz: {} },
  schemas: {},
} as RuntimeConfig;

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

function renderGraph() {
  const client = makeTestClient();
  // SSE-fed metrics cache: two flowing topics, both with hz/bandwidth/gap but
  // (like the real non-intrusive monitor) no latency and no loss.
  client.setQueryData(queryKeys.metrics, {
    topics: [
      { name: '/hsrb/joint_states', hz: 49.6, bandwidth_bps: 2_000_000, gap_max_ms: 12 },
      { name: '/camera/image', hz: 30, bandwidth_bps: 8_000_000, gap_max_ms: 40 },
    ],
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return render(createElement(GraphTab, { config: CONFIG }), { wrapper });
}

test('defaults to three robot-independent metric panels and lists flowing topics', async () => {
  renderGraph();

  // The default panels are the always-available, robot-independent metrics.
  const metricSelects = await screen.findAllByLabelText('metric');
  expect(metricSelects).toHaveLength(3);
  expect((metricSelects[0] as HTMLSelectElement).value).toBe('hz');
  expect((metricSelects[1] as HTMLSelectElement).value).toBe('bw');
  expect((metricSelects[2] as HTMLSelectElement).value).toBe('gap');

  // Topics come from the live snapshot (no hardcoded names): both appear as
  // series toggles in every panel (short names).
  await waitFor(() =>
    expect(screen.getAllByText('joint_states').length).toBeGreaterThan(0),
  );
  expect(screen.getAllByText('image').length).toBeGreaterThan(0);
});

test('add/remove panels works like the Stream tab', async () => {
  renderGraph();
  await screen.findAllByLabelText('metric');

  fireEvent.click(screen.getByRole('button', { name: '+ Add graph' }));
  await waitFor(() => expect(screen.getAllByLabelText('metric')).toHaveLength(4));

  // Each panel past the first is removable.
  const removes = screen.getAllByRole('button', { name: 'remove graph' });
  expect(removes.length).toBe(4);
  fireEvent.click(removes[0]!);
  await waitFor(() => expect(screen.getAllByLabelText('metric')).toHaveLength(3));
});

test('latency & loss are not offered as metrics (dropped: non-intrusive monitor cannot measure them)', async () => {
  renderGraph();
  const select = (await screen.findAllByLabelText('metric'))[0] as HTMLSelectElement;
  const optionValues = [...select.options].map((o) => o.value);
  expect(optionValues).toContain('hz');
  expect(optionValues).toContain('bw');
  expect(optionValues).toContain('gap');
  expect(optionValues).not.toContain('lat');
  expect(optionValues).not.toContain('loss');
});

test('toggling a series off removes it from that panel only', async () => {
  renderGraph();
  await screen.findAllByLabelText('metric');

  // First panel (hz). Its topic toggles start all-on.
  const firstPanel = screen.getAllByLabelText('metric')[0]!.closest('div')!.parentElement!;
  const jointToggle = within(firstPanel)
    .getAllByText('joint_states')
    .map((el) => el.closest('button'))
    .find((b): b is HTMLButtonElement => b !== null)!;
  expect(jointToggle).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(jointToggle);
  await waitFor(() => expect(jointToggle).toHaveAttribute('aria-pressed', 'false'));
});
