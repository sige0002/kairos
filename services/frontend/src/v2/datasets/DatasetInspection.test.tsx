// The dataset member's loss table gets the same dating as Review's (#9): a
// failed attempt's note calls it "the last completed loss report", and a table
// the operator cannot date is one they cannot tell apart from the run they just
// tried to start.

import { screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { DatasetInspection } from './DatasetInspection';
import type { CaptureDetail } from '../../api/types';

function detail(loss: CaptureDetail['loss']): CaptureDetail {
  return {
    capture_id: 'cap-1',
    run_id: 'run_20260812_090000',
    state: 'completed',
    review_status: 'pending',
    review_revision: 1,
    replica: { instance_id: 'inst', state: 'present_verified' },
    digest_state: 'complete',
    // No camera topics: the video section then has nothing to submit, so this
    // test exercises the loss header alone.
    topics: [],
    loss,
  };
}

beforeEach(() => {
  setApiBase('/api/v1');
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(jsonResponse({})),
  );
});
afterEach(() => vi.restoreAllMocks());

test('a stored loss table is dated from its own checked_at', () => {
  renderWithClient(
    <DatasetInspection
      detail={detail({
        topics: [{ name: '/head_camera/image_raw', count: 900, hz: 30 }],
        checked_at: '2026-08-12T09:15:00Z',
      })}
    />,
  );

  expect(screen.getByTestId('dataset-loss-checked')).toHaveTextContent(
    `checked ${new Date('2026-08-12T09:15:00Z').toLocaleString('en-GB', { hour12: false })}`,
  );
});

test('a loss report with no time of its own is labelled, not given one', () => {
  renderWithClient(
    <DatasetInspection
      detail={detail({ topics: [{ name: '/head_camera/image_raw', count: 900 }] })}
    />,
  );

  const checked = screen.getByTestId('dataset-loss-checked');
  expect(checked).toHaveTextContent('last completed report');
  expect(checked.textContent).not.toMatch(/\d{4}/);
});

test('a capture with no loss report claims no date at all', () => {
  renderWithClient(<DatasetInspection detail={detail(null)} />);
  expect(screen.queryByTestId('dataset-loss-checked')).toBeNull();
});
