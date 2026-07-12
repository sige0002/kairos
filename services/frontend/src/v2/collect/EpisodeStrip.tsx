// Bottom-right episode strip: N / 30 counter + a horizontally scrollable row
// of 30 chips (done / review / fail / current / future) + running totals.

import { Card, cn } from '../../components/ui';
import { EPISODES_PER_BATCH, type BatchMachine } from './useBatchMachine';

export function EpisodeStrip({ machine }: { machine: BatchMachine }) {
  const { episodes, stats, phase } = machine;
  const recording = phase === 'recording';
  const showNext = phase !== 'ended' && phase !== 'completed';

  const nodes = Array.from({ length: EPISODES_PER_BATCH }, (_, i) => {
    const n = i + 1;
    const recorded = episodes[i];
    if (recorded) {
      const styles: Record<string, string> = {
        good: 'bg-green-100 text-green-700',
        review: 'bg-amber-100 text-amber-700',
        fail: 'bg-red-50 text-red-600',
      };
      const glyphs: Record<string, string> = { good: '✓', review: '!', fail: '✕' };
      const titles: Record<string, string> = {
        good: 'good',
        review: 'needs review',
        fail: 'not usable',
      };
      return (
        <span
          key={n}
          title={`Episode ${n} — ${titles[recorded.result]}`}
          className={cn(
            'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-xs font-bold',
            styles[recorded.result],
          )}
        >
          {glyphs[recorded.result]}
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
        ✓ {stats.nGood} · ! {stats.nReview} · ✕ {stats.nFail}
      </span>
    </Card>
  );
}
