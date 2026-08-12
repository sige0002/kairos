// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Rendering/interaction tests for the aggregated integrity timeline.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { SignalReportExt } from './signalReport';
import { LossTimeline } from './LossTimeline';

afterEach(cleanup);

const MS = 1_000_000;

function report(): SignalReportExt {
  return {
    span: { duration_ns: 40 * MS },
    topics: {
      '/a': {
        t_ns: [0],
        fields: {},
        bins: { count: 4, bin_ns: 10 * MS, densities: [3, 3, 0, 3] },
      },
    },
  };
}

test('renders one worst-severity lane with per-bin colours', () => {
  render(
    <LossTimeline report={report()} playheadFrac={null} seekEnabled={false} onSeekGlobal={() => {}} />,
  );
  const bins = screen.getAllByTestId('timeline-bin');
  expect(bins).toHaveLength(4);
  expect(bins.map((b) => b.getAttribute('data-color'))).toEqual([
    'green',
    'green',
    'red',
    'green',
  ]);
  // No synced full-length video → seeking is disabled (a click would lie).
  expect(bins[2]).toBeDisabled();
  expect(screen.queryByTestId('timeline-playhead')).toBeNull();
});

test('clicking a bin seeks to its global start when sync is enabled', () => {
  const onSeek = vi.fn();
  render(
    <LossTimeline report={report()} playheadFrac={0.5} seekEnabled onSeekGlobal={onSeek} />,
  );
  fireEvent.click(screen.getAllByTestId('timeline-bin')[2]!);
  expect(onSeek).toHaveBeenCalledWith(20 * MS);
  expect(screen.getByTestId('timeline-playhead')).toBeInTheDocument();
});

test('renders nothing without a global span (v1.0 sidecar)', () => {
  const noSpan: SignalReportExt = { topics: report().topics };
  const { container } = render(
    <LossTimeline report={noSpan} playheadFrac={null} seekEnabled={false} onSeekGlobal={() => {}} />,
  );
  expect(container).toBeEmptyDOMElement();
});
