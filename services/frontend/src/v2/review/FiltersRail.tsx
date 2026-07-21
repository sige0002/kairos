// Filters column. Only two controls really filter the list: the table's search
// box and the Operator select here (Operator is the one dimension the /runs API
// actually carries). The rest — Batch, Data quality, Task result, Date range —
// have no backend model to filter by yet, so they render as clearly inert,
// display-only rows (no dropdown affordance) rather than pretending to work.
//
// COLLAPSE (desktop-only): at ≥lg the rail can collapse to a slim strip so its
// width goes to the evidence panes (1280 is tight with the full 216px column).
// It's a space affordance for the 3-column desktop grid; below lg the panes
// stack and the full filters always render (there's no width to reclaim). The
// collapsed strip keeps an active-filter dot so hiding the controls never hides
// the fact that a filter is on (self-descriptiveness).

import { forwardRef } from 'react';
import { Card, SectionLabel, cn } from '../../components/ui';
import { ALL_OPERATORS } from './useReviewState';

// Static rows with no real backing — shown so the filter rail matches the mock,
// but visibly non-interactive (see the muted styling below).
const DISPLAY_ONLY_FILTERS = [
  { label: 'Data quality', value: 'All' },
  { label: 'Task result', value: 'All' },
  { label: 'Date range', value: 'All time' },
];

// The filters region the toggle's aria-controls points at.
const REGION_ID = 'review-filters-region';

/** Chevron toggle shared by the expanded header (« collapse) and the slim rail
 *  (» expand). Forwarded ref so the caller can restore focus after the state
 *  swap (the two buttons never mount at the same time). */
const CollapseToggle = forwardRef<
  HTMLButtonElement,
  { collapsed: boolean; onToggle: () => void; className?: string }
>(function CollapseToggle({ collapsed, onToggle, className }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      data-testid="review-filters-toggle"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-controls={REGION_ID}
      aria-label={collapsed ? 'Expand filters' : 'Collapse filters'}
      title={collapsed ? 'Expand filters' : 'Collapse filters'}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-control text-[15px] leading-none text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600',
        className,
      )}
    >
      {collapsed ? '»' : '«'}
    </button>
  );
});

export const FiltersRail = forwardRef<
  HTMLButtonElement,
  {
    operatorOptions: string[];
    operatorFilter: string;
    onOperatorChange: (v: string) => void;
    /** Active batch filter's display label, or null (set by clicking a row's
     *  batch chip in the table — the rail shows and clears it). */
    batchFilterLabel: string | null;
    onClearBatchFilter: () => void;
    onClearFilters: () => void;
    /** Desktop collapse state + toggle (persisted by the parent). */
    collapsed: boolean;
    onToggleCollapsed: () => void;
  }
>(function FiltersRail(
  {
    operatorOptions,
    operatorFilter,
    onOperatorChange,
    batchFilterLabel,
    onClearBatchFilter,
    onClearFilters,
    collapsed,
    onToggleCollapsed,
  },
  toggleRef,
) {
  const hasActiveFilters =
    operatorFilter !== ALL_OPERATORS || batchFilterLabel !== null;

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      {/* Slim collapsed strip — desktop only, only when collapsed. */}
      {collapsed && (
        <div
          data-testid="review-filters-collapsed"
          className="hidden min-h-0 flex-1 flex-col items-center gap-1 rounded-card border border-gray-200 bg-white py-2 shadow-card lg:flex"
        >
          <CollapseToggle
            ref={toggleRef}
            collapsed
            onToggle={onToggleCollapsed}
          />
          {hasActiveFilters && (
            <span
              data-testid="review-filters-active-dot"
              title="Filters are active — expand to see them"
              className="h-1.5 w-1.5 rounded-full bg-teal-600"
              aria-label="Filters active"
            />
          )}
        </div>
      )}

      {/* Full filters: always below lg (panes stack, no width to reclaim); at
          ≥lg only when expanded. */}
      <Card
        id={REGION_ID}
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto p-3.5',
          collapsed && 'lg:hidden',
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <SectionLabel>Filters</SectionLabel>
          {!collapsed && (
            <CollapseToggle
              ref={toggleRef}
              collapsed={false}
              onToggle={onToggleCollapsed}
              className="hidden lg:flex"
            />
          )}
        </div>

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

        <div className="flex flex-col gap-1.5">
          <span className="text-[11.5px] font-semibold text-gray-400">Set</span>
          {batchFilterLabel ? (
            <div
              data-testid="review-batch-filter-rail"
              className="flex items-center justify-between gap-2 rounded-control border border-teal-200 bg-teal-50 px-2.5 py-1.5 text-[13px] font-semibold text-teal-800"
            >
              <span className="font-mono">{batchFilterLabel}</span>
              <button
                type="button"
                onClick={onClearBatchFilter}
                title="Show all batches"
                className="text-teal-700 hover:text-teal-900"
              >
                ✕
              </button>
            </div>
          ) : (
            <div
              title="Click a row's batch chip in the table to filter to that batch"
              className="flex items-center rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] text-gray-400"
            >
              All batches — click a batch chip
            </div>
          )}
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
    </div>
  );
});
