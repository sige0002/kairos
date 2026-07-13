// Formatting + grouping helpers for the Datasets tab's real API data
// (GET /api/v1/datasets, GET /api/v1/datasets/{operator}/{task}/{index}).
//
// 2026-07-13 user directive: the earlier fabricated PickPlace_* catalog
// (episode counts, operator-mix bars, condition-coverage chart, recipe rows)
// has been removed entirely — every number rendered by this screen now comes
// from the backend. Anything with no real source yet (condition coverage,
// episodes-by-operator, recipe/version metadata) is called out with an
// honest "not available yet" note instead of a fake chart.

import type { DatasetEntry } from '../../api/types';

export function formatBytes(n?: number | null): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kB`;
  return `${n} B`;
}

export function formatCount(n?: number | null): string {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString();
}

export function formatWhen(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export interface OperatorGroup {
  operator: string;
  entries: DatasetEntry[];
}

/** Group the flat `GET /datasets` list by operator (study: legacy
 * src/features/dataset/DatasetTab.tsx groups operator -> task -> [NNN]; here
 * task/index are shown inline per card instead of a third nesting level, to
 * fit the narrow 270px list column). */
export function groupByOperator(datasets: DatasetEntry[]): OperatorGroup[] {
  const byOperator = new Map<string, DatasetEntry[]>();
  for (const d of datasets) {
    const list = byOperator.get(d.operator) ?? [];
    list.push(d);
    byOperator.set(d.operator, list);
  }
  return [...byOperator.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([operator, entries]) => ({
      operator,
      entries: [...entries].sort(
        (x, y) => x.task.localeCompare(y.task) || x.index.localeCompare(y.index),
      ),
    }));
}

export function sameDataset(a: DatasetEntry | null, b: DatasetEntry): boolean {
  return a !== null && a.dataset_dir === b.dataset_dir;
}
