// Left column (2026-07-21 IA overhaul): the exported-dataset catalog folded into
// a task -> condition tree (GET /api/v1/datasets, grouped client-side in
// data.ts). The (task, condition) pair — not the episode — is the selectable
// unit, so a catalog of hundreds of episodes stays navigable. A search box, a
// recency/A–Z sort toggle, and task-result + operator facets narrow BOTH the
// tree and the center table. Operator is a facet, not a hierarchy level, but
// stays visible on every group's aggregate line (user decision). Honest empty
// states cover "no exports yet", "backend unreachable", and "filtered to none".

import type { DatasetGroup, SummarySegment, TaskNode } from './data';
import { cn } from '../../components/ui';
import {
  ANY_OPERATOR,
  UNKNOWN_OPERATOR,
  UNKNOWN_TASK,
  NO_CONDITION_LABEL,
  groupSummarySegments,
  groupTestId,
  isLeafTask,
  taskTestId,
} from './data';
import type { DatasetsState, TaskResultFilter } from './useDatasetsState';

const RESULT_FILTERS: { id: TaskResultFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'success', label: 'Success' },
  { id: 'failure', label: 'Failure' },
];

const MUTED = 'italic text-gray-400';

function taskLabel(task: string): string {
  return task === UNKNOWN_TASK ? 'task not recorded' : task;
}

function operatorLabel(op: string): string {
  return op === UNKNOWN_OPERATOR ? 'operator not recorded' : op;
}

/** The honest one-line aggregate (eps · sets · ✓/✗ or "no labels" · size ·
 *  last · operators) — every segment computed from real row fields. */
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

/** A selectable (task, condition) group row — either a leaf task's own row or a
 *  condition child under an expanded multi-condition task. */
function GroupRow({
  group,
  state,
  title,
  indented,
}: {
  group: DatasetGroup;
  state: DatasetsState;
  /** The row's headline (task name for a leaf, condition label for a child). */
  title: string;
  indented: boolean;
}) {
  const selected = state.isGroupSelected(group.key);
  return (
    <div
      data-testid={groupTestId(group)}
      role="button"
      tabIndex={0}
      onClick={() => state.selectGroup(group)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          state.selectGroup(group);
        }
      }}
      className={cn(
        'flex cursor-pointer flex-col gap-[3px] rounded-[10px] border px-[11px] py-[9px]',
        indented && 'ml-3',
        selected ? 'border-teal-200 bg-teal-50' : 'border-gray-100 hover:bg-gray-50',
        group.isLegacy && !selected && 'opacity-70',
      )}
    >
      <span
        className={cn(
          'text-[12.5px] font-semibold',
          group.condition === null && !indented && group.isLegacy
            ? MUTED
            : group.condition === null && indented
              ? 'text-gray-500'
              : 'text-gray-900',
          group.isLegacy && 'italic text-gray-400',
        )}
      >
        {title}
      </span>
      <SummaryLine segments={groupSummarySegments(group.aggregate)} />
    </div>
  );
}

/** A leaf task (single condition group): the task row itself selects the group.
 *  A non-null condition is shown as a small subtitle; a null one collapses away
 *  ("a task with a single null condition collapses naturally"). */
function LeafTask({ node, state }: { node: TaskNode; state: DatasetsState }) {
  const group = node.conditions[0]!;
  return (
    <div data-testid={taskTestId(node.task)}>
      <GroupRow
        group={group}
        state={state}
        title={taskLabel(node.task)}
        indented={false}
      />
      {group.condition !== null && (
        <span className="ml-[11px] mt-0.5 block text-[10.5px] text-gray-400">
          {group.condition}
        </span>
      )}
    </div>
  );
}

/** A multi-condition task: a collapsible header (cross-condition aggregate) over
 *  the (task, condition) child rows. */
function TaskGroup({ node, state }: { node: TaskNode; state: DatasetsState }) {
  const expanded = state.isTaskExpanded(node.task);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        data-testid={taskTestId(node.task)}
        onClick={() => state.toggleTask(node.task)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 rounded-[10px] px-[9px] py-[7px] text-left hover:bg-gray-50"
      >
        <span aria-hidden className="w-3 shrink-0 text-[11px] text-gray-400">
          {expanded ? '▾' : '▸'}
        </span>
        <span className={cn('text-[12.5px] font-semibold', node.isLegacy ? MUTED : 'text-gray-800')}>
          {taskLabel(node.task)}
        </span>
        <span className="text-[10.5px] text-gray-400">
          ({node.aggregate.episodeCount} eps · {node.conditions.length} conditions)
        </span>
      </button>
      {expanded &&
        node.conditions.map((group) => (
          <GroupRow
            key={group.key}
            group={group}
            state={state}
            title={group.condition ?? NO_CONDITION_LABEL}
            indented
          />
        ))}
    </div>
  );
}

export function DatasetList({ state }: { state: DatasetsState }) {
  const hasAny = state.tree.length > 0;
  const filtersActive =
    state.search.trim() !== '' ||
    state.taskResultFilter !== 'all' ||
    state.operatorFilter !== ANY_OPERATOR;

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-gray-100 px-4 py-[13px]">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Datasets
        </span>
        <div className="flex-1" />
        <button
          type="button"
          data-testid="new-dataset-btn"
          onClick={state.toastNewDataset}
          className="rounded-chip bg-teal-600 px-[11px] py-[5px] text-xs font-bold text-white hover:bg-teal-700"
        >
          + New
        </button>
      </div>

      {/* Toolbar: search, facets + sort, operator, then the counter + manifest. */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-gray-100 px-3 py-2.5">
        <input
          type="search"
          data-testid="dataset-search"
          value={state.search}
          onChange={(e) => state.setSearch(e.target.value)}
          placeholder="Search task, condition, operator, #set…"
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
                ? 'Sorted by most recent export — switch to A–Z'
                : 'Sorted A–Z — switch to most recent'
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
                {operatorLabel(op)}
              </option>
            ))}
          </select>
        )}

        <div className="flex items-center gap-2">
          <span data-testid="dataset-count" className="text-[11px] text-gray-400">
            showing {state.shown} of {state.total}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            data-testid="dataset-manifest-btn"
            onClick={state.downloadManifest}
            disabled={state.manifestCount === 0}
            title={
              state.selectedGroup
                ? 'Download the selected group as a manifest JSON (a versionable training-set definition)'
                : 'Download the filtered rows as a manifest JSON (a versionable training-set definition)'
            }
            className="rounded-chip border border-teal-200 px-2 py-0.5 text-[11px] font-bold text-teal-700 hover:bg-teal-50 disabled:opacity-40"
          >
            Manifest ({state.manifestCount})
          </button>
        </div>
      </div>

      {state.isLoading ? (
        <div className="px-4 py-6 text-sm text-gray-400">Loading datasets…</div>
      ) : !hasAny ? (
        <div data-testid="dataset-list-empty" className="flex flex-col gap-1 px-4 py-6">
          {filtersActive && state.total > 0 ? (
            <>
              <span className="text-sm text-gray-500">No datasets match.</span>
              <span className="text-xs leading-relaxed text-gray-400">
                {state.total} dataset(s) are hidden by the current search / task-result /
                operator filter — clear the search or set the filters to “All / Any” to see
                them.
              </span>
            </>
          ) : (
            <>
              <span className="text-sm text-gray-500">No datasets yet.</span>
              <span className="text-xs leading-relaxed text-gray-400">
                Exported datasets will appear here. Recipe-based builds arrive in Phase 2.
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
        <div
          data-testid="dataset-list-scroll"
          className="min-h-0 flex-1 overflow-y-auto p-2.5"
        >
          <div className="flex flex-col gap-1.5">
            {state.tree.map((node) =>
              isLeafTask(node) ? (
                <LeafTask key={node.task} node={node} state={state} />
              ) : (
                <TaskGroup key={node.task} node={node} state={state} />
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
