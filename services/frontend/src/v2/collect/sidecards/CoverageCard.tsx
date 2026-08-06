import { useQuery } from '@tanstack/react-query';
import { listBatches } from '../../../api/batches';
import { queryKeys } from '../../../api/queryKeys';
import { Card, cn } from '../../../components/ui';
import { findTask, usePlans } from '../../plans';
import type { BatchMachine } from '../useBatchMachine';
import { SIDE_PAD } from '../compact';

/** Per-condition coverage for the CURRENT task — "what to record next" as a
 *  data decision (2026-07-14 batch-label decision, coverage in Collect).
 *  `recorded` sums the batches' monotone `episodes_recorded`, which the FIRST
 *  review save of each capture advances (§4.1) and nothing ever lowers, so the
 *  figure survives a later exclude or delete. Conditions listed = the plan's ∪
 *  those actually seen in batches, so ad-hoc conditions still show up.
 *
 *  There is deliberately no "exported" column any more. Under §6 a dataset is a
 *  named set of captures with no condition of its own, so the old count had no
 *  source left — and a coverage number nobody can derive is worse than no
 *  number at all. */
export function CoverageCard({ machine }: { machine: BatchMachine }) {
  const plans = usePlans();
  const batchesQuery = useQuery({
    queryKey: [...queryKeys.batches, 'coverage'],
    queryFn: ({ signal }) => listBatches({}, signal),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const task = machine.task;
  const planConditions = findTask(plans, machine.project ?? '', task ?? '').conditions;
  const batches = (batchesQuery.data?.items ?? []).filter((b) => b.task === task);
  // A sum is a floor as soon as ONE of its terms is: the total is at least this
  // and possibly more, and there is no way to say which part is uncertain. So
  // the flag propagates through the addition rather than being shown per batch
  // — the operator reads the total, not the batches behind it.
  const rowsByCondition = new Map<string, { recorded: number; isFloor: boolean }>();
  const bump = (cond: string, n: number, isFloor: boolean) => {
    if (!cond || cond === '—') return;
    const cur = rowsByCondition.get(cond) ?? { recorded: 0, isFloor: false };
    rowsByCondition.set(cond, {
      recorded: cur.recorded + n,
      isFloor: cur.isFloor || isFloor,
    });
  };
  for (const c of planConditions) bump(c, 0, false);
  for (const b of batches) {
    bump(b.condition ?? '', b.episodes_recorded ?? 0, b.episodes_recorded_is_floor === true);
  }
  const rows = [...rowsByCondition.entries()];
  if (rows.length === 0) return null; // free-text task with no plan conditions

  return (
    <Card
      className={cn('flex shrink-0 flex-col gap-1.5', SIDE_PAD)}
      data-testid="coverage-card"
    >
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        Coverage — {task}
      </span>
      <div className="flex flex-col gap-1">
        {rows.map(([cond, { recorded, isFloor }]) => (
          <div
            key={cond}
            data-testid={`coverage-row-${cond}`}
            className={cn(
              'flex items-baseline gap-2 rounded-[7px] px-1.5 py-0.5',
              cond === machine.condition && 'bg-teal-50',
            )}
          >
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[11.5px]',
                cond === machine.condition
                  ? 'font-semibold text-teal-800'
                  : 'text-gray-600',
              )}
              title={cond}
            >
              {cond}
            </span>
            <span
              className="shrink-0 font-mono text-[11.5px] text-gray-800"
              title={
                isFloor
                  ? 'At least this many — part of this total was rebuilt from the recordings still on disk, so takes deleted after review are not counted.'
                  : undefined
              }
            >
              {isFloor ? '\u2265 ' : ''}
              {recorded}
            </span>
            <span className="shrink-0 text-[10.5px] text-gray-400">rec</span>
          </div>
        ))}
      </div>
      <p className="text-[10.5px] leading-snug text-gray-400">
        rec counts every take reviewed into this task&apos;s sets — it never drops
        when a recording is later excluded or deleted
      </p>
    </Card>
  );
}
