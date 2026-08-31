// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Explicit candidate predicates for the Build rail. A comma grammar would be
// compact but undiscoverable and ambiguous; removable chips keep every active
// predicate and the AND/OR rule visible before a bulk write uses them.

import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../components/ui';
import type {
  CandidateFilterField,
  CandidateFilterOperator,
  DatasetsState,
} from './useDatasetsState';

export function CandidateFilterBuilder({ state }: { state: DatasetsState }) {
  const { t } = useTranslation('datasets');
  const fieldLabels: Record<CandidateFilterField, string> = {
    any: t('anyField'),
    operator: t('operator'),
    task: t('task'),
    condition: t('condition'),
    run_id: 'Run ID',
    capture_id: 'Capture ID',
    task_result: t('taskResult'),
  };
  const operatorLabels: Record<CandidateFilterOperator, string> = {
    contains: t('contains'),
    equals: t('equals'),
  };
  const [field, setField] = useState<CandidateFilterField>('any');
  const [operator, setOperator] = useState<CandidateFilterOperator>('contains');
  const [value, setValue] = useState('');
  // A snapshot condition is usable even while the Batch list is unavailable.
  // The status below concerns only legacy captures, which are excluded from a
  // condition predicate until their current Batch label can be read.
  const needsConditionMetadata = field === 'any' || field === 'condition';
  const conditionUnavailable =
    needsConditionMetadata && state.conditionFilterStatus !== 'ready';
  const canAdd = value.trim() !== '';

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
            aria-label={t('filterField')}
            data-testid="dataset-candidate-filter-field"
            value={field}
            onChange={(event) =>
              changeField(event.target.value as CandidateFilterField)
            }
            className="min-w-0 rounded-control border border-border bg-surface px-2 py-1.5 text-[12px] text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {Object.entries(fieldLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label={t('filterComparison')}
            data-testid="dataset-candidate-filter-operator"
            value={field === 'task_result' ? 'equals' : operator}
            disabled={field === 'task_result'}
            onChange={(event) =>
              setOperator(event.target.value as CandidateFilterOperator)
            }
            className="rounded-control border border-border bg-surface px-2 py-1.5 text-[12px] text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:bg-surface-muted"
          >
            <option value="contains">{t('contains')}</option>
            <option value="equals">{t('equals')}</option>
          </select>
        </div>
        <div className="flex gap-1.5">
          {field === 'task_result' ? (
            <select
              aria-label={t('searchRecordingsToAdd')}
              data-testid="dataset-candidate-search"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="min-w-0 flex-1 rounded-control border border-border bg-surface px-2.5 py-1.5 text-[12px] text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <option value="success">{t('success')}</option>
              <option value="failure">{t('failure')}</option>
            </select>
          ) : (
            <input
              type="search"
              aria-label={t('searchRecordingsToAdd')}
              aria-describedby="dataset-candidate-filter-hint"
              data-testid="dataset-candidate-search"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={
                field === 'condition' ? t('conditionValue') : t('filterValue')
              }
              className="min-w-0 flex-1 rounded-control border border-border bg-surface px-2.5 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
          )}
          <button
            type="submit"
            data-testid="dataset-candidate-filter-add"
            disabled={!canAdd}
            className="shrink-0 cursor-pointer rounded-control border border-accent bg-interaction-selected px-2.5 py-1.5 text-[11px] font-bold text-accent transition-colors hover:bg-interaction-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40"
          >
            + {t('addFilter')}
          </button>
        </div>
        <span
          id="dataset-candidate-filter-hint"
          className="text-[10.5px] text-text-muted"
        >
          {conditionUnavailable
            ? state.conditionFilterStatus === 'loading'
              ? 'Loading legacy recording conditions… Snapshot conditions are ready.'
              : 'Some legacy recording conditions could not be loaded. Snapshot conditions remain usable.'
            : 'Press Enter or Add filter. Commas are treated as text.'}
        </span>
      </form>

      {state.candidateConditions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.04em] text-text-muted">
              {t('match')}
            </span>
            <div
              role="group"
              aria-label={t('combineFilters')}
              className="inline-flex rounded-control border border-border bg-surface-muted p-0.5"
            >
              {(['and', 'or'] as const).map((join) => (
                <button
                  key={join}
                  type="button"
                  aria-pressed={state.candidateJoin === join}
                  onClick={() => state.setCandidateJoin(join)}
                  className={cn(
                    'cursor-pointer rounded-[5px] px-2 py-0.5 text-[10.5px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                    state.candidateJoin === join
                      ? 'bg-surface text-accent shadow-sm'
                      : 'text-text-muted hover:text-text-primary',
                  )}
                >
                  {join.toUpperCase()}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={state.clearCandidateConditions}
              className="ml-auto cursor-pointer text-[10.5px] font-semibold text-text-muted underline-offset-2 hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {t('clear')}
            </button>
          </div>
          <div
            data-testid="dataset-candidate-filter-chips"
            className="flex flex-wrap gap-1"
          >
            {state.candidateConditions.map((condition) => (
              <span
                key={condition.id}
                className="inline-flex max-w-full items-center gap-1 rounded-chip border border-accent bg-interaction-selected py-0.5 pl-2 pr-1 text-[10.5px] text-accent-strong"
              >
                <span className="truncate">
                  <span className="font-semibold">{fieldLabels[condition.field]}</span>{' '}
                  {operatorLabels[condition.operator]} “{condition.value}”
                </span>
                <button
                  type="button"
                  aria-label={`${t('remove')} ${fieldLabels[condition.field]} ${t('addFilter')} ${condition.value}`}
                  onClick={() => state.removeCandidateCondition(condition.id)}
                  className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-sm leading-none text-accent hover:bg-interaction-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
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
