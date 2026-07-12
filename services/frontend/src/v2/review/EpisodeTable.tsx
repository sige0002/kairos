// Episodes column: header (count, adopt-all, search, transfer-all) + the
// scrollable row list. Real runs in, decorated with local decisions/overrides
// (useReviewState); Quality/Task result render the *effective* (post-override)
// value, matching the mock's `effQuality`/`effTask`.

import { Badge, TrashIcon, cn, type Tone } from '../../components/ui';
import { formatHms, formatTimeOfDay } from './format';
import type { DecoratedEpisode, Quality, TaskResult } from './types';
import type { ReviewState } from './useReviewState';

function qualityTone(q: Quality): Tone {
  if (q === 'Good') return 'green';
  if (q === 'Needs review') return 'amber';
  return 'red';
}

function taskTone(t: TaskResult): Tone {
  return t === 'Success' ? 'teal' : 'gray';
}

function transferBadge(row: DecoratedEpisode): { tone: Tone; label: string } {
  switch (row.transferSlot.phase) {
    case 'transferred':
      return { tone: 'green', label: 'transferred' };
    case 'transferring':
      return { tone: 'amber', label: `${row.transferSlot.pct}%` };
    default:
      return { tone: 'gray', label: 'on robot' };
  }
}

// The row is a grid stretched to the card's full (fluid) width, but the data
// columns are fixed-width — without a flexible spacer track, the unused width
// past the last data column would sit inside the row element with no column
// of its own, and a click anywhere in it (e.g. dead-center of the row) would
// resolve to whichever adjacent column happens to be nearest, not "nothing".
// The `minmax(0,1fr)` track absorbs that space so the trailing action column
// stays pinned to the right edge instead of floating mid-row.
// (Tailwind's arbitrary-value classes must appear as complete literal strings
// in the source for its scanner to pick them up — hence two full strings
// rather than building one via interpolation.)
const GRID_COLS = 'grid-cols-[56px_48px_108px_96px_72px_80px_30px_minmax(0,1fr)_28px]';
const GRID_COLS_SPLIT = 'grid-cols-[56px_48px_108px_96px_72px_80px_30px_84px_minmax(0,1fr)_28px]';

function Row({ row, isSelected, rv }: { row: DecoratedEpisode; isSelected: boolean; rv: ReviewState }) {
  const transfer = transferBadge(row);
  return (
    <div
      data-testid={`review-row-${row.ep}`}
      onClick={() => rv.select(row.runId)}
      title={row.runId}
      className={cn(
        'grid cursor-pointer items-center gap-2 border-t border-gray-50 px-[18px] py-2 text-sm transition-colors first:border-t-0 hover:bg-gray-50',
        rv.splitMode ? GRID_COLS_SPLIT : GRID_COLS,
        isSelected && 'border-l-[3px] border-l-teal-600 bg-teal-50 pl-[15px]',
        row.isArchived && 'bg-red-50 opacity-50',
      )}
    >
      <span className="font-mono text-[13px] font-semibold text-gray-900">#{row.ep}</span>
      <span className="font-mono text-[12.5px] text-gray-500">{row.batch}</span>
      <Badge tone={row.isArchived ? 'red' : qualityTone(row.effectiveQuality)} className="w-fit">
        {row.isArchived ? 'DELETE CANDIDATE' : row.effectiveQuality.toUpperCase()}
      </Badge>
      <Badge tone={taskTone(row.effectiveTask)} className="w-fit">
        {row.effectiveTask.toUpperCase()}
      </Badge>
      <span className="font-mono text-xs text-gray-500">{formatHms(row.durationMs)}</span>
      <span className="font-mono text-xs text-gray-400">{formatTimeOfDay(row.startedAt)}</span>
      <span className="font-mono text-xs text-amber-600">{row.warnCount > 0 ? row.warnCount : ''}</span>
      {rv.splitMode && (
        <Badge tone={transfer.tone} className="w-fit whitespace-nowrap">
          {transfer.label}
        </Badge>
      )}
      <span aria-hidden />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          rv.requestArchive(row.runId);
        }}
        title={row.isArchived ? 'Restore from delete candidates' : 'Mark not usable → delete candidate'}
        className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-gray-300 transition-colors hover:bg-red-50 hover:text-red-600"
      >
        {row.isArchived ? <span className="text-sm text-teal-700">↺</span> : <TrashIcon />}
      </button>
    </div>
  );
}

export function EpisodeTable({ rv }: { rv: ReviewState }) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-gray-100 px-[18px] py-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">Episodes</span>
        <span data-testid="review-episodes-count" className="font-mono text-xs text-gray-400">
          {rv.rows.length} shown
        </span>
        <div className="flex-1" />
        {rv.hasArchived && (
          <button
            type="button"
            onClick={rv.toggleArchived}
            className="rounded-control border border-gray-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray-500 transition-colors hover:bg-gray-50"
          >
            {rv.showArchived ? 'Hide' : 'Show'} delete candidates ({rv.nArchived})
          </button>
        )}
        {rv.splitMode && (
          <button
            type="button"
            data-testid="review-transfer-all"
            onClick={rv.transferAllUntransferred}
            className="rounded-control border border-gray-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray-500 transition-colors hover:bg-gray-50"
          >
            Transfer untransferred ({rv.nUntransferred})
          </button>
        )}
        <button
          type="button"
          data-testid="review-adopt-all"
          onClick={rv.adoptAllGood}
          className="rounded-control border border-teal-200 bg-teal-50 px-3 py-1.5 text-[12.5px] font-semibold text-teal-700 transition-colors hover:bg-teal-100"
        >
          Adopt all good ({rv.nUndecidedGood})
        </button>
        <input
          type="text"
          value={rv.search}
          onChange={(e) => rv.setSearch(e.target.value)}
          placeholder="Search episodes…"
          data-testid="review-search"
          className="w-[170px] rounded-control border border-gray-200 px-2.5 py-1.5 text-[12.5px] text-gray-700 placeholder:text-gray-400"
        />
      </div>
      <div
        className={cn(
          'grid gap-2 border-b border-gray-100 px-[18px] py-2 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400',
          rv.splitMode ? GRID_COLS_SPLIT : GRID_COLS,
        )}
      >
        <span>Episode</span>
        <span>Batch</span>
        <span>Quality</span>
        <span>Task result</span>
        <span>Duration</span>
        <span>Time</span>
        <span>⚠</span>
        {rv.splitMode && <span>Transfer</span>}
        <span aria-hidden />
        <span />
      </div>
      <div className="flex-1 overflow-auto">
        {rv.isLoading ? (
          <p className="px-[18px] py-3 text-sm text-gray-500">Loading episodes…</p>
        ) : rv.rows.length === 0 ? (
          <p className="px-[18px] py-3 text-sm text-gray-500">No episodes to review yet.</p>
        ) : (
          rv.rows.map((row) => (
            <Row key={row.runId} row={row} isSelected={row.runId === rv.selectedRunId} rv={rv} />
          ))
        )}
      </div>
    </div>
  );
}
