// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { useQuery } from '@tanstack/react-query';
import { getBatchCoverage } from '../../../api/batches';
import { getConfigOptions } from '../../../api/config';
import { queryKeys } from '../../../api/queryKeys';
import { COVERAGE_POLL_MS } from '../../pollingPolicy';
import { Card, cn } from '../../../components/ui';
import { findTask, resolvePlanIds, usePlans } from '../../plans';
import { useUiStore } from '../../../store/uiStore';
import type { BatchMachine } from '../useBatchMachine';
import { SIDE_PAD } from '../compact';

/** Per-condition coverage for the CURRENT task — "what to record next" as a
 *  data decision (2026-07-14 batch-label decision, coverage in Collect).
 *  `recorded` sums the batches' monotone `episodes_recorded`, which the FIRST
 *  review save of each capture advances (§4.1) and nothing ever lowers, so the
 *  figure survives a later exclude or delete. Conditions listed = the plan's ∪
 *  those actually seen in batches, so ad-hoc conditions still show up.
 *
 *  The SUM is the server's (`GET /batches/coverage`). It used to be this card
 *  pulling every batch on the host and adding them up in the browser, which is
 *  817 KiB every 30 s at 5000 batches (E-27) — and paging that list could not
 *  have fixed it, because a total from one page would be silently short. The ∪
 *  with the plan's vocabulary stays HERE: the plan catalog is a client-side
 *  list, and the endpoint deliberately reports only what was measured.
 *
 *  There is deliberately no "exported" column any more. Under §6 a dataset is a
 *  named set of captures with no condition of its own, so the old count had no
 *  source left — and a coverage number nobody can derive is worse than no
 *  number at all. */
export function CoverageCard({ machine }: { machine: BatchMachine }) {
  const plans = usePlans();
  const task = machine.task;
  const project = machine.project ?? null;
  const ids = resolvePlanIds(plans, project, task ?? null, machine.condition ?? null);
  const operator = useUiStore((state) => state.recordOperator).trim() || null;
  const operatorHydrated = useUiStore((state) => state.operatorHydrated);
  const config = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => getConfigOptions({ signal }),
    staleTime: 15_000,
  });
  const robot = config.data?.active_robot?.trim() || null;
  // `\u2014` is the display placeholder for "no task chosen", and the endpoint
  // answers 422 without a real one. The card renders nothing in that state
  // anyway (no plan conditions, no measured rows), so it simply does not ask.
  const taskKnown = !!task && task !== '\u2014';
  const scopeReady = taskKnown && !!robot && operatorHydrated && !!operator;
  const scope = {
    project_id: ids.project_id,
    project: project && project !== '\u2014' ? project : null,
    task_id: ids.task_id,
    task: taskKnown ? task : null,
    robot,
    operator,
  };
  // The key keeps the `['batches', …]` prefix, so the invalidation the strip
  // fires after a save still reaches this card, and carries the task so
  // switching tasks is a different cache entry rather than a stale figure
  // sitting under a new heading.
  const coverageQuery = useQuery({
    queryKey: [...queryKeys.batches, 'coverage', scope],
    queryFn: ({ signal }) => getBatchCoverage(scope, signal),
    enabled: scopeReady,
    staleTime: 15_000,
    refetchInterval: COVERAGE_POLL_MS,
  });

  const planConditions = findTask(plans, machine.project ?? '', task ?? '').conditions;
  // A sum is a floor as soon as ONE of its terms is: the total is at least this
  // and possibly more, and there is no way to say which part is uncertain. So
  // the flag propagates through the addition rather than being shown per batch
  // — the operator reads the total, not the batches behind it.
  const rowsByCondition = new Map<string, { name: string; recorded: number; isFloor: boolean }>();
  const bump = (key: string, cond: string, n: number, isFloor: boolean) => {
    if (!cond || cond === '—') return;
    const cur = rowsByCondition.get(key) ?? { name: cond, recorded: 0, isFloor: false };
    rowsByCondition.set(key, {
      name: cur.name,
      recorded: cur.recorded + n,
      isFloor: cur.isFloor || isFloor,
    });
  };
  for (const c of planConditions) bump(c.condition_id, c.name, 0, false);
  for (const row of coverageQuery.data?.rows ?? []) {
    // A rolling deployment may answer the legacy row shape without
    // condition_id. Reuse the current plan's identity for the same name so a
    // server upgrade cannot briefly render duplicate condition rows.
    const matchingPlan = planConditions.find((condition) => condition.name === row.condition);
    bump(
      row.condition_id ?? matchingPlan?.condition_id ?? row.condition,
      row.condition,
      row.recorded,
      row.is_floor === true,
    );
  }
  const rows = [...rowsByCondition.entries()];
  if (rows.length === 0) return null; // free-text task with no plan conditions

  return (
    <Card
      className={cn('flex shrink-0 flex-col gap-1.5', SIDE_PAD)}
      data-testid="coverage-card"
    >
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        Coverage — {task}
      </h2>
      <div className="flex flex-col gap-1">
        {rows.map(([key, { name: cond, recorded, isFloor }]) => (
          <div
            key={key}
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
            <span className="shrink-0 text-[10.5px] text-gray-500">rec</span>
          </div>
        ))}
      </div>
      <p className="text-[10.5px] leading-snug text-gray-500">
        {scopeReady
          ? `Scope: ${project ?? 'custom project'} / ${task} · ${robot} · ${operator}`
          : 'Coverage waits for the active robot and operator scope.'}{' '}
        rec counts every take reviewed into this task&apos;s sets — it never drops when a recording is later excluded or deleted
      </p>
    </Card>
  );
}
