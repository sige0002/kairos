import { screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { queryKeys } from '../../api/queryKeys';
import type { LiveEventsResponse } from '../../api/types';
import { makeTestClient, renderWithClient } from '../../test/renderWithClient';
import { ExtensionEventsCard } from './ExtensionEventsCard';

function seed(client: ReturnType<typeof makeTestClient>, body: LiveEventsResponse) {
  client.setQueryData(queryKeys.liveEvents, body);
}

test('hidden entirely when the live backend has no event surface (LIVE=0)', () => {
  const client = makeTestClient();
  seed(client, { available: false, events: [] });
  renderWithClient(<ExtensionEventsCard />, { client });
  expect(screen.queryByTestId('extension-events')).not.toBeInTheDocument();
});

test('renders freeform events generically: slots + key=value chips, newest first', () => {
  const client = makeTestClient();
  seed(client, {
    available: true,
    events: [
      { t: 1784750560, kind: 'brightness_heartbeat', source: 'ext_a', topic: '/cam', frames_seen: 17 },
      { t: 1784750565, kind: 'dark_frame', source: 'ext_a', topic: '/cam', mean_gray: 12.3, threshold: 40 },
    ],
  });
  renderWithClient(<ExtensionEventsCard />, { client });

  const rows = screen.getAllByTestId('extension-events-row');
  expect(rows).toHaveLength(2);
  // Ring is oldest-first; UI shows newest (dark_frame) first.
  expect(rows[0]!).toHaveTextContent('dark_frame');
  expect(rows[0]!).toHaveTextContent('mean_gray=12.3');
  expect(rows[0]!).toHaveTextContent('threshold=40');
  expect(rows[1]!).toHaveTextContent('brightness_heartbeat');
  expect(rows[1]!).toHaveTextContent('frames_seen=17');
  expect(screen.getByTestId('extension-events-count')).toHaveTextContent('2 shown');
});

test('honest empty state when the surface exists but the ring is empty', () => {
  const client = makeTestClient();
  seed(client, { available: true, events: [] });
  renderWithClient(<ExtensionEventsCard />, { client });
  expect(screen.getByTestId('extension-events-empty')).toBeInTheDocument();
});
