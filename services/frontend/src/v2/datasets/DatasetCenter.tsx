// Center column (2026-07-21 center-split round). Two vertically stacked panes:
//   TOP  — the scope's episode table, capped at ~10 rows with internal scroll,
//          fronted by a pinned Summary row and its own episode search box (a
//          one-shot "jump to episode NNN / #set / operator / failure" find,
//          distinct from the left tree search).
//   BOTTOM — the selected episode's detail (reused DatasetDetail +
//          DatasetInspection), OR — whenever no episode is selected — the scope
//          SUMMARY (ScopeSummary: success/failure donut + real aggregates).
//
// Scope = the selected (task, condition) group; with no group selected it is the
// whole filtered catalog, so the top pane lists every filtered episode and the
// bottom shows a catalog overview (this replaces the old "no group selected"
// empty state with something useful — flagged as an interpretation to the lead).
//
// Selection model: clicking an episode row selects it; clicking it again — or
// clicking the pinned Summary row — clears the selection and returns to the
// summary. Selecting a different group also clears the episode selection.
//
// The Labels column reuses the shared EpisodeLabelChips (set/batch + task-result
// + quality, server->display mapping centralized there); legacy rows show the
// honest "no episode labels" note in that cell.

import type { DatasetEntry } from '../../api/types';
import { Badge, cn } from '../../components/ui';
import { EpisodeLabelChips } from '../episodeChips';
import { DatasetDetail } from './DatasetDetail';
import { ScopeSummary } from './ScopeSummary';
import {
  NO_CONDITION_LABEL,
  UNKNOWN_OPERATOR,
  formatCount,
  formatShortDate,
  rowEpisode,
} from './data';
import type { DatasetsState } from './useDatasetsState';

// # · Operator · Labels(flex) · Msgs · Exported.
const GRID_COLS = 'grid-cols-[52px_116px_minmax(0,1fr)_76px_60px]';
// Roughly ten rows tall, then the top pane scrolls internally.
const TABLE_SCROLL = 'max-h-[370px]';

function operatorLabel(op: string): string {
  return op === UNKNOWN_OPERATOR ? 'not recorded' : op;
}

/** A small donut glyph for the Summary row (decorative — the real chart is in
 *  the summary pane). */
function SummaryGlyph({ active }: { active: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <circle
        cx={8}
        cy={8}
        r={6}
        fill="none"
        strokeWidth={3}
        className={active ? 'stroke-teal-200' : 'stroke-gray-200'}
      />
      <circle
        cx={8}
        cy={8}
        r={6}
        fill="none"
        strokeWidth={3}
        pathLength={100}
        strokeDasharray="62 100"
        transform="rotate(-90 8 8)"
        className={active ? 'stroke-teal-600' : 'stroke-gray-500'}
      />
    </svg>
  );
}

function ScopeHeaderBar({ state }: { state: DatasetsState }) {
  const { scope, scopeEpisodes } = state;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-[18px] py-[11px]">
      <span data-testid="dataset-scope-title" className="text-[15px] font-bold text-gray-900">
        {scope.label}
      </span>
      {scope.kind === 'group' && (
        <Badge tone={scope.condition ? 'teal' : 'gray'}>
          {scope.condition ?? NO_CONDITION_LABEL}
        </Badge>
      )}
      <span className="text-[11.5px] text-gray-400">{scopeEpisodes.length} episodes</span>
      <div className="flex-1" />
      <input
        type="search"
        data-testid="dataset-episode-search"
        value={state.episodeSearch}
        onChange={(e) => state.setEpisodeSearch(e.target.value)}
        placeholder="Find episode #NNN, #set, operator…"
        className="w-[190px] rounded-control border border-gray-200 bg-white px-2.5 py-1 text-[12px] text-gray-700 placeholder:text-gray-400"
      />
    </div>
  );
}

function SummaryRow({ state }: { state: DatasetsState }) {
  const active = state.isSummaryActive;
  return (
    <button
      type="button"
      data-testid="dataset-summary-row"
      aria-pressed={active}
      onClick={state.selectSummary}
      className={cn(
        'flex w-full items-center gap-2 border-b border-gray-100 px-[18px] py-2 text-left transition-colors',
        active ? 'border-l-[3px] border-l-teal-600 bg-teal-50 pl-[15px]' : 'hover:bg-gray-50',
      )}
    >
      <SummaryGlyph active={active} />
      <span
        className={cn('text-[12.5px] font-semibold', active ? 'text-teal-800' : 'text-gray-700')}
      >
        Summary
      </span>
      <span className="truncate text-[11.5px] text-gray-400">
        success / failure · quality · totals for {state.scope.label}
      </span>
    </button>
  );
}

function EpisodeRow({ entry, state }: { entry: DatasetEntry; state: DatasetsState }) {
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
      <span className="font-mono text-[13px] font-semibold text-gray-900">#{entry.index}</span>
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

export function DatasetCenter({ state }: { state: DatasetsState }) {
  const { episodeRows, scopeEpisodes, selected } = state;

  return (
    <div
      data-testid="dataset-center"
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-card border border-gray-200 bg-white shadow-card"
    >
      {/* TOP PANE — episodes, capped ~10 rows then internal scroll. */}
      <div data-testid="dataset-top-pane" className="flex shrink-0 flex-col">
        <ScopeHeaderBar state={state} />
        <SummaryRow state={state} />
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
        <div data-testid="dataset-episode-scroll" className={cn('overflow-y-auto', TABLE_SCROLL)}>
          {episodeRows.length === 0 ? (
            <p
              data-testid="dataset-episode-search-empty"
              className="px-[18px] py-4 text-[12.5px] text-gray-400"
            >
              {scopeEpisodes.length === 0
                ? 'No episodes in this scope.'
                : `No episode matches “${state.episodeSearch}”.`}
            </p>
          ) : (
            episodeRows.map((entry) => (
              <EpisodeRow key={entry.dataset_dir} entry={entry} state={state} />
            ))
          )}
        </div>
      </div>

      {/* BOTTOM PANE — selected episode detail, else the scope summary. */}
      <div
        data-testid="dataset-bottom-pane"
        className="min-h-0 flex-1 overflow-y-auto border-t-4 border-gray-100"
      >
        {selected ? <DatasetDetail state={state} /> : <ScopeSummary scope={state.scope} />}
      </div>
    </div>
  );
}
