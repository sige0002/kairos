// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// E-24 — the series chip, and what keeps a 120-character topic name from
// taking the page with it.
//
// WHAT THIS FILE IS AND IS NOT. The layout claim itself is MEASURED, not tested
// here: jsdom has no layout engine, `getBoundingClientRect` returns zeros, and
// an assertion about overflow would pass whatever the CSS said. The measurement
// (chromium, real dev server, a 120-char topic + 88-char field) is what found
// the defect — 166px of horizontal PAGE scroll with the chip overhanging the
// viewport by 146px — and what confirmed the fix at 0.
//
// What a unit test CAN hold is the mechanism that measurement depends on: the
// chip is capped at its row and its label truncates, the full identity stays
// reachable, and the legend rule is both HOOKED UP (its container really
// carries the class the CSS targets) and a working, bounded set.
//
// That last clause is here because the first version of this file overclaimed.
// It grepped the stylesheet for three substrings, and a reviewer showed four
// mutations passing it green — renaming the container class, dropping
// `overflow: hidden`, and widening either cap to 9999ch — every one of which
// puts the operator back in front of a silently guillotined name. The scope of
// a tripwire is worth stating precisely: these tests guard the MECHANISM, and
// only as tightly as the assertions below actually bind it.

import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeTestClient } from '../../../test/renderWithClient';
import { useUiStore } from '../../../store/uiStore';
import { SignalsView } from './SignalsView';

// The probe hooks talk to topic_probe over HTTP/SSE; this file is about what
// the chip renders for a series that is already in the store.
vi.mock('../../../features/probe/useProbe', () => ({
  useProbeTopics: () => ({ data: [], isPending: false }),
  useProbeFields: () => ({ data: { fields: [] }, isPending: false }),
  useProbeSeries: () => ({ data: [], status: 'idle' }),
}));
vi.mock('../../../features/probe/UplotChart', () => ({
  PALETTE: ['#000'],
  UplotChart: () => null,
}));

// Real lengths from a real arm: the topic is 120 chars, the field path 88.
const TOPIC =
  '/myrobot/manipulation/arm_controller/joint_trajectory_controller/state/feedback/measured_joint_positions_with_timestamps';
const FIELD = 'measured_joint_positions_with_timestamps.position[0].value_in_radians_since_calibration';

beforeEach(() => {
  useUiStore.setState({
    probeSeries: [{ id: 's0', topic: TOPIC, field: FIELD }],
    probeHz: 10,
    probeWindowId: '30s',
  });
});
afterEach(() => {
  useUiStore.setState({ probeSeries: [] });
  vi.restoreAllMocks();
});

function renderView() {
  return render(
    <QueryClientProvider client={makeTestClient()}>
      <SignalsView />
    </QueryClientProvider>,
  );
}

test('a long series chip is capped at its row and truncates instead of widening it', () => {
  renderView();
  const chip = screen.getByTestId('signals-chip-s0');
  // Capped at the row: without this the chip grows to its content and the page
  // itself gains a horizontal scrollbar (measured 166px at 1280x800/150%).
  expect(chip.className).toMatch(/max-w-full/);
  expect(chip.className).toMatch(/min-w-0/);
  // And the label is the part that gives way, not the chip's own box.
  const label = chip.querySelector('[title]');
  expect(label).not.toBeNull();
  expect(label!.className).toMatch(/truncate/);
});

test('truncating the chip loses nothing: the full topic and field stay on the title', () => {
  renderView();
  const chip = screen.getByTestId('signals-chip-s0');
  const label = chip.querySelector('[title]')!;
  // The visible text may be cut by CSS; the title is what makes that honest —
  // a truncation an operator cannot undo would be information destroyed.
  expect(label.getAttribute('title')).toBe(`${TOPIC} · ${FIELD}`);
  expect(label.getAttribute('title')).toContain(TOPIC);
  expect(label.getAttribute('title')).toContain(FIELD);
});

test("uPlot's own legend is capped too, and marks the cut", () => {
  // The legend is KEPT on this view (it is the hover value readout) unlike the
  // frequency charts that scope it away, so it needs its own cap: its series
  // cell is one unbreakable `topic · field` line and was overhanging by 207px.
  //
  // Grepping the stylesheet for three substrings is NOT enough, and a reviewer
  // proved it: renaming the container class, dropping `overflow: hidden`, or
  // widening either cap to 9999ch all left the old assertions GREEN while the
  // operator sees a name guillotined. So this checks two things instead — that
  // the class the rule TARGETS is actually on the rendered container, and that
  // the `.u-label` declarations form a WORKING SET with a bounded cap.
  const { container } = renderView();
  // 1. the hook: a rule scoped to `.signals-chart` does nothing if the div is
  //    renamed, and nothing in the CSS text would reveal that.
  expect(container.querySelector('.signals-chart')).not.toBeNull();

  const css = Array.from(container.querySelectorAll('style'))
    .map((s) => s.textContent ?? '')
    .join(' ');
  expect(css).toMatch(/\.signals-chart .*\.u-legend/);

  // 2. the working set. Ellipsis needs all three to render at all, and a cap of
  //    9999ch is a cap that never bites — so the bound is asserted as a small
  //    number, not merely as the presence of the words "max-width".
  const labelRule = /\.u-label\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  expect(labelRule).toMatch(/overflow:\s*hidden/);
  expect(labelRule).toMatch(/text-overflow:\s*ellipsis/);
  expect(labelRule).toMatch(/white-space:\s*nowrap/);
  expect(labelRule).toMatch(/max-width:\s*\d{1,3}(ch|px)/);

  // The cell cap behind it, likewise bounded.
  const thRule = /\.u-legend th\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  expect(thRule).toMatch(/max-width:\s*\d{1,3}(ch|px)/);
});
