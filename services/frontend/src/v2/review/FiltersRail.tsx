// Filters column — static display rows straight from the design mock
// (reviewFilters). These aren't wired to real filtering (there's no
// batch/operator/date-range model to filter by yet); only the table's search
// box is a real filter, and "Clear filters" resets that.

import { Card, SectionLabel } from '../../components/ui';

const REVIEW_FILTERS = [
  { label: 'Batch', value: 'All batches' },
  { label: 'Data quality', value: 'All' },
  { label: 'Task result', value: 'All' },
  { label: 'Operator', value: 'All' },
  { label: 'Date range', value: 'Last 30 days' },
];

export function FiltersRail({ onClearFilters }: { onClearFilters: () => void }) {
  return (
    <Card className="flex flex-col gap-3.5 overflow-auto p-3.5">
      <SectionLabel>Filters</SectionLabel>
      {REVIEW_FILTERS.map((f) => (
        <div key={f.label} className="flex flex-col gap-1.5">
          <span className="text-[11.5px] font-semibold text-gray-400">{f.label}</span>
          <div className="flex items-center rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] text-gray-700">
            {f.value}
            <div className="flex-1" />
            <span className="text-[10px] text-gray-400">▾</span>
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
