// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Left column: the logical datasets (§6). One row per dataset — a name, the
// operator/task it was created under, and an honest one-line aggregate over its
// members. There is no tree here any more because there is nothing to nest: a
// dataset has no condition and no directory, so the list is flat and the search
// runs over the three fields a dataset actually carries.
//
// There is no whole-catalog scope: one dataset's numbering means nothing mixed
// into another's, so the center asks for a selection instead of blending them.
// Archived sets live under their own view (the Active/Archived switch) — the
// working list is for sets still being built.
//
// "+ New" creates a real dataset. Nothing is written under objects/ and no
// recording moves, which the form says out loud — the previous model made "new
// dataset" mean "move recordings into a directory", and the two must not be
// confused while both are still in living memory.

import { useRef } from 'react';
import { Badge, cn } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import { CombineDatasetsDialog } from './CombineDatasetsDialog';
import {
  ANY_OPERATOR,
  datasetSummarySegments,
  datasetTestId,
  type DatasetRow,
  type SummarySegment,
} from './data';
import type { DatasetsState, TaskResultFilter } from './useDatasetsState';

const RESULT_FILTERS: { id: TaskResultFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'success', label: 'Success' },
  { id: 'failure', label: 'Failure' },
];

/** The honest one-line aggregate (members · ✓/✗ or "no labels" · size ·
 *  availability · operators) — every segment computed from a real field. */
function SummaryLine({ segments }: { segments: SummarySegment[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10.5px] leading-tight text-text-muted">
      {segments.map((s, i) => (
        <span key={i} title={s.title} className="whitespace-nowrap">
          {i > 0 && <span className="mr-1.5 text-text-muted">·</span>}
          <span className={cn(s.warn && 'font-semibold text-status-warning-text')}>{s.text}</span>
        </span>
      ))}
    </div>
  );
}

function DatasetListRow({ row, state }: { row: DatasetRow; state: DatasetsState }) {
  const { dataset } = row;
  const selected = state.isDatasetSelected(dataset.dataset_id);
  const subtitle = [dataset.operator, dataset.task].filter(Boolean).join(' · ');
  return (
    <div
      data-testid={datasetTestId(dataset.dataset_id)}
      data-dataset-id={dataset.dataset_id}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => state.selectDataset(dataset.dataset_id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          state.selectDataset(dataset.dataset_id);
        }
      }}
      className={cn(
        'flex cursor-pointer flex-col gap-[3px] rounded-[10px] border px-[11px] py-[9px]',
        selected ? 'border-accent bg-interaction-selected' : 'border-border hover:bg-surface-muted',
      )}
    >
      <span className="flex items-center gap-1.5 truncate text-[12.5px] font-semibold text-text-primary">
        <span className="truncate">{dataset.name}</span>
        {/* The terminal states are part of the row's identity: an archived
            dataset's bytes are elsewhere, and hiding that behind a click is
            how someone plans training around data that is not here. */}
        {dataset.status !== 'active' && (
          <span data-testid={`dataset-status-${dataset.dataset_id}`}>
            <Badge tone={dataset.status === 'archived' ? 'gray' : 'amber'}>
              {dataset.status}
            </Badge>
          </span>
        )}
      </span>
      {subtitle && (
        <span className="truncate text-[10.5px] text-text-muted">{subtitle}</span>
      )}
      <SummaryLine segments={datasetSummarySegments(row)} />
    </div>
  );
}

/** The create form. Inline rather than a modal: it is three fields, and the
 *  list it adds to stays visible beside them.
 *
 *  A NAMED FORM, not a dialog. It has no overlay, traps no focus, and leaves
 *  the page behind it live and reachable — that is the whole reason it is not
 *  the shared modal — so `role="dialog"` would be both a lie about the
 *  behaviour and, on a `<form>`, not a role the element may carry. Named, it is
 *  a form landmark: findable by landmark navigation, honest about what it is.
 *  What it does owe the keyboard is the dismissal the Cancel button offers the
 *  mouse — Escape leaves without creating, and hands the cursor back. */
function CreateForm({ state, onDismiss }: { state: DatasetsState; onDismiss: () => void }) {
  return (
    <form
      aria-label="New dataset"
      data-testid="new-dataset-form"
      onSubmit={(e) => {
        e.preventDefault();
        state.submitCreate();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        // An IME's own Escape closes its candidate window. Taking that
        // keystroke as well would throw away the text being converted AND the
        // form around it, from one press the typist meant for neither.
        if (e.nativeEvent.isComposing) return;
        // Mirrors Cancel, including its disabled state: once the POST is out
        // there is nothing left to back out of, and closing would only hide the
        // result of a write that is still going to land.
        if (state.creating) return;
        e.preventDefault();
        // The shared Modal listens for Escape on the DOCUMENT, so a dialog open
        // over this panel would otherwise be dismissed by the same press that
        // dismisses the form under it.
        e.stopPropagation();
        onDismiss();
      }}
      className="flex flex-col gap-1.5 border-b border-border bg-surface-muted px-3 py-2.5"
    >
      <input
        data-testid="new-dataset-name"
        value={state.newName}
        onChange={(e) => state.setNewName(e.target.value)}
        aria-label="Dataset name"
        placeholder="Dataset name"
        maxLength={200}
        autoFocus
        className="w-full rounded-control border border-border bg-surface px-2.5 py-1.5 text-[12.5px] text-text-primary placeholder:text-text-muted"
      />
      <div className="flex gap-1.5">
        <input
          data-testid="new-dataset-operator"
          value={state.newOperator}
          onChange={(e) => state.setNewOperator(e.target.value)}
          aria-label="Operator (optional)"
          placeholder="Operator (optional)"
          className="min-w-0 flex-1 rounded-control border border-border bg-surface px-2.5 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted"
        />
        <input
          data-testid="new-dataset-task"
          value={state.newTask}
          onChange={(e) => state.setNewTask(e.target.value)}
          aria-label="Task (optional)"
          placeholder="Task (optional)"
          className="min-w-0 flex-1 rounded-control border border-border bg-surface px-2.5 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted"
        />
      </div>
      <p className="text-[10.5px] leading-relaxed text-text-muted">
        A dataset is a named set of recordings. Creating one writes nothing under
        objects/ and moves no recording; the browsable views/ tree is regenerated
        by the server.
      </p>
      {state.createError != null && <ErrorMessage error={state.createError} />}
      <div className="flex items-center gap-1.5">
        <button
          type="submit"
          data-testid="new-dataset-submit"
          disabled={state.newName.trim() === '' || state.creating}
          className="rounded-chip bg-accent px-[11px] py-[5px] text-xs font-bold text-text-inverse hover:bg-accent-strong disabled:opacity-40"
        >
          {state.creating ? 'Creating…' : 'Create'}
        </button>
        <button
          type="button"
          data-testid="new-dataset-cancel"
          onClick={onDismiss}
          disabled={state.creating}
          className="rounded-chip border border-border px-[11px] py-[5px] text-xs font-semibold text-text-secondary hover:bg-surface disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function DatasetList({ state }: { state: DatasetsState }) {
  const hasAny = state.rows.length > 0;
  const searchActive = state.search.trim() !== '';
  const newBtnRef = useRef<HTMLButtonElement>(null);

  // Dismissing the form unmounts the field the cursor is sitting in. Left to
  // itself the cursor falls to <body> and Tab restarts at the top of the
  // document — so it goes back to the control that opened the form, which is
  // where the operator was before and is still on screen.
  const dismissCreate = () => {
    state.cancelCreate();
    newBtnRef.current?.focus();
  };

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-4 py-[13px]">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          Datasets
        </h2>
        <div className="flex-1" />
        <button
          type="button"
          data-testid="combine-datasets-btn"
          onClick={state.openCombine}
          title="Build a new dataset from existing ones. The sources are not touched."
          className="rounded-chip border border-border px-[11px] py-[5px] text-xs font-semibold text-text-secondary hover:bg-surface-muted"
        >
          ⧉ Combine
        </button>
        <button
          ref={newBtnRef}
          type="button"
          data-testid="new-dataset-btn"
          onClick={state.openCreate}
          className="rounded-chip bg-accent px-[11px] py-[5px] text-xs font-bold text-text-inverse hover:bg-accent-strong"
        >
          + New
        </button>
      </div>

      {state.createOpen && <CreateForm state={state} onDismiss={dismissCreate} />}

      {/* Toolbar: search, member facets + sort, operator, then the counter. */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2.5">
        <input
          type="search"
          data-testid="dataset-search"
          value={state.search}
          onChange={(e) => state.setSearch(e.target.value)}
          aria-label="Search datasets"
          placeholder="Search dataset, operator, task…"
          className="w-full rounded-control border border-border bg-surface px-2.5 py-1.5 text-[12.5px] text-text-primary placeholder:text-text-muted"
        />

        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1">
            {RESULT_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                data-testid={`dataset-filter-${f.id}`}
                onClick={() => state.setTaskResultFilter(f.id)}
                title="Narrows the members shown in the center pane"
                className={cn(
                  'rounded-chip px-2 py-0.5 text-[11px] font-semibold',
                  state.taskResultFilter === f.id
                    ? 'bg-accent text-text-inverse'
                    : 'bg-surface-muted text-text-secondary hover:bg-surface-muted',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <button
            type="button"
            data-testid="dataset-sort-toggle"
            onClick={state.toggleSort}
            title={
              state.sort === 'recent'
                ? 'Sorted by most recently created — switch to A–Z'
                : 'Sorted A–Z — switch to most recently created'
            }
            className="flex items-center gap-1 rounded-chip border border-border px-2 py-0.5 text-[11px] font-semibold text-text-secondary hover:bg-surface-muted"
          >
            <span aria-hidden>⇅</span>
            {state.sort === 'recent' ? 'Recent' : 'A–Z'}
          </button>
        </div>

        {state.operatorOptions.length > 0 && (
          <select
            data-testid="dataset-operator-filter"
            aria-label="Filter datasets by operator"
            value={state.operatorFilter}
            onChange={(e) => state.setOperatorFilter(e.target.value)}
            className="w-full rounded-control border border-border bg-surface px-2 py-1 text-[12px] text-text-secondary"
          >
            <option value={ANY_OPERATOR}>Any operator</option>
            {state.operatorOptions.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
        )}

        <span data-testid="dataset-count" className="text-[11px] text-text-muted">
          showing {state.shown} of {state.total}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="dataset-view-active"
            aria-pressed={state.datasetView === 'active'}
            onClick={() => state.setDatasetView('active')}
            className={cn(
              'rounded-chip px-2 py-0.5 text-[11px] font-bold',
              state.datasetView === 'active'
                ? 'bg-accent text-text-inverse'
                : 'border border-border text-text-secondary hover:bg-surface-muted',
            )}
          >
            Active ({state.activeDatasetCount})
          </button>
          <button
            type="button"
            data-testid="dataset-view-archived"
            aria-pressed={state.datasetView === 'archived'}
            onClick={() => state.setDatasetView('archived')}
            title="Sealed datasets — the record of what was exported and where"
            className={cn(
              'rounded-chip px-2 py-0.5 text-[11px] font-bold',
              state.datasetView === 'archived'
                ? 'bg-text-secondary text-text-inverse'
                : 'border border-border text-text-secondary hover:bg-surface-muted',
            )}
          >
            Archived ({state.archivedDatasetCount})
          </button>
        </div>
      </div>

      {state.isLoading ? (
        <div className="px-4 py-6 text-sm text-text-muted">Loading datasets…</div>
      ) : (
        <div data-testid="dataset-list-scroll" className="min-h-0 flex-1 overflow-y-auto p-2.5">
          {!hasAny ? (
            <div data-testid="dataset-list-empty" className="flex flex-col gap-1 px-1.5 py-4">
              {searchActive && state.total > 0 ? (
                <>
                  <span className="text-sm text-text-muted">No datasets match.</span>
                  <span className="text-xs leading-relaxed text-text-muted">
                    {state.total} dataset(s) are hidden by the search — clear it to see
                    them.
                  </span>
                </>
              ) : (
                <>
                  <span className="text-sm text-text-muted">No datasets yet.</span>
                  <span className="text-xs leading-relaxed text-text-muted">
                    Create one with “+ New”, then add finished recordings to it from the
                    right-hand rail.
                  </span>
                </>
              )}
              {state.isError && (
                <span className="text-xs text-status-warning-text">
                  Couldn&apos;t reach the backend just now.
                </span>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {state.rows.map((row) => (
                <DatasetListRow key={row.dataset.dataset_id} row={row} state={state} />
              ))}
            </div>
          )}
        </div>
      )}
      <CombineDatasetsDialog state={state} />
    </div>
  );
}
