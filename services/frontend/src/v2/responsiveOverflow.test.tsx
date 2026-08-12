// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// #16 — page-level horizontal overflow at 375px and 768px.
//
// WHAT THESE CAN AND CANNOT SHOW. jsdom has no layout engine: it computes no
// widths, so nothing here can prove the page stops overflowing. What it CAN do
// is pin the structural decisions that make it stop — the toolbar rows that
// must be allowed to wrap, and the wide rows that must scroll inside their own
// container instead of taking the page with them. If someone drops one of
// these classes, the overflow returns silently; this is what makes that loud.
//
// The real measurement is a browser at 375 / 768 / 1024 / 1440, done as the
// acceptance step for this change.

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../api/client';
import { jsonResponse, renderWithClient } from '../test/renderWithClient';
import { CollectScreen } from './collect/CollectScreen';
import { MonitorScreen } from './monitor/MonitorScreen';

/** The nearest ancestor of `el` carrying `cls`, or null. */
function ancestorWith(el: Element, cls: string): Element | null {
  return el.closest(`.${cls}`);
}

beforeEach(() => {
  setApiBase('/api/v1');
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) {
      return Promise.resolve(
        jsonResponse({
          endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: '' },
          tabs: [],
          defaults: { ros_domain_id: 0, default_topics: [] },
          schemas: {},
        }),
      );
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({ run_id: null, state: 'created', live_capture_ids: [] }),
      );
    }
    if (url.includes('/captures')) {
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    }
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => vi.restoreAllMocks());

// The Collect toolbar measured 822px wide and did not wrap, which is the whole
// of the 375px and 768px overflow on that screen.
test('the Collect context bar is allowed to wrap', async () => {
  renderWithClient(<CollectScreen />);
  const chip = await screen.findByTestId('rec-topics-chip');
  const bar = ancestorWith(chip, 'flex-wrap');
  expect(bar).not.toBeNull();
  // …and it is the toolbar itself, not some inner group that happens to wrap.
  expect(bar!.className).toContain('items-center');
});

// A row of fixed-size episode chips is legitimately wider than a phone: it
// scrolls itself rather than pushing the page.
test('the episode strip scrolls inside its own container', async () => {
  renderWithClient(<CollectScreen />);
  const count = await screen.findByTestId('episode-strip-count');
  expect(ancestorWith(count, 'overflow-x-auto')).not.toBeNull();
});

// Monitor measured 502px at 375px. The outer row ALREADY wrapped before this
// change; the seven-button sub-view group nested inside it did not, and that
// group is the whole Monitor half of the fix.
//
// So this asserts on the group ITSELF, not on "some ancestor wraps". The
// obvious `closest('.flex-wrap')` is vacuous here: strip the group's class and
// closest() simply walks past it to the outer row and still finds one, leaving
// the test green while the bug is back. Mutation-checked in both directions.
test('the Monitor sub-view nav group itself is allowed to wrap', async () => {
  renderWithClient(<MonitorScreen />);
  await waitFor(() => expect(screen.getByTestId('mon-nav-Overview')).toBeInTheDocument());
  const group = screen.getByTestId('mon-nav-Overview').parentElement;
  expect(group).not.toBeNull();
  expect(group!.className).toContain('flex-wrap');
});

// The Topics table is genuinely wide — a 478px hard minimum from its fixed
// columns — and already scrolls itself. Pinned so a refactor cannot quietly
// drop the container and put the page back into horizontal scroll.
test('the Monitor topics table keeps its own scroll container', async () => {
  renderWithClient(<MonitorScreen />);
  await waitFor(() => expect(screen.getByTestId('mon-nav-Topics')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('mon-nav-Topics'));
  const empty = await screen.findByTestId('topics-table-empty');
  expect(ancestorWith(empty, 'overflow-auto')).not.toBeNull();
});

// The popover re-anchoring is the one edit in this change that can break the
// DESKTOP layout, and it has no other safety net: cn() is a plain concatenation
// (no tailwind-merge), so `top-full` vs `lg:top-[58px]` is resolved purely by
// CSS source order. If a refactor drops an lg: prefix the desktop offsets go
// with it, silently. These pin the strings on each popover that has one.
//
// Each picker is gated on its own machine flag, so each is opened in turn.
async function openedPopoverClass(trigger: HTMLElement): Promise<string> {
  fireEvent.click(trigger);
  const el = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('.absolute.z-40');
    expect(found).not.toBeNull();
    return found!;
  });
  return el.className;
}

test('the context-bar popovers keep BOTH their mobile and desktop anchors', async () => {
  renderWithClient(<CollectScreen />);
  await screen.findByTestId('rec-topics-chip');

  const project = await openedPopoverClass(
    screen.getByTitle('Change project (from plan)'),
  );
  // Hangs from the bar's real height below lg; keeps the measured offset at lg.
  expect(project).toContain('top-full');
  expect(project).toContain('lg:top-[58px]');
  // Never wider than the viewport: 22px of main padding either side, plus the
  // popover's own 14px left inset.
  expect(project).toContain('max-w-[calc(100vw-58px)]');

  fireEvent.click(screen.getByTitle('Change project (from plan)')); // close
  const task = await openedPopoverClass(screen.getByTitle('Change task (from plan)'));
  expect(task).toContain('top-full');
  expect(task).toContain('lg:top-[58px]');
  // The task picker is the one with a hard left offset to re-anchor: on a
  // 375px screen its 210px offset plus 240px width overflowed by itself.
  expect(task).toContain('left-3.5');
  expect(task).toContain('lg:left-[210px]');
});
