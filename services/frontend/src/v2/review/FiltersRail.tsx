// Filters column. Only two controls really filter the list: the table's search
// box and the Operator select here (Operator is the one dimension the /runs API
// actually carries). The rest — Batch, Data quality, Task result, Date range —
// have no backend model to filter by yet, so they render as clearly inert,
// display-only rows (no dropdown affordance) rather than pretending to work.

import { Card, SectionLabel } from '../../components/ui';
import { ALL_OPERATORS } from './useReviewState';

// Static rows with no real backing — shown so the filter rail matches the mock,
// but visibly non-interactive (see the muted styling below).
const DISPLAY_ONLY_FILTERS = [
  { label: 'Batch', value: 'All batches' },
  { label: 'Data quality', value: 'All' },
  { label: 'Task result', value: 'All' },
  { label: 'Date range', value: 'All time' },
];

export function FiltersRail({
  operatorOptions,
  operatorFilter,
  onOperatorChange,
  onClearFilters,
}: {
  operatorOptions: string[];
  operatorFilter: string;
  onOperatorChange: (v: string) => void;
  onClearFilters: () => void;
}) {
  return (
    <Card className="flex flex-col gap-3.5 overflow-auto p-3.5">
      <SectionLabel>Filters</SectionLabel>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11.5px] font-semibold text-gray-400">Operator</span>
        <select
          data-testid="review-operator-filter"
          value={operatorFilter}
          onChange={(e) => onOperatorChange(e.target.value)}
          className="rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] text-gray-700"
        >
          <option value={ALL_OPERATORS}>All operators</option>
          {operatorOptions.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
      </div>

      {DISPLAY_ONLY_FILTERS.map((f) => (
        <div key={f.label} className="flex flex-col gap-1.5">
          <span className="text-[11.5px] font-semibold text-gray-400">{f.label}</span>
          <div
            title="Not filterable yet"
            className="flex items-center rounded-control border border-dashed border-gray-200 bg-gray-50 px-2.5 py-1.5 text-[13px] text-gray-400"
          >
            {f.value}
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={onClearFilters}
        className="rounded-control border border-gray-200 bg-white px-2 py-1.5 text-[12.5px] font-semibold text-gray-500 transition-colors hover:bg-gray-50"
      >
        Clear filters
      </button>
    </Card>
  );
}
