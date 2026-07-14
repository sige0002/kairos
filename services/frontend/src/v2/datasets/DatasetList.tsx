// Left column: the real exported-dataset catalog (GET /api/v1/datasets),
// grouped operator -> [task #index] (see data.ts). Selecting a card switches
// the center/right columns' content (useDatasetsState owns the selection).
// Renders an honest empty state both when there are genuinely no exports yet
// and when the backend is unreachable — never a blank panel.

import type { DatasetEntry, RunEpisode } from '../../api/types';
import { Badge, cn } from '../../components/ui';
import { EpisodeLabelChips } from '../episodeChips';
import { formatCount, UNKNOWN_OPERATOR, UNKNOWN_TASK } from './data';
import type { DatasetsState, TaskResultFilter } from './useDatasetsState';

const RESULT_FILTERS: { id: TaskResultFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'success', label: 'Success' },
  { id: 'failure', label: 'Failure' },
];

const MUTED = 'italic text-gray-400';

/** The datasets LIST serves the episode-label subset as FLAT row fields
 *  (episode.json is nested only on the detail payload). Adapt a row into the
 *  RunEpisode shape the shared chips consume; null when no label survived
 *  export (pre-label datasets) so the card shows nothing fabricated. */
function rowEpisode(entry: DatasetEntry): RunEpisode | null {
  // The chips render task-result + quality unconditionally, so both must be
  // real values (episode.json writes them together; absent file -> all null).
  if (entry.task_result == null || entry.quality == null) return null;
  return {
    episode_id: '',
    batch_id: '',
    index_in_batch: entry.index_in_batch ?? 0,
    task_result: entry.task_result,
    failure_reason: entry.failure_reason ?? null,
    quality: entry.quality,
    review_status: entry.review_status ?? 'pending',
    batch_seq: entry.batch_seq ?? null,
  };
}

/** A pre-label export: the backend couldn't attribute it to an operator/task
 *  (older exports predate the episode model). Shown muted, labeled honestly. */
function isLegacy(operator: string, task: string): boolean {
  return operator === 'unknown_operator' || task === 'unknown_task';
}

export function DatasetList({ state }: { state: DatasetsState }) {
  const hasAny = state.groups.length > 0;
  const filtersActive =
    state.taskResultFilter !== 'all' || state.conditionFilter !== null;
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

      {(state.total > 0 || filtersActive) && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-gray-100 px-3 py-2">
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
          {state.conditions.length > 0 && (
            <select
              data-testid="dataset-filter-condition"
              value={state.conditionFilter ?? ''}
              onChange={(e) => state.setConditionFilter(e.target.value || null)}
              className="max-w-[130px] rounded-chip border border-gray-200 bg-white px-1.5 py-0.5 text-[11px] text-gray-600"
            >
              <option value="">Any condition</option>
              {state.conditions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
          <div className="flex-1" />
          <button
            type="button"
            data-testid="dataset-manifest-btn"
            onClick={state.downloadManifest}
            disabled={state.filtered.length === 0}
            title="Download the filtered rows as a manifest JSON — a versionable training-set definition"
            className="rounded-chip border border-teal-200 px-2 py-0.5 text-[11px] font-bold text-teal-700 hover:bg-teal-50 disabled:opacity-40"
          >
            Manifest ({state.filtered.length})
          </button>
        </div>
      )}

      {state.isLoading ? (
        <div className="px-4 py-6 text-sm text-gray-400">Loading datasets…</div>
      ) : !hasAny ? (
        <div data-testid="dataset-list-empty" className="flex flex-col gap-1 px-4 py-6">
          {filtersActive && state.total > 0 ? (
            <>
              <span className="text-sm text-gray-500">
                No datasets match the filter.
              </span>
              <span className="text-xs leading-relaxed text-gray-400">
                {state.total} dataset(s) are hidden by the current task-result/condition
                filter — unlabeled (pre-label) exports only appear under “All”.
              </span>
            </>
          ) : (
            <>
              <span className="text-sm text-gray-500">No datasets yet.</span>
              <span className="text-xs leading-relaxed text-gray-400">
                Exported datasets will appear here. Recipe-based builds arrive in Phase
                2.
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
          className="min-h-0 flex-1 overflow-y-auto p-3"
        >
          <div className="flex flex-col gap-3">
            {state.groups.map((group) => (
              <div key={group.operator} className="flex flex-col gap-[7px]">
                <span
                  className={cn(
                    'px-1 text-[11px] font-semibold',
                    group.operator === UNKNOWN_OPERATOR
                      ? MUTED
                      : 'font-mono text-gray-500',
                  )}
                >
                  {group.operator === UNKNOWN_OPERATOR
                    ? 'operator not recorded'
                    : group.operator}
                </span>
                {group.entries.map((entry) => {
                  const selected = state.isSelected(entry);
                  const legacy = isLegacy(entry.operator, entry.task);
                  const episode = rowEpisode(entry);
                  return (
                    <div
                      key={entry.dataset_dir}
                      data-testid={`dataset-card-${entry.dataset_dir}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => state.select(entry)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') state.select(entry);
                      }}
                      className={cn(
                        'flex cursor-pointer flex-col gap-[5px] rounded-[11px] border px-[13px] py-[11px]',
                        selected ? 'border-teal-200 bg-teal-50' : 'border-gray-100',
                        legacy && !selected && 'opacity-70',
                      )}
                    >
                      <span
                        className={cn(
                          'text-[13px] font-semibold',
                          entry.task === UNKNOWN_TASK ? MUTED : 'text-gray-900',
                        )}
                      >
                        {entry.task === UNKNOWN_TASK ? 'task not recorded' : entry.task}
                      </span>
                      {entry.condition && (
                        <span
                          data-testid={`dataset-card-condition-${entry.dataset_dir}`}
                          title={
                            entry.batch_id
                              ? `Recording condition (batch ${entry.batch_id})`
                              : 'Recording condition'
                          }
                          className="text-[10.5px] text-gray-500"
                        >
                          {entry.condition}
                        </span>
                      )}
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11.5px] text-gray-500">
                          {formatCount(entry.message_count)} msgs
                        </span>
                        <div className="flex-1" />
                        <Badge tone={selected ? 'teal' : 'gray'} mono>
                          #{entry.index}
                        </Badge>
                      </div>
                      {/* One predicate — the presence of an episode label
                        (`episode`) — drives BOTH sides so a card can never claim
                        both at once: labels present → chips (no note); labels
                        absent → the note (no chips). Operator/task attribution
                        is a separate, independent axis (the muted group header
                        and task label above), not this label axis. */}
                      {episode ? (
                        <EpisodeLabelChips
                          episode={episode}
                          isoFallback={entry.exported_at}
                          testId={`dataset-card-labels-${entry.dataset_dir}`}
                        />
                      ) : (
                        <span
                          data-testid={`dataset-card-legacy-${entry.dataset_dir}`}
                          title="Exported before per-episode labels existed, so quality and task labels aren't recorded."
                          className="text-[10.5px] italic text-gray-400"
                        >
                          no episode labels (exported before labeling)
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
