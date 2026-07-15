import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { SignalReportExt, SignalTopicReportExt } from './signalReport';
import { LossEventList } from './LossEventList';

const MS = 1_000_000;

function topic(over: Partial<SignalTopicReportExt> = {}): SignalTopicReportExt {
  return { t_ns: [0], fields: {}, ...over };
}

test('lists every topic loss event sorted by time, with severity', () => {
  const report: SignalReportExt = {
    span: { duration_ns: 500 * MS },
    topics: {
      '/a': topic({
        loss_events: [{ start_ns: 300 * MS, duration_ns: 20 * MS, estimated_lost: 2, severity: 'minor' }],
      }),
      '/b': topic({
        loss_events: [{ start_ns: 100 * MS, duration_ns: 40 * MS, estimated_lost: 5, severity: 'major' }],
      }),
    },
  };
  render(<LossEventList report={report} onSeekGlobal={() => {}} />);
  const rows = screen.getAllByTestId('review-loss-row');
  expect(rows).toHaveLength(2);
  // Sorted by time: /b (100ms) before /a (300ms).
  expect(within(rows[0]!).getByText('/b')).toBeInTheDocument();
  expect(within(rows[0]!).getByText('major')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('/a')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('minor')).toBeInTheDocument();
  expect(screen.queryByTestId('review-loss-empty')).toBeNull();
});

test('clicking a loss row seeks to its global start time', () => {
  const onSeekGlobal = vi.fn();
  const report: SignalReportExt = {
    span: { duration_ns: 500 * MS },
    topics: {
      '/b': topic({
        loss_events: [{ start_ns: 100 * MS, duration_ns: 40 * MS, estimated_lost: 5, severity: 'major' }],
      }),
    },
  };
  render(<LossEventList report={report} onSeekGlobal={onSeekGlobal} />);
  fireEvent.click(screen.getByTestId('review-loss-row'));
  expect(onSeekGlobal).toHaveBeenCalledWith(100 * MS);
});

test('honest empty state when no losses were detected', () => {
  const report: SignalReportExt = { span: { duration_ns: 500 * MS }, topics: { '/a': topic() } };
  render(<LossEventList report={report} onSeekGlobal={() => {}} />);
  expect(screen.getByTestId('review-loss-empty')).toHaveTextContent(
    'No losses detected — threshold 1.5× median interval.',
  );
  expect(screen.queryByTestId('review-loss-row')).toBeNull();
});

test('nonzero edges render as subtle rows and seek their global position', () => {
  const onSeekGlobal = vi.fn();
  const report: SignalReportExt = {
    span: { duration_ns: 500 * MS },
    topics: {
      '/a': topic({ edges: { start_delay_ns: 0, end_early_ns: 100 * MS } }),
      '/b': topic({ edges: { start_delay_ns: 200 * MS, end_early_ns: 0 } }),
    },
  };
  render(<LossEventList report={report} onSeekGlobal={onSeekGlobal} />);
  // No losses -> the empty note shows, but the edge rows still render.
  expect(screen.getByTestId('review-loss-empty')).toBeInTheDocument();
  const edgeRows = screen.getAllByTestId('review-loss-edge');
  expect(edgeRows).toHaveLength(2);
  expect(screen.getByText('started late')).toBeInTheDocument();
  expect(screen.getByText('ended early')).toBeInTheDocument();
  // /b start delay sits at global 0.
  fireEvent.click(screen.getByText('started late').closest('tr')!);
  expect(onSeekGlobal).toHaveBeenCalledWith(0);
});

test('shows the truncation note when any topic capped its event list', () => {
  const report: SignalReportExt = {
    span: { duration_ns: 500 * MS },
    topics: {
      '/a': topic({
        loss_events: [{ start_ns: 100 * MS, duration_ns: 40 * MS, estimated_lost: 5, severity: 'major' }],
        loss_events_truncated: 50,
      }),
    },
  };
  render(<LossEventList report={report} onSeekGlobal={() => {}} />);
  expect(screen.getByTestId('review-loss-truncated')).toHaveTextContent(
    '50 more events not shown (largest kept).',
  );
});
