// Render tests for LiveHealthGraph: the monitor self-load (OL-②.4) and the
// learned baseline (OL-②.3) must be VISIBLE in the DOM, not just formatted by a
// helper. Both are read from the SSE-fed metrics cache for the open topic.

import { screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { makeTestClient, renderWithClient } from '../../test/renderWithClient';
import { queryKeys } from '../../api/queryKeys';
import type { MetricsSnapshot } from '../../api/types';
import { LiveHealthGraph } from './LiveHealthGraph';

function renderGraph(snapshot: MetricsSnapshot, topic = '/telemetry') {
  const client = makeTestClient();
  client.setQueryData(queryKeys.metrics, snapshot);
  return renderWithClient(
    <LiveHealthGraph
      topic={topic}
      label={topic.split('/').filter(Boolean).at(-1) ?? topic}
      points={[]}
      markers={[]}
      onClose={() => {}}
    />,
    { client },
  );
}

test('renders the monitor self-load badge (OL-②.4) from the snapshot', () => {
  renderGraph({
    ts: '',
    window_s: 5,
    topics: [{ name: '/telemetry', hz: 9.8 }],
    self_load: { callback_lag_ms: 3.4, snapshot_age_s: 1.2, status: 'warning' },
  });
  // The actual latency/age value is on screen (not just helper-tested).
  expect(screen.getByText(/3\.4 ms cb · 1\.2 s age/)).toBeInTheDocument();
  expect(screen.getByText(/monitor/i)).toBeInTheDocument();
});

test('renders the learned baseline label (OL-②.3) for an unconfigured topic', () => {
  renderGraph({
    ts: '',
    window_s: 5,
    topics: [
      { name: '/telemetry', hz: 9.8, baseline_hz: 10.2, baseline_state: 'stable' },
    ],
  });
  expect(screen.getByText(/baseline ~10\.2 Hz/)).toBeInTheDocument();
});

test('shows "learning…" while the baseline is still warming up', () => {
  renderGraph({
    ts: '',
    window_s: 5,
    topics: [{ name: '/telemetry', hz: 9.8, baseline_state: 'learning' }],
  });
  expect(screen.getByText(/baseline learning…/)).toBeInTheDocument();
});
