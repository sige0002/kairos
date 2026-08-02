// Bottom-right episode strip: N / target counter + a horizontally scrollable
// row of `targetEpisodes` chips (done / review / fail / current / future) +
// running totals. The chip count follows the set's own target (editable via
// the Set menu), not a fixed 30.

import { Card, cn } from '../../components/ui';
import type { BatchMachine, EpisodeRecord } from './useBatchMachine';

// The chip's marker is driven by task outcome first (operators think in task
// terms — "did it work?"), then by quality; the tooltip always states BOTH
// dimensions so a task-failed chip never reads as "this data is unusable".
type Bucket = 'good' | 'review' | 'taskFailed';

function bucketOf(e: EpisodeRecord): Bucket {
  if (e.taskResult === 'fail') return 'taskFailed';
  if (e.quality === 'review') return 'review';
  return 'good';
}

function tooltipOf(e: EpisodeRecord, n: number): string {
  const task =
    e.taskResult === 'fail'
      ? `Task: Failed${e.failReason ? ` (${e.failReason})` : ''}`
      : 'Task: Success';
  const quality = e.quality === 'review' ? 'Quality: Needs review' : 'Quality: Good';
  return `Episode ${n} — ${task} · ${quality}`;
}

export function EpisodeStrip({ machine }: { machine: BatchMachine }) {
  const { episodes, stats, phase, targetEpisodes } = machine;
  const recording = phase === 'recording';
  const showNext = phase !== 'ended' && phase !== 'completed';

  // Chips live on their episode's TRUE number (index_in_batch), not the array
  // position — after a Review export/delete removes an earlier episode, the
  // later chips must not slide left (that made the newest episode read as
  // "not recorded" one slot ahead of its actual chip).
  // Slots are numbered from 1, so an episode carrying index 0 (or lower) has no
  // slot to live in. It must NOT simply vanish: dropping it silently would let
  // the dashed "recorded earlier; no longer listed" chip describe a capture
  // that is right there in the batch. Hold those aside and count them instead.
  const byIndex = new Map<number, EpisodeRecord>();
  const unplaced: EpisodeRecord[] = [];
  for (const e of episodes) {
    if (e.index >= 1) byIndex.set(e.index, e);
    else unplaced.push(e);
  }
  // A take the recorder never named has no capture to write a review to, so it
  // exists on this screen and nowhere else — it will not survive a reload. The
  // save toast says so once; this keeps the count honest for the rest of the
  // session rather than letting it quietly outrun the server's.
  const unsynced = episodes.filter((e) => !e.captureId).length;

  const nodes = Array.from({ length: targetEpisodes }, (_, i) => {
    const n = i + 1;
    const recorded = byIndex.get(n);
    if (recorded) {
      const styles: Record<Bucket, string> = {
        good: 'bg-green-100 text-green-700',
        review: 'bg-amber-100 text-amber-700',
        taskFailed: 'bg-red-50 text-red-600',
      };
      const glyphs: Record<Bucket, string> = {
        good: '✓',
        review: '!',
        taskFailed: '✕',
      };
      const bucket = bucketOf(recorded);
      // A just-saved episode flashes a teal ring (save receipt on the strip, D-3).
      const justSaved = machine.lastSavedIndex === recorded.index;
      return (
        <span
          key={n}
          title={tooltipOf(recorded, n)}
          className={cn(
            'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-xs font-bold',
            styles[bucket],
            justSaved && 'ring-2 ring-teal-500 ring-offset-1',
          )}
        >
          {glyphs[bucket]}
        </span>
      );
    }
    if (showNext && n === stats.epNext) {
      return (
        <span
          key={n}
          title={`Episode ${n} — ${recording ? 'recording' : 'next'}`}
          className={cn(
            'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border-2 font-mono text-[11px]',
            recording
              ? 'border-red-600 bg-red-50 text-red-600'
              : 'border-teal-600 bg-white text-teal-700',
          )}
        >
          {n}
        </span>
      );
    }
    if (n <= stats.nRecorded) {
      // This number WAS recorded but its episode is no longer listed (exported
      // or deleted in Review) — honestly distinct from a future empty slot.
      return (
        <span
          key={n}
          title={`Episode ${n} — recorded earlier; no longer listed (exported or deleted in Review)`}
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border border-dashed border-gray-300 bg-white font-mono text-[10.5px] text-gray-400"
        >
          {n}
        </span>
      );
    }
    return (
      <span
        key={n}
        title={`Episode ${n} — not recorded`}
        className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-gray-100 font-mono text-[10.5px] text-gray-300"
      >
        {n}
      </span>
    );
  });

  return (
    <Card className="flex shrink-0 items-center gap-2.5 px-4 py-2.5 [@media(max-height:860px)]:py-1.5">
      <span
        data-testid="episode-strip-count"
        className="font-mono text-[13px] font-semibold text-gray-900"
      >
        {stats.nRecorded} / {targetEpisodes}
      </span>
      <div className="min-w-0 flex-1 overflow-x-auto">
        <div className="flex w-max gap-1.5 p-0.5">{nodes}</div>
      </div>
      {unsynced > 0 && (
        <span
          data-testid="episode-strip-unsynced"
          title={
            'These takes were labeled on screen only — the recorder never named ' +
            'a capture for them, so there is nothing on the server to review, ' +
            'and they will not survive a reload.'
          }
          className="shrink-0 rounded-chip bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700"
        >
          {unsynced} not saved
        </span>
      )}
      {unplaced.length > 0 && (
        <span
          data-testid="episode-strip-unplaced"
          title={
            'These captures carry no position within the batch, so they cannot ' +
            'be shown on the strip. They exist and are listed in Review.'
          }
          className="shrink-0 rounded-chip bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700"
        >
          +{unplaced.length} unplaced
        </span>
      )}
      <span className="shrink-0 text-[11px] text-gray-400">
        ✓ {stats.nGood} · ! {stats.nReview} · ✕ {stats.nTaskFailed}
      </span>
    </Card>
  );
}
