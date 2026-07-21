// Center column (2026-07-21 IA overhaul): the episode table for the selected
// (task, condition) group, with the reused per-episode detail (DatasetDetail +
// DatasetInspection) rendered BELOW it once a row is picked. No group selected
// renders an honest explanatory empty state, never a blank panel.
//
// Columns: # · Operator · Labels · Msgs · Exported. The Labels column reuses the
// shared EpisodeLabelChips (set/batch + task-result + quality, with the
// server->display mapping centralized there), so the separate "set" chip lives
// inside it rather than being duplicated as its own column. Legacy rows (no
// episode labels) render the honest note in the Labels cell.

import type { DatasetEntry } from '../../api/types';
import { Badge, cn } from '../../components/ui';
import { EpisodeLabelChips } from '../episodeChips';
import { DatasetDetail } from './DatasetDetail';
import {
  NO_CONDITION_LABEL,
  UNKNOWN_OPERATOR,
  formatCount,
  formatShortDate,
  groupSummarySegments,
  rowEpisode,
  type DatasetGroup,
} from './data';
import type { DatasetsState } from './useDatasetsState';

// # · Operator · Labels(flex) · Msgs · Exported.
const GRID_COLS = 'grid-cols-[52px_116px_minmax(0,1fr)_76px_60px]';

function operatorLabel(op: string): string {
  return op === UNKNOWN_OPERATOR ? 'not recorded' : op;
}

function GroupHeaderBar({ group }: { group: DatasetGroup }) {
  const segments = groupSummarySegments(group.aggregate);
  return (
    <div
      data-testid="dataset-group-header"
      className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-[18px] py-[13px]"
    >
      <span className="text-[15px] font-bold text-gray-900">
        {group.task === 'unknown_task' ? 'task not recorded' : group.task}
      </span>
      <Badge tone={group.condition ? 'teal' : 'gray'}>
        {group.condition ?? NO_CONDITION_LABEL}
      </Badge>
      <div className="flex-1" />
      <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-gray-500">
        {segments.map((s, i) => (
          <span key={i} title={s.title} className="whitespace-nowrap">
            {i > 0 && <span className="mr-1.5 text-gray-300">·</span>}
            {s.text}
          </span>
        ))}
      </div>
    </div>
  );
}

function EpisodeRow({
  entry,
  state,
}: {
  entry: DatasetEntry;
  state: DatasetsState;
}) {
  const selected = state.isEntrySelected(entry);
  const episode = rowEpisode(entry);
  return (
    <div
      data-testid={`dataset-episode-row-${entry.dataset_dir}`}
      role="button"
      tabIndex={0}
      aria-selected={selected}
      onClick={() => state.selectEntry(entry)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          state.selectEntry(entry);
        }
      }}
      title={`${entry.operator}/${entry.task}/${entry.index}`}
      className={cn(
        'grid cursor-pointer items-center gap-2 border-t border-gray-50 px-[18px] py-2 text-sm transition-colors first:border-t-0 hover:bg-gray-50',
        GRID_COLS,
        selected && 'border-l-[3px] border-l-teal-600 bg-teal-50 pl-[15px]',
      )}
    >
      <span className="font-mono text-[13px] font-semibold text-gray-900">
        #{entry.index}
      </span>
      <span
        className={cn(
          'truncate text-[12.5px]',
          entry.operator === UNKNOWN_OPERATOR ? 'italic text-gray-400' : 'text-gray-600',
        )}
      >
        {operatorLabel(entry.operator)}
      </span>
      {episode ? (
        <EpisodeLabelChips
          episode={episode}
          isoFallback={entry.exported_at}
          testId={`dataset-episode-labels-${entry.dataset_dir}`}
        />
      ) : (
        <span
          data-testid={`dataset-episode-legacy-${entry.dataset_dir}`}
          title="Exported before per-episode labels existed, so quality and task labels aren't recorded."
          className="text-[11px] italic text-gray-400"
        >
          no episode labels
        </span>
      )}
      <span className="justify-self-end font-mono text-xs text-gray-500">
        {formatCount(entry.message_count)}
      </span>
      <span className="justify-self-end font-mono text-[11px] text-gray-400">
        {formatShortDate(entry.exported_at)}
      </span>
    </div>
  );
}

function EpisodeTable({
  group,
  state,
}: {
  group: DatasetGroup;
  state: DatasetsState;
}) {
  return (
    <div data-testid="dataset-episode-table" className="flex flex-col">
      <div
        className={cn(
          'grid gap-2 border-b border-gray-100 px-[18px] py-2 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400',
          GRID_COLS,
        )}
      >
        <span>#</span>
        <span>Operator</span>
        <span>Labels</span>
        <span className="justify-self-end">Msgs</span>
        <span className="justify-self-end">Exported</span>
      </div>
      {group.entries.map((entry) => (
        <EpisodeRow key={entry.dataset_dir} entry={entry} state={state} />
      ))}
    </div>
  );
}

function CenterEmpty({ hiddenSelection }: { hiddenSelection: boolean }) {
  return (
    <div
      data-testid="dataset-center-empty"
      className="flex flex-col gap-1.5 px-[18px] py-10 text-center"
    >
      {hiddenSelection ? (
        <>
          <span className="text-[13px] font-semibold text-gray-500">
            The selected group is hidden.
          </span>
          <span className="text-xs leading-relaxed text-gray-400">
            The current search or filters hide the group you selected. Clear them, or pick
            another task on the left.
          </span>
        </>
      ) : (
        <>
          <span className="text-[13px] font-semibold text-gray-500">
            Pick a task to browse its episodes.
          </span>
          <span className="text-xs leading-relaxed text-gray-400">
            The left column groups exported datasets by task, then recording condition.
            Select one to list its episodes here; select an episode to inspect it.
          </span>
        </>
      )}
    </div>
  );
}

export function DatasetCenter({ state }: { state: DatasetsState }) {
  const { selectedGroup, selectedGroupKey, selected } = state;

  return (
    <div
      data-testid="dataset-center"
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-card border border-gray-200 bg-white shadow-card"
    >
      {selectedGroup ? (
        <GroupHeaderBar group={selectedGroup} />
      ) : (
        <div className="border-b border-gray-100 px-[18px] py-[13px]">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Episodes
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!selectedGroup ? (
          <CenterEmpty hiddenSelection={selectedGroupKey !== null} />
        ) : (
          <>
            <EpisodeTable group={selectedGroup} state={state} />
            {selected && (
              <div className="border-t-4 border-gray-100">
                <DatasetDetail state={state} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
