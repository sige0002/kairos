// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The capture list and the capture detail are different shapes, and this file
// is where that stops being a comment.
//
// `GET /api/v1/captures` stopped sending `topics` (E-27: at 100 topics a row is
// ~11.4 KiB of which ~91% is the topic array, so a 200-row page measured 2.3
// MiB against ~208 KiB without it). The TypeScript side had one `Capture` with
// `topics?: CaptureTopic[]`, so a list row and a detail were the same type and
// reading `.topics` off a list row compiled fine and produced `undefined` at
// runtime — which every consumer then quietly turned into `[]`, i.e. "this
// recording has no topics".
//
// Two assertions, because pinning only the first is the E-22 mistake: a shape
// nobody returns is not load-bearing. The second pins the CALL SITE, so this
// also fails if someone re-types `listCaptures` back to `Capture`.

import { expect, test, vi } from 'vitest';
import { listAllCaptures, listCaptures } from './captures';
import { setApiBase } from './client';
import type { Capture, CaptureListItem } from './types';

const ROW: CaptureListItem = {
  capture_id: 'cap_1',
  state: 'completed',
  review_status: 'pending',
  review_revision: 0,
};

test('a list row has no topics to read — the compiler says so, not a runtime undefined', () => {
  // @ts-expect-error `topics` is not on the list shape. If this line ever
  // compiles, the split has been undone and `.topics` is silently `undefined`
  // on every row the list serves.
  const leaked = ROW.topics;
  expect(leaked).toBeUndefined();

  // The detail shape does carry them, and requires them: the server always
  // sends the field on a single-capture response.
  const detail: Capture = {
    ...ROW,
    topics: [{ name: '/a', type: 'std_msgs/msg/String' }],
  };
  expect(detail.topics).toHaveLength(1);
});

test('listCaptures() is typed as the LIST shape, so its rows carry no topics either', async () => {
  setApiBase('/api/v1');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ items: [ROW], next_cursor: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  const page = await listCaptures();
  const first = page.items[0]!;
  // Positive control: the call really did return a row to reach into.
  expect(first.capture_id).toBe('cap_1');
  // @ts-expect-error the list endpoint's rows are CaptureListItem.
  expect(first.topics).toBeUndefined();

  vi.restoreAllMocks();
});

// E-27's 26 sequential round trips. Dropping `topics` from the list cut the
// bytes but barely moved the wall clock (measured: settle 4,438 -> 4,288 ms),
// because the cost was the REQUEST COUNT, not the payload — `listAllCaptures`
// walks the whole store a page at a time. The server raised the ceiling from
// 200 to 1,000 for exactly this, which turns 5,000 captures from 26 round trips
// into 5. The default stays 50: a page an operator waits for must not become a
// 5,000-row response, so only a client that intends to walk the store says so.
test('the whole-store walk asks for the largest page the server allows', async () => {
  setApiBase('/api/v1');
  const limits: (string | null)[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    limits.push(new URL(String(input), 'http://x').searchParams.get('limit'));
    return Promise.resolve(
      new Response(JSON.stringify({ items: [], next_cursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  await listAllCaptures();

  // Positive control: a request was made and carried an explicit limit at all.
  expect(limits).toHaveLength(1);
  // 1000 is the server's ceiling (routers/captures.py MAX_LIMIT); 1001 is a 422,
  // so this is the largest legal ask and the page count is as low as it goes.
  expect(limits[0]).toBe('1000');

  vi.restoreAllMocks();
});

// The cap on cursor-following exists so a pathological catalog cannot spin
// forever, and a run into it returns what it has WITH the unfinished cursor —
// which is what every "showing part of the catalog" disclosure downstream reads.
// Raising the page size must not quietly turn that disclosure off.
test('a truncated walk still reports its unfinished cursor', async () => {
  setApiBase('/api/v1');
  let served = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    served += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({ items: [{ ...ROW, capture_id: `c${served}` }], next_cursor: `cur${served}` }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  });

  const page = await listAllCaptures();

  // It stopped at the page cap rather than following forever …
  expect(served).toBeGreaterThan(1);
  // … and said so, which is the whole basis of `catalogTruncated`.
  expect(page.next_cursor).not.toBeNull();
  expect(page.items).toHaveLength(served);

  vi.restoreAllMocks();
});
