// Render tests for the Scope band shell (jsdom; uPlot itself is guarded to a
// no-op empty div in a canvas-less env — see UplotChart.tsx — so these assert
// DOM structure, not chart pixels).

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { makeTestClient, renderWithClient } from '../../../test/renderWithClient';
import { queryKeys } from '../../../api/queryKeys';
import { useUiStore } from '../../../store/uiStore';
import { ScopeBand } from './ScopeBand';

beforeEach(() => {
  useUiStore.setState({
    scopeOpen: false,
    scopeWindowId: '1m',
    scopePanels: [],
    scopePanelSeq: 0,
  });
});

test('renders collapsed by default; the toggle expands it', async () => {
  renderWithClient(<ScopeBand history={new Map()} topics={[]} markers={[]} />);

  expect(screen.getByLabelText('toggle scope')).toBeInTheDocument();
  expect(screen.queryByLabelText('add health panel')).not.toBeInTheDocument();

  fireEvent.click(screen.getByLabelText('toggle scope'));
  expect(await screen.findByLabelText('add health panel')).toBeInTheDocument();
});

test('+ Health adds a panel defaulting to Frequency; adding a topic shows a chip', async () => {
  renderWithClient(<ScopeBand history={new Map()} topics={['/hsrb/odom']} markers={[]} />);
  fireEvent.click(screen.getByLabelText('toggle scope'));
  fireEvent.click(await screen.findByLabelText('add health panel'));

  const panel = await screen.findByTestId('scope-panel');
  const metricSelect = within(panel).getByLabelText('scope metric') as HTMLSelectElement;
  expect(metricSelect.value).toBe('hz');
  expect(within(panel).getByText('Frequency (Hz)')).toBeInTheDocument();

  fireEvent.change(within(panel).getByLabelText('scope add topic'), {
    target: { value: '/hsrb/odom' },
  });
  fireEvent.click(within(panel).getByText('+ Add'));

  expect(within(panel).getByText('odom')).toBeInTheDocument(); // topic chip (short name)
});

test('+ Signal adds a panel with rate defaulting to 10 Hz', async () => {
  const client = makeTestClient();
  client.setQueryData(queryKeys.probeTopics, []);
  renderWithClient(<ScopeBand history={new Map()} topics={[]} markers={[]} />, { client });
  fireEvent.click(screen.getByLabelText('toggle scope'));
  fireEvent.click(await screen.findByLabelText('add signal panel'));

  const panel = await screen.findByTestId('scope-panel');
  const rateSelect = within(panel).getByLabelText('scope rate') as HTMLSelectElement;
  expect(rateSelect.value).toBe('10');
});

test('panels persist across unmount/remount (store-backed)', async () => {
  const client = makeTestClient();
  client.setQueryData(queryKeys.probeTopics, []);
  const { unmount } = renderWithClient(
    <ScopeBand history={new Map()} topics={['/a']} markers={[]} />,
    { client },
  );
  fireEvent.click(screen.getByLabelText('toggle scope'));
  fireEvent.click(await screen.findByLabelText('add health panel'));
  await screen.findByTestId('scope-panel');

  unmount();
  renderWithClient(<ScopeBand history={new Map()} topics={['/a']} markers={[]} />, { client });

  expect(await screen.findByTestId('scope-panel')).toBeInTheDocument();
});

test('collapsed band renders no panel content', async () => {
  useUiStore.setState({
    scopePanels: [{ id: 0, kind: 'health', metric: 'hz', topics: ['/a'] }],
    scopePanelSeq: 1,
    scopeOpen: false,
  });
  renderWithClient(<ScopeBand history={new Map()} topics={['/a']} markers={[]} />);

  expect(screen.queryByTestId('scope-panel')).not.toBeInTheDocument();
  // The collapsed bar still surfaces the panel count.
  expect(screen.getByText('1 panel')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText('toggle scope')).toBeInTheDocument());
});
