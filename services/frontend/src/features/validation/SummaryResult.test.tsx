// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Artifact rendering in the generic result view — the zero-UI-edit channel:
// an image artifact renders inline, another file becomes a /files link, and an
// absolute (non-normalisable) path stays plain text.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { setApiBase } from '../../api/client';
import { SummaryResult, artifactHref } from './SummaryResult';

beforeEach(() => setApiBase('/api/v1'));
afterEach(cleanup);

test('artifactHref maps data-relative paths onto /files and rejects absolute ones', () => {
  expect(artifactHref('report/x/plot.png')).toBe('/api/v1/files/report/x/plot.png');
  // Path segments are URI-encoded individually (slashes preserved).
  expect(artifactHref('report/a b/p#1.png')).toBe('/api/v1/files/report/a%20b/p%231.png');
  expect(artifactHref('/etc/passwd')).toBeNull();
});

test('renders image artifacts inline, other files as links, absolute as text', () => {
  render(
    <SummaryResult
      pipeline="hello_kairos"
      summary={{ pipeline: 'hello_kairos', result: 'pass' }}
      artifacts={['report/x/plot.png', 'report/x/summary.json', '/outside/data.bin']}
    />,
  );

  const img = screen.getByRole('img', { name: 'report/x/plot.png' });
  expect(img).toHaveAttribute('src', '/api/v1/files/report/x/plot.png');

  const link = screen.getByRole('link', { name: 'report/x/summary.json' });
  expect(link).toHaveAttribute('href', '/api/v1/files/report/x/summary.json');

  // Absolute path: listed, but never a fabricated link.
  expect(screen.getByText('/outside/data.bin').closest('a')).toBeNull();
});
