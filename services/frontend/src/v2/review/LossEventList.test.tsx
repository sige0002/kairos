// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { SignalReportExt, SignalTopicReportExt } from './signalReport';
import { LossEventList } from './LossEventList';

const MS = 1_000_000;

function topic(over: Partial<SignalTopicReportExt> = {}): SignalTopicReportExt {
  return { t_ns: [0], fields: {}, ...over };
}

test('ranks events worst-first: majors before minors even when later in time', () => {
  const report: SignalReportExt = {
    span: { duration_ns: 500 * MS },
    topics: {
      '/a': topic({
        loss_events: [{ start_ns: 100 * MS, duration_ns: 20 * MS, estimated_lost: 2, severity: 'minor' }],
      }),
      '/b': topic({
        loss_events: [{ start_ns: 300 * MS, duration_ns: 40 * MS, estimated_lost: 5, severity: 'major' }],
      }),
    },
  };
  render(<LossEventList report={report} onSeekGlobal={() => {}} />);
  const rows = screen.getAllByTestId('review-loss-row');
  expect(rows).toHaveLength(2);
  // Ranked: the MAJOR /b (300ms) outranks the earlier minor /a (100ms).
  expect(within(rows[0]!).getByText('/b')).toBeInTheDocument();
  expect(within(rows[0]!).getByText('major')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('/a')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('minor')).toBeInTheDocument();
  expect(screen.queryByTestId('review-loss-empty')).toBeNull();
});

test('folds beyond the first 8 events behind an explicit Show all', () => {
  const report: SignalReportExt = {
    span: { duration_ns: 500 * MS },
    topics: {
      '/a': topic({
        loss_events: Array.from({ length: 10 }, (_, i) => ({
          start_ns: i * 10 * MS,
          duration_ns: (10 - i) * MS, // descending so the ranked order is stable
          estimated_lost: 1,
          severity: 'minor' as const,
        })),
      }),
    },
  };
  render(<LossEventList report={report} onSeekGlobal={() => {}} />);
  expect(screen.getAllByTestId('review-loss-row')).toHaveLength(8);
  const toggle = screen.getByTestId('review-loss-show-all');
  expect(toggle).toHaveTextContent('Show all 10 events (2 folded)');
  fireEvent.click(toggle);
  expect(screen.getAllByTestId('review-loss-row')).toHaveLength(10);
  expect(toggle).toHaveTextContent('Show fewer events');
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
