// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The save banner's HEADER is a claim of its own, separate from the message
// under it. It had exactly two settings — "Not saved" for the destructive codes
// and "Save refused" for everything else — which was true while everything else
// was a refusal the server had considered and sent back.
//
// It stopped being true once a request that never reached an answer got a
// reading of its own (#9): "Save refused" over "Could not reach the server"
// asserts a decision nobody made, and tells an operator the save definitely did
// not happen when that is precisely what is unknown.

import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { ApiError } from '../../../api/client';
import { SaveErrorBanner } from './banners';

function renderBanner(error: unknown) {
  render(<SaveErrorBanner error={error} onDismiss={vi.fn()} />);
  return screen.getByTestId('save-error');
}

test('a save that never reached an answer is not called refused', () => {
  const banner = renderBanner(new TypeError('Failed to fetch'));
  expect(banner).toHaveAttribute('data-error-code', 'network_unreachable');
  expect(banner.textContent).not.toMatch(/refused/i);
  // Not "did not reach the server" either: the request may have arrived and
  // only its answer been lost, which is the whole point of the reading below.
  expect(banner).toHaveTextContent('Save not confirmed');
  expect(banner.textContent).toMatch(/could not reach the server/i);
});

test('a save whose answer never came back is not called refused either', () => {
  // The deadline case, where "did not reach the server" would be flatly wrong:
  // this request certainly was sent.
  const banner = renderBanner(new DOMException('signal timed out', 'TimeoutError'));
  expect(banner).toHaveAttribute('data-error-code', 'network_timeout');
  expect(banner).toHaveTextContent('Save not confirmed');
  expect(banner.textContent).not.toMatch(/refused/i);
});

test('a real refusal is still called one', () => {
  // The control: the header must not go vague for the codes where the server
  // did consider the save and turn it down.
  const banner = renderBanner(
    new ApiError(
      409,
      { error: { code: 'review_conflict', message: 'Edited elsewhere.', details: {} } },
      'fallback',
    ),
  );
  expect(banner).toHaveTextContent('Save refused');
});

test('a destructive failure still leads with "Not saved"', () => {
  const banner = renderBanner(
    new ApiError(
      500,
      {
        error: {
          code: 'review_sidecar_write_failed',
          message: 'Could not write record.json.',
          details: {},
        },
      },
      'fallback',
    ),
  );
  expect(banner).toHaveTextContent('Not saved');
});
