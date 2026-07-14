// The strip must place every chip on its TRUE episode number (index_in_batch),
// not its array position — a Review export/delete of an earlier episode used to
// slide the later chips left, making the newest episode read as "not recorded"
// one slot ahead of its actual chip (the reported off-by-one bug).

import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { EpisodeStrip } from './EpisodeStrip';
import type { BatchMachine, EpisodeRecord } from './useBatchMachine';

function machineWith(episodes: EpisodeRecord[], nRecorded: number): BatchMachine {
  return {
    episodes,
    phase: 'ready',
    lastSavedIndex: null,
    targetEpisodes: 30,
    stats: {
      nRecorded,
      nGood: episodes.filter((e) => e.quality === 'good').length,
      nReview: episodes.filter((e) => e.quality === 'review').length,
      nTaskFailed: episodes.filter((e) => e.taskResult === 'fail').length,
      nRemaining: Math.max(0, 30 - nRecorded),
      epNext: Math.min(nRecorded + 1, 30),
    },
  } as unknown as BatchMachine;
}

test('chips sit on their true episode number across a deletion gap', () => {
  // Episode 2 was exported/deleted in Review; 1 and 3 survive, count stays 3.
  render(
    <EpisodeStrip
      machine={machineWith(
        [
          { index: 1, quality: 'good', taskResult: 'ok', runId: 'r1' },
          { index: 3, quality: 'good', taskResult: 'ok', runId: 'r3' },
        ],
        3,
      )}
    />,
  );
  // The surviving episode 3 renders AT slot 3 (it must not slide into slot 2).
  expect(screen.getByTitle('Episode 3 — Task: Success · Quality: Good')).toBeTruthy();
  // The gap is honestly labeled as removed — distinct from a future empty slot.
  expect(
    screen.getByTitle(
      'Episode 2 — recorded earlier; no longer listed (exported or deleted in Review)',
    ),
  ).toBeTruthy();
  // The next-up ring follows the monotone count (4), and slot 5 is a plain
  // future slot.
  expect(screen.getByTitle('Episode 4 — next')).toBeTruthy();
  expect(screen.getByTitle('Episode 5 — not recorded')).toBeTruthy();
  expect(screen.getByTestId('episode-strip-count').textContent).toContain('3 / 30');
});

test('a server-reallocated index renders at the server slot', () => {
  // The server moved this save to slot 4 (another terminal took 1-3).
  render(
    <EpisodeStrip
      machine={machineWith(
        [{ index: 4, quality: 'review', taskResult: 'ok', runId: 'r9' }],
        4,
      )}
    />,
  );
  expect(
    screen.getByTitle('Episode 4 — Task: Success · Quality: Needs review'),
  ).toBeTruthy();
  expect(screen.getByTitle('Episode 5 — next')).toBeTruthy();
});
