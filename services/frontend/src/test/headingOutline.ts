// Shared assertion for the #14 heading structure, used by each screen's own
// test file.
//
// The console had no h1 or h2 anywhere in the shell, so a screen-reader user
// could not navigate it by heading — every screen was one flat run of text
// under the tab bar. Two things have to hold on every screen, and they are
// easy to break by adding a card: the screen names itself exactly once, and
// nothing below that h1 skips a level on the way down.

import { screen } from '@testing-library/react';
import { expect } from 'vitest';

/** Every heading currently rendered, in DOM order. */
export function headingOutline(): { level: number; text: string }[] {
  return screen.getAllByRole('heading').map((h) => ({
    // aria-level wins where a non-heading tag carries the role; otherwise the
    // level is the tag's own digit.
    level: Number(h.getAttribute('aria-level') ?? h.tagName.slice(1)),
    text: (h.textContent ?? '').trim(),
  }));
}

/**
 * Assert the screen named `name` is titled exactly once and that its outline
 * descends one level at a time.
 *
 * Coming back UP may skip freely (h3 -> h1 is an ordinary end-of-section);
 * going DOWN may not, because an h2 followed by an h4 leaves a reader who
 * navigates by heading wondering which section they missed.
 */
export async function expectScreenHeadingOutline(name: string): Promise<void> {
  const h1s = await screen.findAllByRole('heading', { level: 1 });
  expect(h1s).toHaveLength(1);
  expect(h1s[0]).toHaveTextContent(name);

  const outline = headingOutline();
  expect(outline[0]?.level).toBe(1);
  outline.forEach((h, i) => {
    if (i === 0) return;
    const previous = outline[i - 1]!;
    expect(
      h.level,
      `${name}: "${previous.text}" (h${previous.level}) → "${h.text}" (h${h.level})`,
    ).toBeLessThanOrEqual(previous.level + 1);
  });
}
