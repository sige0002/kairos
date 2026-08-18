// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Explicit candidate predicates for the Build rail. A comma grammar would be
// compact but undiscoverable and ambiguous; removable chips keep every active
// predicate and the AND/OR rule visible before a bulk write uses them.

import { useState, type FormEvent } from 'react';
import { cn } from '../../components/ui';
import type {
  CandidateFilterField,
  CandidateFilterOperator,
  DatasetsState,
} from './useDatasetsState';

const FIELD_LABELS: Record<CandidateFilterField, string> = {
  any: 'Any field',
  operator: 'Operator',
  task: 'Task',
  condition: 'Condition',
  run_id: 'Run ID',
  capture_id: 'Capture ID',
  task_result: 'Task result',
};

const OPERATOR_LABELS: Record<CandidateFilterOperator, string> = {
  contains: 'contains',
  equals: 'equals',
};

export function CandidateFilterBuilder({ state }: { state: DatasetsState }) {
  const [field, setField] = useState<CandidateFilterField>('any');
  const [operator, setOperator] = useState<CandidateFilterOperator>('contains');
  const [value, setValue] = useState('');
  // "Any field" includes the batch-owned Condition value, so it must obey
  // the same readiness gate as an explicit Condition predicate. Otherwise a
  // transient batch-list failure would silently make the broad search narrow.
  const needsConditionMetadata = field === 'any' || field === 'condition';
  const conditionUnavailable =
    needsConditionMetadata && state.conditionFilterStatus !== 'ready';
  const canAdd = value.trim() !== '' && !conditionUnavailable;

  const changeField = (next: CandidateFilterField) => {
    setField(next);
    if (next === 'task_result') {
      setOperator('equals');
      setValue('success');
    } else if (field === 'task_result') {
      setOperator('contains');
      setValue('');
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canAdd) return;
    state.addCandidateCondition(field, operator, value);
    if (field !== 'task_result') setValue('');
  };

  return (
    <div data-testid="dataset-candidate-filter-builder" className="flex flex-col gap-2">
      <form onSubmit={submit} className="flex flex-col gap-1.5">
        <div className="grid grid-cols-[minmax(0,1fr)_92px] gap-1.5">
          <select
            aria-label="Filter field"
            data-testid="dataset-candidate-filter-field"
            value={field}
            onChange={(event) =>
              changeField(event.target.value as CandidateFilterField)
            }
            className="min-w-0 rounded-control border border-gray-200 bg-white px-2 py-1.5 text-[12px] text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
          >
            {Object.entries(FIELD_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter comparison"
            data-testid="dataset-candidate-filter-operator"
            value={field === 'task_result' ? 'equals' : operator}
            disabled={field === 'task_result'}
            onChange={(event) =>
              setOperator(event.target.value as CandidateFilterOperator)
            }
            className="rounded-control border border-gray-200 bg-white px-2 py-1.5 text-[12px] text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 disabled:bg-gray-50"
          >
            <option value="contains">contains</option>
            <option value="equals">equals</option>
          </select>
        </div>
        <div className="flex gap-1.5">
          {field === 'task_result' ? (
            <select
              aria-label="Search recordings to add"
              data-testid="dataset-candidate-search"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="min-w-0 flex-1 rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
            >
              <option value="success">Success</option>
              <option value="failure">Failure</option>
            </select>
          ) : (
            <input
              type="search"
              aria-label="Search recordings to add"
              aria-describedby="dataset-candidate-filter-hint"
              data-testid="dataset-candidate-search"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={field === 'condition' ? 'Condition value…' : 'Filter value…'}
              className="min-w-0 flex-1 rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] text-gray-700 placeholder:text-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
            />
          )}
          <button
            type="submit"
            data-testid="dataset-candidate-filter-add"
            disabled={!canAdd}
            className="shrink-0 cursor-pointer rounded-control border border-teal-200 bg-teal-50 px-2.5 py-1.5 text-[11px] font-bold text-teal-800 transition-colors hover:bg-teal-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            + Filter
          </button>
        </div>
        <span
          id="dataset-candidate-filter-hint"
          className="text-[10.5px] text-gray-500"
        >
          {conditionUnavailable
            ? state.conditionFilterStatus === 'loading'
              ? 'Loading batch conditions…'
              : 'Batch conditions could not be loaded. Retry by reloading this screen.'
            : 'Press Enter or Add filter. Commas are treated as text.'}
        </span>
      </form>

      {state.candidateConditions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.04em] text-gray-500">
              Match
            </span>
            <div
              role="group"
              aria-label="Combine recording filters"
              className="inline-flex rounded-control border border-gray-200 bg-gray-50 p-0.5"
            >
              {(['and', 'or'] as const).map((join) => (
                <button
                  key={join}
                  type="button"
                  aria-pressed={state.candidateJoin === join}
                  onClick={() => state.setCandidateJoin(join)}
                  className={cn(
                    'cursor-pointer rounded-[5px] px-2 py-0.5 text-[10.5px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600',
                    state.candidateJoin === join
                      ? 'bg-white text-teal-800 shadow-sm'
                      : 'text-gray-500 hover:text-gray-800',
                  )}
                >
                  {join.toUpperCase()}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={state.clearCandidateConditions}
              className="ml-auto cursor-pointer text-[10.5px] font-semibold text-gray-500 underline-offset-2 hover:text-gray-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
            >
              Clear
            </button>
          </div>
          <div
            data-testid="dataset-candidate-filter-chips"
            className="flex flex-wrap gap-1"
          >
            {state.candidateConditions.map((condition) => (
              <span
                key={condition.id}
                className="inline-flex max-w-full items-center gap-1 rounded-chip border border-teal-200 bg-teal-50 py-0.5 pl-2 pr-1 text-[10.5px] text-teal-900"
              >
                <span className="truncate">
                  <span className="font-semibold">{FIELD_LABELS[condition.field]}</span>{' '}
                  {OPERATOR_LABELS[condition.operator]} “{condition.value}”
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${FIELD_LABELS[condition.field]} filter ${condition.value}`}
                  onClick={() => state.removeCandidateCondition(condition.id)}
                  className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-sm leading-none text-teal-700 hover:bg-teal-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
