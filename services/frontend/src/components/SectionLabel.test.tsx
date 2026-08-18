// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// SectionLabel is the shared card-header primitive — every `<CardHeader>` plus
// FiltersRail, ChecklistCard and SummaryResult title themselves through it, so
// it alone accounts for a large share of the console's h2 layer (#14).
//
// This exists because the outline helper cannot see a MISSING heading: it walks
// the headings that ARE rendered and checks their levels, so reverting this
// component to a plain <span> would delete four h2s and leave every screen test
// green. The tag is asserted directly here.

import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { CardHeader, SectionLabel } from './ui';

test('SectionLabel renders a level-2 heading, not a plain span', () => {
  render(<SectionLabel>Filters</SectionLabel>);
  const heading = screen.getByRole('heading', { level: 2, name: 'Filters' });
  expect(heading.tagName).toBe('H2');
});

test('a string CardHeader title is a heading too', () => {
  // CardHeader routes a string title through SectionLabel; a ReactNode title is
  // rendered as given, and those call sites carry their own heading.
  render(<CardHeader title="Store health" />);
  expect(screen.getByRole('heading', { level: 2, name: 'Store health' })).toBeInTheDocument();
});
