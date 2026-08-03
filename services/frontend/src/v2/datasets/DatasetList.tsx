// Left column: the logical datasets (§6). One row per dataset — a name, the
// operator/task it was created under, and an honest one-line aggregate over its
// members. There is no tree here any more because there is nothing to nest: a
// dataset has no condition and no directory, so the list is flat and the search
// runs over the three fields a dataset actually carries.
//
// The pinned "All datasets" row clears the selection and returns the center to
// the whole-catalog scope, mirroring the pinned Summary row on the other side.
//
// "+ New" creates a real dataset. Nothing is written under objects/ and no
// recording moves, which the form says out loud — the previous model made "new
// dataset" mean "move recordings into a directory", and the two must not be
// confused while both are still in living memory.

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
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10.5px] leading-tight text-gray-500">
      {segments.map((s, i) => (
        <span key={i} title={s.title} className="whitespace-nowrap">
          {i > 0 && <span className="mr-1.5 text-gray-300">·</span>}
          <span className={cn(s.warn && 'font-semibold text-amber-700')}>{s.text}</span>
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
        selected ? 'border-teal-200 bg-teal-50' : 'border-gray-100 hover:bg-gray-50',
      )}
    >
      <span className="flex items-center gap-1.5 truncate text-[12.5px] font-semibold text-gray-900">
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
        <span className="truncate text-[10.5px] text-gray-400">{subtitle}</span>
      )}
      <SummaryLine segments={datasetSummarySegments(row)} />
    </div>
  );
}

/** The create form. Inline rather than a modal: it is three fields, and the
 *  list it adds to stays visible beside them. */
function CreateForm({ state }: { state: DatasetsState }) {
  return (
    <form
      data-testid="new-dataset-form"
      onSubmit={(e) => {
        e.preventDefault();
        state.submitCreate();
      }}
      className="flex flex-col gap-1.5 border-b border-gray-100 bg-gray-50 px-3 py-2.5"
    >
      <input
        data-testid="new-dataset-name"
        value={state.newName}
        onChange={(e) => state.setNewName(e.target.value)}
        placeholder="Dataset name"
        maxLength={200}
        autoFocus
        className="w-full rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[12.5px] text-gray-700 placeholder:text-gray-400"
      />
      <div className="flex gap-1.5">
        <input
          data-testid="new-dataset-operator"
          value={state.newOperator}
          onChange={(e) => state.setNewOperator(e.target.value)}
          placeholder="Operator (optional)"
          className="min-w-0 flex-1 rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] text-gray-700 placeholder:text-gray-400"
        />
        <input
          data-testid="new-dataset-task"
          value={state.newTask}
          onChange={(e) => state.setNewTask(e.target.value)}
          placeholder="Task (optional)"
          className="min-w-0 flex-1 rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] text-gray-700 placeholder:text-gray-400"
        />
      </div>
      <p className="text-[10.5px] leading-relaxed text-gray-500">
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
          className="rounded-chip bg-teal-600 px-[11px] py-[5px] text-xs font-bold text-white hover:bg-teal-700 disabled:opacity-40"
        >
          {state.creating ? 'Creating…' : 'Create'}
        </button>
        <button
          type="button"
          data-testid="new-dataset-cancel"
          onClick={state.cancelCreate}
          disabled={state.creating}
          className="rounded-chip border border-gray-200 px-[11px] py-[5px] text-xs font-semibold text-gray-600 hover:bg-white disabled:opacity-40"
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

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-gray-100 px-4 py-[13px]">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Datasets
        </span>
        <div className="flex-1" />
        <button
          type="button"
          data-testid="combine-datasets-btn"
          onClick={state.openCombine}
          title="Build a new dataset from existing ones. The sources are not touched."
          className="rounded-chip border border-gray-200 px-[11px] py-[5px] text-xs font-semibold text-gray-600 hover:bg-gray-50"
        >
          ⧉ Combine
        </button>
        <button
          type="button"
          data-testid="new-dataset-btn"
          onClick={state.openCreate}
          className="rounded-chip bg-teal-600 px-[11px] py-[5px] text-xs font-bold text-white hover:bg-teal-700"
        >
          + New
        </button>
      </div>

      {state.createOpen && <CreateForm state={state} />}

      {/* Toolbar: search, member facets + sort, operator, then the counter. */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-gray-100 px-3 py-2.5">
        <input
          type="search"
          data-testid="dataset-search"
          value={state.search}
          onChange={(e) => state.setSearch(e.target.value)}
          placeholder="Search dataset, operator, task…"
          className="w-full rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[12.5px] text-gray-700 placeholder:text-gray-400"
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
                    ? 'bg-teal-600 text-white'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200',
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
            className="flex items-center gap-1 rounded-chip border border-gray-200 px-2 py-0.5 text-[11px] font-semibold text-gray-600 hover:bg-gray-50"
          >
            <span aria-hidden>⇅</span>
            {state.sort === 'recent' ? 'Recent' : 'A–Z'}
          </button>
        </div>

        {state.operatorOptions.length > 0 && (
          <select
            data-testid="dataset-operator-filter"
            value={state.operatorFilter}
            onChange={(e) => state.setOperatorFilter(e.target.value)}
            className="w-full rounded-control border border-gray-200 bg-white px-2 py-1 text-[12px] text-gray-600"
          >
            <option value={ANY_OPERATOR}>Any operator</option>
            {state.operatorOptions.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
        )}

        <span data-testid="dataset-count" className="text-[11px] text-gray-400">
          showing {state.shown} of {state.total}
        </span>
      </div>

      {state.isLoading ? (
        <div className="px-4 py-6 text-sm text-gray-400">Loading datasets…</div>
      ) : (
        <div data-testid="dataset-list-scroll" className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <button
            type="button"
            data-testid="dataset-all-row"
            aria-pressed={state.selectedDatasetId === null}
            onClick={state.clearDataset}
            className={cn(
              'mb-1.5 w-full rounded-[10px] border px-[11px] py-[9px] text-left text-[12.5px] font-semibold',
              state.selectedDatasetId === null
                ? 'border-teal-200 bg-teal-50 text-teal-800'
                : 'border-gray-100 text-gray-700 hover:bg-gray-50',
            )}
          >
            All datasets
            <span className="ml-1.5 text-[10.5px] font-normal text-gray-400">
              every member, across the list
            </span>
          </button>

          {!hasAny ? (
            <div data-testid="dataset-list-empty" className="flex flex-col gap-1 px-1.5 py-4">
              {searchActive && state.total > 0 ? (
                <>
                  <span className="text-sm text-gray-500">No datasets match.</span>
                  <span className="text-xs leading-relaxed text-gray-400">
                    {state.total} dataset(s) are hidden by the search — clear it to see
                    them.
                  </span>
                </>
              ) : (
                <>
                  <span className="text-sm text-gray-500">No datasets yet.</span>
                  <span className="text-xs leading-relaxed text-gray-400">
                    Create one with “+ New”, then add finished recordings to it from the
                    right-hand rail.
                  </span>
                </>
              )}
              {state.isError && (
                <span className="text-xs text-amber-600">
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
