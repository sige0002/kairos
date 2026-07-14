// Episodes column: header (count, adopt-all, search, transfer-all) + the
// scrollable row list. Real runs in, decorated with local decisions/overrides
// (useReviewState); Quality/Task result render the *effective* (post-override)
// value, matching the mock's `effQuality`/`effTask`.

import { Badge, cn, type Tone } from '../../components/ui';
import { LaneChip, QualityChip, TaskResultChip } from '../episodeChips';
import { formatHms, formatTimeOfDay } from './format';
import type { DecoratedEpisode } from './types';
import type { ReviewState } from './useReviewState';

// A trash can reads as permanent deletion — this action never deletes
// anything (the recording is kept and restorable), so it gets its own glyph
// rather than the shared TrashIcon: a closed archive box, the same visual
// vocabulary as "archive" actions elsewhere (mail, docs, etc.), so it reads as
// "set aside" rather than "destroy". Matches TrashIcon's own hand-drawn-SVG
// convention (24x24 viewBox, stroke currentColor) for a consistent look.
function ArchiveIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M10 13h4" />
    </svg>
  );
}

// Quality renders the *effective* (post-override) value via the shared chip; an
// archived (Excluded) row shows EXCLUDED in the quality column too.
function QualityCell({ row }: { row: DecoratedEpisode }) {
  if (row.isArchived)
    return (
      <Badge tone="red" className="w-fit">
        EXCLUDED
      </Badge>
    );
  return <QualityChip quality={row.effectiveQuality} />;
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
const GRID_COLS = 'grid-cols-[56px_48px_108px_96px_72px_80px_minmax(0,1fr)_28px]';
const GRID_COLS_SPLIT =
  'grid-cols-[56px_48px_108px_96px_72px_80px_84px_minmax(0,1fr)_28px]';

function Row({
  row,
  isSelected,
  rv,
}: {
  row: DecoratedEpisode;
  isSelected: boolean;
  rv: ReviewState;
}) {
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
      <span className="font-mono text-[13px] font-semibold text-gray-900">
        #{row.ep}
      </span>
      {row.batchId ? (
        <button
          type="button"
          data-testid={`review-batch-chip-${row.ep}`}
          onClick={(e) => {
            e.stopPropagation();
            rv.toggleBatchFilter(row.batchId);
          }}
          title={
            rv.batchFilter === row.batchId
              ? 'Show all batches'
              : 'Filter to this batch (then decide it in one action)'
          }
          className={cn(
            'w-fit rounded-chip px-1 text-left font-mono text-[12.5px]',
            rv.batchFilter === row.batchId
              ? 'bg-teal-100 font-semibold text-teal-800'
              : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700',
          )}
        >
          {row.batch}
        </button>
      ) : (
        <span className="font-mono text-[12.5px] text-gray-500">{row.batch}</span>
      )}
      <QualityCell row={row} />
      <TaskResultChip task={row.effectiveTask} reason={row.failReason} />
      <span className="font-mono text-xs text-gray-500">
        {formatHms(row.durationMs)}
      </span>
      <span className="font-mono text-xs text-gray-400">
        {formatTimeOfDay(row.startedAt)}
      </span>
      {rv.splitMode && (
        <Badge tone={transfer.tone} className="w-fit whitespace-nowrap">
          {transfer.label}
        </Badge>
      )}
      <span className="justify-self-end">
        <LaneChip lane={row.reviewLane} testId={`review-status-${row.ep}`} />
      </span>
      <button
        type="button"
        data-testid={`review-archive-${row.ep}`}
        onClick={(e) => {
          e.stopPropagation();
          rv.requestArchive(row.runId);
        }}
        title={
          row.isArchived
            ? 'Restore to dataset use'
            : 'Exclude from dataset use (recording is kept)'
        }
        className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-gray-300 transition-colors hover:bg-red-50 hover:text-red-600"
      >
        {row.isArchived ? (
          <span className="text-sm text-teal-700">↺</span>
        ) : (
          <ArchiveIcon />
        )}
      </button>
    </div>
  );
}

export function EpisodeTable({ rv }: { rv: ReviewState }) {
  // At-a-glance tallies over the SHOWN rows (persona review R2 / D-8-5: OP2 had
  // to count the column by eye). Real data only — lanes + task_result.
  const nReady = rv.rows.filter((r) => r.reviewLane === 'ready').length;
  const nCheck = rv.rows.filter((r) => r.reviewLane === 'needs_check').length;
  const nExcluded = rv.rows.filter((r) => r.reviewLane === 'excluded').length;
  const nSuccess = rv.rows.filter((r) => r.task === 'Success').length;
  const nFail = rv.rows.filter((r) => r.task === 'Failure').length;
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-gray-100 px-[18px] py-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Episodes
        </span>
        <span
          data-testid="review-episodes-count"
          className="font-mono text-xs text-gray-400"
        >
          {rv.rows.length} shown
        </span>
        {rv.rows.length > 0 && (
          <>
            <span
              data-testid="review-lane-tally"
              className="rounded-chip bg-gray-50 px-2 py-0.5 font-mono text-[11px] text-gray-500"
            >
              {nReady} ready · {nCheck} needs check · {nExcluded} excluded
            </span>
            <span
              data-testid="review-task-tally"
              className="rounded-chip bg-gray-50 px-2 py-0.5 font-mono text-[11px] text-gray-500"
            >
              {nSuccess} success · {nFail} failure
            </span>
          </>
        )}
        <div className="flex-1" />
        {rv.hasArchived && (
          <button
            type="button"
            onClick={rv.toggleArchived}
            className="rounded-control border border-gray-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray-500 transition-colors hover:bg-gray-50"
          >
            {rv.showArchived ? 'Hide' : 'Show'} excluded ({rv.nArchived})
          </button>
        )}
        {rv.hasArchived && (
          <button
            type="button"
            data-testid="review-bulk-delete"
            onClick={rv.requestBulkDelete}
            title="Permanently delete every excluded recording from disk"
            className="rounded-control border border-red-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-red-700 transition-colors hover:bg-red-50"
          >
            Delete excluded ({rv.nArchived})…
          </button>
        )}
        {rv.splitMode && (
          <button
            type="button"
            data-testid="review-transfer-all"
            onClick={rv.transferAllUntransferred}
            disabled={rv.nUntransferred === 0}
            title={
              rv.nUntransferred === 0
                ? 'Every recording is already transferred'
                : 'Transfer every recording still only on the robot'
            }
            className="rounded-control border border-gray-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray-500 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:border-gray-100 disabled:bg-gray-50 disabled:text-gray-300 disabled:hover:bg-gray-50"
          >
            Transfer untransferred ({rv.nUntransferred})
          </button>
        )}
        {rv.batchFilter && (
          <>
            <span
              data-testid="review-batch-filter-chip"
              className="rounded-chip bg-teal-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-teal-800"
            >
              Batch {rv.batchFilterLabel}
            </span>
            <button
              type="button"
              data-testid="review-exclude-batch"
              onClick={rv.requestExcludeBatch}
              disabled={rv.batchExcludable.length === 0}
              title="Exclude every not-yet-excluded episode of this batch (recordings kept, reversible)"
              className="rounded-control border border-red-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:border-gray-100 disabled:text-gray-300 disabled:hover:bg-white"
            >
              Exclude batch ({rv.batchExcludable.length})…
            </button>
            {rv.batchExcluded.length > 0 && (
              <button
                type="button"
                data-testid="review-return-batch"
                onClick={rv.returnBatchToReview}
                title="Return every excluded episode of this batch to review (pending)"
                className="rounded-control border border-gray-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray-500 transition-colors hover:bg-gray-50"
              >
                ↺ Return batch ({rv.batchExcluded.length})
              </button>
            )}
            <button
              type="button"
              data-testid="review-batch-filter-clear"
              onClick={() => rv.toggleBatchFilter(null)}
              title="Show all batches"
              className="rounded-control border border-gray-200 bg-white px-2 py-1.5 text-[12.5px] font-semibold text-gray-500 hover:bg-gray-50"
            >
              ✕
            </button>
          </>
        )}
        <label
          data-testid="review-include-failed"
          title="Task-failed recordings are still labeled, useful data"
          className="flex items-center gap-1.5 text-[11.5px] font-medium text-gray-500"
        >
          <input
            type="checkbox"
            checked={rv.includeFailed}
            onChange={(e) => rv.setIncludeFailed(e.target.checked)}
            className="h-3.5 w-3.5 accent-teal-600"
          />
          Include task-failed (labeled)
        </label>
        <button
          type="button"
          data-testid="review-export-ready"
          onClick={rv.requestExportReady}
          disabled={rv.readyExportable.length === 0}
          title={
            rv.readyExportable.length === 0
              ? 'No READY recordings to export yet'
              : 'Move every READY recording into the Datasets tree'
          }
          className="rounded-control bg-teal-600 px-3 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400 disabled:hover:bg-gray-200"
        >
          Export ready ({rv.readyExportable.length})…
        </button>
        <input
          type="text"
          value={rv.search}
          onChange={(e) => rv.setSearch(e.target.value)}
          placeholder="Search episodes…"
          data-testid="review-search"
          className="w-[150px] rounded-control border border-gray-200 px-2.5 py-1.5 text-[12.5px] text-gray-700 placeholder:text-gray-400"
        />
      </div>
      {/* Exception-review: good takes zero clicks; you only check the exceptions. */}
      <p
        data-testid="review-adopt-explainer"
        className="border-b border-gray-100 px-[18px] py-1.5 text-[11px] text-gray-400"
      >
        <span className="font-semibold text-teal-700">READY</span> episodes export as-is
        — you only resolve the{' '}
        <span className="font-semibold text-amber-700">NEEDS CHECK</span> exceptions.
        Export moves the recording into Datasets.
      </p>
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
        {rv.splitMode && <span>Transfer</span>}
        <span className="justify-self-end">Status</span>
        <span />
      </div>
      <div className="flex-1 overflow-auto">
        {rv.isLoading ? (
          <p className="px-[18px] py-3 text-sm text-gray-500">Loading episodes…</p>
        ) : rv.isError ? (
          <p className="px-[18px] py-3 text-sm text-red-600" role="alert">
            Couldn&apos;t load recordings{rv.errorMessage ? `: ${rv.errorMessage}` : ''}
            .
          </p>
        ) : rv.rows.length === 0 ? (
          <p className="px-[18px] py-3 text-sm text-gray-500">
            No episodes to review yet.
          </p>
        ) : (
          rv.rows.map((row) => (
            <Row
              key={row.runId}
              row={row}
              isSelected={row.runId === rv.selectedRunId}
              rv={rv}
            />
          ))
        )}
      </div>
      <p
        data-testid="review-bridge-caption"
        className="border-t border-gray-100 px-[18px] py-2 text-[11px] text-gray-400"
      >
        Quality / Task / Batch from the episode records (server) · pre-Phase-2 entries
        from this browser.
      </p>
    </div>
  );
}
