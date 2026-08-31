// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { QuickCheck } from '../../api/types';
import '../../i18n';
import { QuickCheckVerdict, topicForQuickCheckReason } from './QuickCheckVerdict';

test('renders nothing when the run has no quick_check (old runs)', () => {
  const { container } = render(<QuickCheckVerdict quickCheck={null} />);
  expect(container).toBeEmptyDOMElement();
  const { container: c2 } = render(<QuickCheckVerdict quickCheck={undefined} />);
  expect(c2).toBeEmptyDOMElement();
});

test('needs_review shows the verdict reasons (the "why" answer)', () => {
  const qc: QuickCheck = {
    verdict: {
      quality: 'needs_review',
      reasons: [
        '/hsrb/hand_camera avg 8.9Hz < expected 30Hz',
        '/hsrb/joint_states 3 gaps > 100ms',
      ],
    },
    layer0: { available: true },
    layer1: { available: true, summary_available: true },
  };
  render(<QuickCheckVerdict quickCheck={qc} />);
  expect(screen.getByTestId('review-quick-check')).toHaveTextContent('NEEDS REVIEW');
  const reasons = screen.getByTestId('review-quick-check-reasons');
  expect(reasons).toHaveTextContent('/hsrb/hand_camera avg 8.9Hz < expected 30Hz');
  expect(reasons).toHaveTextContent('/hsrb/joint_states 3 gaps > 100ms');
  // Layers are available → no unavailable notice.
  expect(screen.queryByTestId('review-quick-check-unavailable')).toBeNull();
});

test('good verdict with no reasons says so plainly', () => {
  const qc: QuickCheck = {
    verdict: { quality: 'good', reasons: [] },
    layer0: { available: true },
    layer1: { available: true, summary_available: true },
  };
  render(<QuickCheckVerdict quickCheck={qc} />);
  expect(screen.getByTestId('review-quick-check')).toHaveTextContent('GOOD');
  expect(screen.getByTestId('review-quick-check')).toHaveTextContent(
    'No issues found.',
  );
  expect(screen.getByTestId('review-quick-check-next-step')).toHaveTextContent(
    /No additional inspection is required/i,
  );
});

test('a reason opens its structured topic details without treating the reason copy as data', () => {
  const onInspectGaps = vi.fn();
  const qc: QuickCheck = {
    verdict: {
      quality: 'needs_review',
      reasons: ['/camera/image avg 8Hz < expected 30Hz'],
    },
    layer0: { available: true, topics: { '/camera': {}, '/camera/image': {} } },
    layer1: { available: true, summary_available: true },
  };
  render(<QuickCheckVerdict quickCheck={qc} onInspectGaps={onInspectGaps} />);

  expect(topicForQuickCheckReason(qc.verdict!.reasons[0]!, qc)).toBe('/camera/image');
  fireEvent.click(screen.getByTestId('review-quick-check-inspect-0'));
  expect(onInspectGaps).toHaveBeenCalledWith('/camera/image');
  expect(screen.getByTestId('review-quick-check-next-step')).toHaveTextContent(
    /recommended before deciding/i,
  );
});

test('states each layer honestly when it is unavailable', () => {
  const qc: QuickCheck = {
    verdict: { quality: 'needs_review', reasons: [] },
    layer0: { available: false },
    layer1: { available: true, summary_available: false },
  };
  render(<QuickCheckVerdict quickCheck={qc} />);
  const un = screen.getByTestId('review-quick-check-unavailable');
  expect(un).toHaveTextContent('Monitor data unavailable at stop.');
  expect(un).toHaveTextContent(
    'Bag summary missing — recording may have ended uncleanly.',
  );
});
