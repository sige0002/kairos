// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Filters column for the server-owned Review search. Every control below maps
// to a capture-search predicate or UTC date boundary; no inert filters.
//
// COLLAPSE (desktop-only): at ≥lg the rail can collapse to a slim strip so its
// width goes to the evidence panes (1280 is tight with the full 216px column).
// It's a space affordance for the 3-column desktop grid; below lg the panes
// stack and the full filters always render (there's no width to reclaim). The
// collapsed strip keeps an active-filter dot so hiding the controls never hides
// the fact that a filter is on (self-descriptiveness).

import { forwardRef } from 'react';
import type { Quality, TaskResult } from '../../api/types';
import { Card, SectionLabel, cn } from '../../components/ui';
import { ALL_OPERATORS } from './useReviewState';

// The filters region the toggle's aria-controls points at.
const REGION_ID = 'review-filters-region';
// The operator select's own id, so the heading above it is a real <label> for
// it rather than a caption that only sighted users can see is attached.
const OPERATOR_SELECT_ID = 'review-operator-filter-select';

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
        'flex h-7 w-7 items-center justify-center rounded-control text-[15px] leading-none text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-600',
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
    qualityFilter: Quality | null;
    onQualityChange: (v: Quality | null) => void;
    resultFilter: TaskResult | null;
    onResultChange: (v: TaskResult | null) => void;
    conditionFilter: string;
    conditionOptions: string[];
    onConditionChange: (v: string) => void;
    startedFrom: string | null;
    startedTo: string | null;
    onStartedFromChange: (v: string | null) => void;
    onStartedToChange: (v: string | null) => void;
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
    qualityFilter,
    onQualityChange,
    resultFilter,
    onResultChange,
    conditionFilter,
    conditionOptions,
    onConditionChange,
    startedFrom,
    startedTo,
    onStartedFromChange,
    onStartedToChange,
    batchFilterLabel,
    onClearBatchFilter,
    onClearFilters,
    collapsed,
    onToggleCollapsed,
  },
  toggleRef,
) {
  const hasActiveFilters =
    operatorFilter !== ALL_OPERATORS ||
    batchFilterLabel !== null ||
    qualityFilter !== null ||
    resultFilter !== null ||
    Boolean(conditionFilter) ||
    startedFrom !== null ||
    startedTo !== null;

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      {/* Slim collapsed strip — desktop only, only when collapsed. */}
      {collapsed && (
        <div
          data-testid="review-filters-collapsed"
          className="hidden min-h-0 flex-1 flex-col items-center gap-1 rounded-card border border-gray-200 bg-white py-2 shadow-card lg:flex"
        >
          <CollapseToggle ref={toggleRef} collapsed onToggle={onToggleCollapsed} />
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
          <label
            htmlFor={OPERATOR_SELECT_ID}
            className="text-[11.5px] font-semibold text-gray-500"
          >
            Operator
          </label>
          <select
            id={OPERATOR_SELECT_ID}
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
          <span className="text-[11.5px] font-semibold text-gray-500">Batch</span>
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
              className="flex items-center rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] text-gray-500"
            >
              All batches — click a batch chip
            </div>
          )}
        </div>

        <label className="flex flex-col gap-1.5 text-[11.5px] font-semibold text-gray-500">
          Data quality
          <select
            data-testid="review-quality-filter"
            value={qualityFilter ?? ''}
            onChange={(event) =>
              onQualityChange((event.target.value || null) as Quality | null)
            }
            className="rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] font-normal text-gray-700"
          >
            <option value="">All qualities</option>
            <option value="good">Good</option>
            <option value="needs_review">Needs review</option>
            <option value="not_usable">Not usable</option>
          </select>
        </label>

        <label className="flex flex-col gap-1.5 text-[11.5px] font-semibold text-gray-500">
          Task result
          <select
            data-testid="review-result-filter"
            value={resultFilter ?? ''}
            onChange={(event) =>
              onResultChange((event.target.value || null) as TaskResult | null)
            }
            className="rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] font-normal text-gray-700"
          >
            <option value="">All results</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
          </select>
        </label>

        <label className="flex flex-col gap-1.5 text-[11.5px] font-semibold text-gray-500">
          Condition
          <select
            data-testid="review-condition-filter"
            value={conditionFilter}
            onChange={(event) => onConditionChange(event.target.value)}
            className="rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] font-normal text-gray-700"
          >
            <option value="">All conditions</option>
            {conditionOptions.map((condition) => (
              <option key={condition} value={condition}>
                {condition}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11.5px] font-semibold text-gray-500">
            UTC date range
          </span>
          <input
            type="date"
            aria-label="From UTC date"
            data-testid="review-started-from-filter"
            value={startedFrom?.slice(0, 10) ?? ''}
            onChange={(event) => onStartedFromChange(event.target.value || null)}
            className="rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] text-gray-700"
          />
          <input
            type="date"
            aria-label="To UTC date"
            data-testid="review-started-to-filter"
            value={
              startedTo
                ? new Date(Date.parse(startedTo) - 1).toISOString().slice(0, 10)
                : ''
            }
            onChange={(event) => onStartedToChange(event.target.value || null)}
            className="rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] text-gray-700"
          />
        </div>

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
