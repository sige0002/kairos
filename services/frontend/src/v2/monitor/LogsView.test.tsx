// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { fireEvent, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { queryKeys } from '../../api/queryKeys';
import type { SessionLogEntry } from '../../api/types';
import { makeTestClient, renderWithClient } from '../../test/renderWithClient';
import { LogsView } from './LogsView';

const NOW = Date.parse('2026-07-14T10:00:00Z');
const LOG: SessionLogEntry[] = [
  { id: 3, ts: NOW + 3000, type: 'job', summary: 'fast_validation · succeeded · run-9' },
  { id: 2, ts: NOW + 2000, type: 'alert', summary: '/hsrb/joint_states hz = 8' },
  { id: 1, ts: NOW + 1000, type: 'record_status', summary: 'recording · run-9' },
];

test('renders the received SSE lifecycle events, newest-first', () => {
  const client = makeTestClient();
  client.setQueryData(queryKeys.eventLog, LOG);
  renderWithClient(<LogsView />, { client });

  const rows = screen.getAllByTestId('logs-row');
  expect(rows).toHaveLength(3);
  expect(rows[0]!).toHaveTextContent('fast_validation · succeeded');
  expect(screen.getByTestId('logs-count')).toHaveTextContent('3 events');
});

test('honest empty state before any event arrives', () => {
  const client = makeTestClient();
  client.setQueryData(queryKeys.eventLog, []);
  renderWithClient(<LogsView />, { client });
  expect(screen.getByTestId('logs-empty')).toBeInTheDocument();
});

test('the type filter narrows to a single event kind', () => {
  const client = makeTestClient();
  client.setQueryData(queryKeys.eventLog, LOG);
  renderWithClient(<LogsView />, { client });

  fireEvent.click(screen.getByTestId('logs-type-alert'));
  const rows = screen.getAllByTestId('logs-row');
  expect(rows).toHaveLength(1);
  expect(rows[0]!).toHaveTextContent('/hsrb/joint_states hz = 8');
});

test('the text filter matches the summary line', () => {
  const client = makeTestClient();
  client.setQueryData(queryKeys.eventLog, LOG);
  renderWithClient(<LogsView />, { client });

  fireEvent.change(screen.getByTestId('logs-filter'), { target: { value: 'run-9' } });
  expect(screen.getAllByTestId('logs-row')).toHaveLength(2);

  fireEvent.change(screen.getByTestId('logs-filter'), { target: { value: 'zzz' } });
  expect(screen.getByTestId('logs-no-match')).toBeInTheDocument();
});
