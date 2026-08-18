// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// E-32's sibling in Monitor: the "(Ns so far)" caveat is a DURATION.
//
// The Topics view says how long the chart buffer has actually been
// accumulating, and hides the note once the selected window is genuinely full
// (D-8-7 honesty: "at most 1m since Monitor opened", not a rolling history that
// predates this session). Both the number and the hide/show decision come from
// `now - openedAt`, measured on the wall clock — so an NTP step moves them.
//
// The forward step is the one that matters, and it is the opposite of the
// Collect defect: there a step made a number wrong, here it makes a CAVEAT
// DISAPPEAR. `windowNotFull` goes false the instant the clock jumps past the
// window, and the screen silently starts presenting a 12-second buffer as a
// full one-minute window. A disclosure that a clock step can switch off is not
// a disclosure.
//
// SCOPE, stated because it was argued before it was implemented: this fixes the
// caveat, NOT the chart's time axis. The samples themselves are stamped with
// `t: Date.now()` in useMetricHistory and aged out against the same wall clock,
// so a step still disturbs the plot. Making the axis monotonic means changing
// what a sample's timestamp MEANS, which is a larger decision than this one and
// is reported rather than taken here. The caveat is a self-contained local
// duration and is correct to fix on its own.

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { __resetPanelStore } from './panelStore';
import { MonitorScreen } from './MonitorScreen';

const CONFIG = {
  endpoints: {
    api: '/api/v1',
    events: '/api/v1/events',
    webrtc: 'http://localhost:8002',
  },
  tabs: [],
  defaults: {
    default_topics: ['/hsrb/joint_states'],
    expected_hz: { '/hsrb/joint_states': 50 },
  },
  schemas: {},
};

const DISCOVERED = [
  {
    name: '/hsrb/joint_states',
    type: 'sensor_msgs/msg/JointState',
    publisher_count: 1,
  },
];

function mockFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({ state: 'created', run_id: null, live_capture_ids: [] }),
      );
    }
    if (url.includes('/topics')) return Promise.resolve(jsonResponse(DISCOVERED));
    if (url.includes('/system')) {
      return Promise.resolve(
        jsonResponse({ cpu: { model: 'Test CPU', cores: 8 }, gpu: null }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
}

/** Step the system clock while the real clock — and `performance.now()` — keep
 *  running underneath. The shape of a real NTP step: one clock moves. */
function stepSystemClock(deltaMs: number): void {
  const real = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => real() + deltaMs);
}

/** The Topics view's honesty line. */
function windowNote(): HTMLElement {
  return screen.getByTitle('History accumulates from when Monitor opened.');
}

/**
 * Wait until the note has been RECOMPUTED since *before*.
 *
 * `useNowClock` only advances on its own 1 s interval, so a clock step is
 * invisible to this line until the next tick. Asserting before that tick is how
 * the forward-step test first passed against the unfixed code: the caveat was
 * still up only because nothing had looked at the clock yet.
 */
async function settleNote(): Promise<void> {
  // Discovery lands after the first render and rewrites the topic count in this
  // same line. Waiting for it first means a later text change can only be the
  // clock — otherwise `noteRecomputed` resolves on "0 topics" -> "1 topics" and
  // the assertion runs before the clock has been looked at once.
  await waitFor(() => expect(windowNote()).toHaveTextContent(/1 topics/));
}

async function noteRecomputed(before: string): Promise<void> {
  await waitFor(() => expect(windowNote().textContent).not.toBe(before), {
    timeout: 4000,
  });
}

beforeEach(() => {
  setApiBase('/api/v1');
  __resetPanelStore();
  useUiStore.setState({
    activeTab: 'monitor',
    sseStatus: 'closed',
    monitorBridge: null,
    recMarkers: [],
    recMarkersPrevActive: null,
    probeSeries: [],
    recordSelected: new Set<string>(),
    recordCustomized: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('a forward clock step does not switch off the "so far" caveat', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  // Default sub-view is Overview (§11 landing); the caveat lives in Topics.
  fireEvent.click(await screen.findByTestId('mon-nav-Topics'));

  // Positive control: the caveat is up, because this session is seconds old and
  // the default window is a minute.
  await waitFor(() => expect(windowNote()).toHaveTextContent(/so far/));
  await settleNote();

  const before = windowNote().textContent ?? '';

  // NTP steps the terminal forward an hour. Not one further sample has arrived,
  // so the buffer holds exactly what it held a moment ago.
  stepSystemClock(60 * 60_000);

  await noteRecomputed(before);
  // The window is a minute and this session is seconds old, so the caveat has
  // to still be there. Losing it means the screen now presents a few seconds of
  // buffer as a full window.
  expect(windowNote()).toHaveTextContent(/so far/);
}, 10000);

test('a backward clock step does not reset the accumulated time to zero', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  fireEvent.click(await screen.findByTestId('mon-nav-Topics'));
  await waitFor(() => expect(windowNote()).toHaveTextContent(/so far/));
  await settleNote();

  const before = windowNote().textContent ?? '';

  stepSystemClock(-60 * 60_000);

  await noteRecomputed(before);
  // Clamped at zero, a backwards step reads as "this only just opened" — the
  // same shape as Collect's 00:00:00, in a caveat instead of a timer.
  expect(windowNote()).toHaveTextContent(/so far/);
  expect(windowNote().textContent ?? '').not.toMatch(/\(0s so far\)/);
}, 10000);
