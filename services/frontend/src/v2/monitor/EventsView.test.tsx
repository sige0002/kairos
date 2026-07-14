import { fireEvent, screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { queryKeys } from '../../api/queryKeys';
import type { AlertEvent } from '../../api/types';
import { makeTestClient, renderWithClient } from '../../test/renderWithClient';
import { EventsView } from './EventsView';

const ALERTS: AlertEvent[] = [
  // newest-first (as useEventStream writes them)
  { topic: '/cam/image', metric: 'gap', op: 'gt', threshold: 100, value: 250, state: 'firing', since: '2026-07-14T10:00:03Z' },
  { topic: '/hsrb/joint_states', metric: 'hz', op: 'lt', threshold: 15, value: 8, state: 'cleared', since: '2026-07-14T10:00:01Z' },
  { topic: '/hsrb/joint_states', metric: 'hz', op: 'lt', threshold: 15, value: 9, state: 'firing', since: '2026-07-14T10:00:01Z' },
];

test('renders one incident row per (topic, metric) from the real alert buffer', () => {
  const client = makeTestClient();
  client.setQueryData(queryKeys.alerts, ALERTS);
  renderWithClient(<EventsView />, { client });

  const rows = screen.getAllByTestId('events-row');
  expect(rows).toHaveLength(2); // cam gap + joint_states hz (folded)
  expect(screen.getByTestId('events-firing-count')).toHaveTextContent('1 firing · 2 total');
});

test('honest empty state when nothing has fired', () => {
  const client = makeTestClient();
  client.setQueryData(queryKeys.alerts, []);
  renderWithClient(<EventsView />, { client });
  expect(screen.getByTestId('events-empty')).toBeInTheDocument();
});

test('the state filter narrows to firing / cleared', () => {
  const client = makeTestClient();
  client.setQueryData(queryKeys.alerts, ALERTS);
  renderWithClient(<EventsView />, { client });

  fireEvent.click(screen.getByTestId('events-state-cleared'));
  const rows = screen.getAllByTestId('events-row');
  expect(rows).toHaveLength(1);
  expect(rows[0]!).toHaveTextContent('joint_states');
});

test('the topic filter matches on substring', () => {
  const client = makeTestClient();
  client.setQueryData(queryKeys.alerts, ALERTS);
  renderWithClient(<EventsView />, { client });

  fireEvent.change(screen.getByTestId('events-filter'), { target: { value: 'cam' } });
  const rows = screen.getAllByTestId('events-row');
  expect(rows).toHaveLength(1);
  expect(within(rows[0]!).getByText(/image/)).toBeInTheDocument();

  fireEvent.change(screen.getByTestId('events-filter'), { target: { value: 'nomatch' } });
  expect(screen.getByTestId('events-no-match')).toBeInTheDocument();
});
