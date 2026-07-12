// Bottom-right episode strip: N / 30 counter + a horizontally scrollable row
// of 30 chips (done / review / fail / current / future) + running totals.

import { Card, cn } from '../../components/ui';
import { EPISODES_PER_BATCH, type BatchMachine, type EpisodeRecord } from './useBatchMachine';

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
    e.taskResult === 'fail' ? `Task: Failed${e.failReason ? ` (${e.failReason})` : ''}` : 'Task: Success';
  const quality = e.quality === 'review' ? 'Quality: Needs review' : 'Quality: Good';
  return `Episode ${n} — ${task} · ${quality}`;
}

export function EpisodeStrip({ machine }: { machine: BatchMachine }) {
  const { episodes, stats, phase } = machine;
  const recording = phase === 'recording';
  const showNext = phase !== 'ended' && phase !== 'completed';

  const nodes = Array.from({ length: EPISODES_PER_BATCH }, (_, i) => {
    const n = i + 1;
    const recorded = episodes[i];
    if (recorded) {
      const styles: Record<Bucket, string> = {
        good: 'bg-green-100 text-green-700',
        review: 'bg-amber-100 text-amber-700',
        taskFailed: 'bg-red-50 text-red-600',
      };
      const glyphs: Record<Bucket, string> = { good: '✓', review: '!', taskFailed: '✕' };
      const bucket = bucketOf(recorded);
      return (
        <span
          key={n}
          title={tooltipOf(recorded, n)}
          className={cn(
            'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-xs font-bold',
            styles[bucket],
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
            recording ? 'border-red-600 bg-red-50 text-red-600' : 'border-teal-600 bg-white text-teal-700',
          )}
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
    <Card className="flex shrink-0 items-center gap-2.5 px-4 py-2.5">
      <span data-testid="episode-strip-count" className="font-mono text-[13px] font-semibold text-gray-900">
        {stats.nRecorded} / {EPISODES_PER_BATCH}
      </span>
      <div className="min-w-0 flex-1 overflow-x-auto">
        <div className="flex w-max gap-1.5 p-0.5">{nodes}</div>
      </div>
      <span className="shrink-0 text-[11px] text-gray-400">
        ✓ {stats.nGood} · ! {stats.nReview} · ✕ {stats.nTaskFailed}
      </span>
    </Card>
  );
}
