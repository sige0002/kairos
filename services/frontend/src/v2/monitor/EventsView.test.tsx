// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { fireEvent, screen, within } from '@testing-library/react';
import { act } from '@testing-library/react';
import { expect, test } from 'vitest';
import { i18n } from '../../i18n';
import { queryKeys } from '../../api/queryKeys';
import type { AlertEvent } from '../../api/types';
import { makeTestClient, renderWithClient } from '../../test/renderWithClient';
import { EventsView } from './EventsView';

const ALERTS: AlertEvent[] = [
  // newest-first (as useEventStream writes them)
  {
    topic: '/cam/image',
    metric: 'gap',
    op: 'gt',
    threshold: 100,
    value: 250,
    state: 'firing',
    since: '2026-07-14T10:00:03Z',
  },
  {
    topic: '/hsrb/joint_states',
    metric: 'hz',
    op: 'lt',
    threshold: 15,
    value: 8,
    state: 'cleared',
    since: '2026-07-14T10:00:01Z',
  },
  {
    topic: '/hsrb/joint_states',
    metric: 'hz',
    op: 'lt',
    threshold: 15,
    value: 9,
    state: 'firing',
    since: '2026-07-14T10:00:01Z',
  },
];

test('renders one incident row per (topic, metric) from the real alert buffer', () => {
  const client = makeTestClient();
  client.setQueryData(queryKeys.alerts, ALERTS);
  renderWithClient(<EventsView />, { client });

  const rows = screen.getAllByTestId('events-row');
  expect(rows).toHaveLength(2); // cam gap + joint_states hz (folded)
  expect(screen.getByTestId('events-firing-count')).toHaveTextContent(
    '1 firing · 2 total',
  );
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

  fireEvent.change(screen.getByTestId('events-filter'), {
    target: { value: 'nomatch' },
  });
  expect(screen.getByTestId('events-no-match')).toBeInTheDocument();
});

test('reformats stable alert data when the locale changes', async () => {
  const client = makeTestClient();
  client.setQueryData(queryKeys.alerts, ALERTS);
  renderWithClient(<EventsView />, { client });
  expect(screen.getAllByTestId('events-row')[0]).toHaveTextContent('gap');

  await act(async () => {
    await i18n.changeLanguage('ja');
  });

  expect(screen.getAllByTestId('events-row')[0]).toHaveTextContent('間隔');
  await act(async () => {
    await i18n.changeLanguage('en');
  });
});

// E-24. A topic name with NO break opportunity — no slash, no space, which is
// what a driver that underscores its whole path produces — has nowhere to wrap.
// MEASURED in chromium against the Events RAIL (EventsCard, a 330px column):
// 448px of the name painted outside the card, cut at the panel edge with no
// ellipsis, and the fix confirmed at 0. jsdom has no layout engine and cannot
// hold that claim; what it CAN hold is the mechanism the measurement depends
// on. In this view the same shape is latent rather than reproduced — it is
// full-width, so the name that broke the rail still fits — which is exactly why
// a tripwire is worth more here than a screenshot.
test('an alert title can break a word that would otherwise leave the card', () => {
  const client = makeTestClient();
  client.setQueryData(queryKeys.alerts, [
    {
      topic:
        '/myrobot_front_left_stereo_camera_module_image_raw_compressed_republished_for_recording_with_timestamps',
      metric: 'hz',
      op: 'lt',
      threshold: 30,
      value: 0.0123,
      state: 'firing',
      since: '2026-08-06T02:00:00Z',
    },
  ] satisfies AlertEvent[]);
  renderWithClient(<EventsView />, { client });

  const title = screen.getByText(/myrobot_front_left_stereo/);
  expect(title.className).toMatch(/break-words/);
});
