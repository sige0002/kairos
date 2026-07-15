import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { SignalReportExt, SignalTopicReportExt } from './signalReport';
import { SignalHeatmap } from './SignalHeatmap';

const MS = 1_000_000;

function topic(over: Partial<SignalTopicReportExt> = {}): SignalTopicReportExt {
  return { t_ns: [0], fields: {}, ...over };
}

// span 60ms / 6 bins of 10ms. densities/edges/loss_events chosen so each colour
// rule is exercised: bin2 empty (red), bin3 under a major event (red), the rest
// green; a late topic exposes gray cells outside its active range.
function report(): SignalReportExt {
  return {
    span: { duration_ns: 60 * MS },
    topics: {
      '/a': topic({
        start_offset_ns: 0,
        edges: { start_delay_ns: 0, end_early_ns: 0 },
        loss_events: [{ start_ns: 30 * MS, duration_ns: 10 * MS, estimated_lost: 5, severity: 'major' }],
        bins: { count: 6, bin_ns: 10 * MS, densities: [3, 3, 0, 2, 1, 3] },
      }),
      '/b': topic({
        start_offset_ns: 20 * MS,
        edges: { start_delay_ns: 20 * MS, end_early_ns: 10 * MS },
        bins: { count: 6, bin_ns: 10 * MS, densities: [0, 0, 2, 2, 2, 0] },
      }),
    },
  };
}

test('renders one row per topic with its name label', () => {
  render(
    <SignalHeatmap report={report()} selectedTopic="/a" onSelectTopic={() => {}} onSeekGlobal={() => {}} />,
  );
  expect(screen.getByTestId('review-signal-heatmap')).toBeInTheDocument();
  expect(screen.getByTestId('heatmap-row-/a')).toBeInTheDocument();
  expect(screen.getByTestId('heatmap-row-/b')).toBeInTheDocument();
});

test('bin colours follow the L1 rules (green/red/gray)', () => {
  render(
    <SignalHeatmap report={report()} selectedTopic="/a" onSelectTopic={() => {}} onSeekGlobal={() => {}} />,
  );
  const rowA = screen.getByTestId('heatmap-row-/a');
  const cellsA = Array.from(rowA.querySelectorAll('[data-testid="heatmap-cell"]'));
  expect(cellsA.map((c) => c.getAttribute('data-color'))).toEqual([
    'green', // bin0 d3
    'green', // bin1 d3
    'red', //   bin2 d0 inside active
    'red', //   bin3 under the major event
    'green', // bin4 d1
    'green', // bin5 d3
  ]);
  // Topic /b begins 20ms in and ends 10ms early -> bins outside [20,50) are gray.
  const rowB = screen.getByTestId('heatmap-row-/b');
  const cellsB = Array.from(rowB.querySelectorAll('[data-testid="heatmap-cell"]'));
  expect(cellsB.map((c) => c.getAttribute('data-color'))).toEqual([
    'gray', //  bin0 before start
    'gray', //  bin1 before start
    'green', // bin2 d2
    'green', // bin3 d2
    'green', // bin4 d2
    'gray', //  bin5 after end
  ]);
});

test('clicking a bin seeks to that bin start on the global axis', () => {
  const onSeekGlobal = vi.fn();
  render(
    <SignalHeatmap
      report={{ span: { duration_ns: 60 * MS }, topics: { '/a': report().topics['/a']! } }}
      selectedTopic="/a"
      onSelectTopic={() => {}}
      onSeekGlobal={onSeekGlobal}
    />,
  );
  const cells = screen.getAllByTestId('heatmap-cell');
  fireEvent.click(cells[3]!); // bin index 3 -> 30ms on the global axis
  expect(onSeekGlobal).toHaveBeenCalledWith(30 * MS);
});

test('clicking a topic label selects it as the charted topic', () => {
  const onSelectTopic = vi.fn();
  render(
    <SignalHeatmap report={report()} selectedTopic="/a" onSelectTopic={onSelectTopic} onSeekGlobal={() => {}} />,
  );
  fireEvent.click(screen.getByText('/b'));
  expect(onSelectTopic).toHaveBeenCalledWith('/b');
});

test('renders nothing when the sidecar has no global span (v1.0)', () => {
  const { container } = render(
    <SignalHeatmap
      report={{ topics: report().topics }}
      selectedTopic="/a"
      onSelectTopic={() => {}}
      onSeekGlobal={() => {}}
    />,
  );
  expect(container).toBeEmptyDOMElement();
});

test('a topic with fewer than 2 messages shows an honest no-bins bar', () => {
  const r: SignalReportExt = {
    span: { duration_ns: 60 * MS },
    topics: { '/solo': topic({ start_offset_ns: 0, bins: null }) },
  };
  render(<SignalHeatmap report={r} selectedTopic="/solo" onSelectTopic={() => {}} onSeekGlobal={() => {}} />);
  expect(screen.getByText(/no bins/i)).toBeInTheDocument();
  expect(screen.queryAllByTestId('heatmap-cell')).toHaveLength(0);
});
