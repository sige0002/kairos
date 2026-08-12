// Episodes column: header (counts, bulk controls, search, transfer-all) + the
// scrollable row list. Captures in, decorated with the operator's in-flight
// choice (useReviewState); Quality/Task result render the *effective* value,
// which is the optimistic one until its save lands and the stored one after.
//
// The removal controls are two separate buttons, never one with a mode: §12
// requires Discard and Delete to be distinguishable before the click, not only
// inside the dialog.

import { Badge, cn, type Tone } from '../../components/ui';
import { AvailabilityChip } from '../captures/AvailabilityChip';
import { LaneChip, QualityChip, TaskResultChip } from '../episodeChips';
import { episodeLabel } from './types';
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

// Quality renders the *effective* value via the shared chip; an excluded row
// shows EXCLUDED in the quality column too.
function QualityCell({ row }: { row: DecoratedEpisode }) {
  if (row.isExcluded)
    return (
      <Badge tone="red" className="w-fit">
        EXCLUDED
      </Badge>
    );
  return <QualityChip quality={row.effectiveQuality} />;
}

function transferBadge(row: DecoratedEpisode): { tone: Tone; label: string } {
  switch (row.transferSlot.phase) {
    case 'here':
      return { tone: 'green', label: 'transferred' };
    case 'transferring':
      // No % — rsync progress isn't observable through the pull channel.
      return { tone: 'amber', label: 'transferring…' };
    default:
      return { tone: 'gray', label: 'on robot' };
  }
}

// The row is a grid stretched to the card's full (fluid) width, but the data
// columns are fixed-width — without a flexible spacer track, the unused width
// past the last data column would sit inside the row element with no column
// of its own, and a click anywhere in it (e.g. dead-center of the row) would
// resolve to whichever adjacent column happens to be nearest, not "nothing".
// The `minmax(96px,1fr)` track absorbs that space so the trailing action column
// stays pinned to the right edge instead of floating mid-row. The 96px MINIMUM
// is load-bearing: this flexible track also HOLDS the right-aligned Status
// chip, and with `minmax(0,…)` a narrow card squeezed the track below the
// chip's width — the chip (nowrap, un-clipped by the grid) then slid left over
// the Data column. 96px covers the widest lane label (NEEDS CHECK), so the
// shared horizontal scroll (E-25) engages instead of an overlap.
// (Tailwind's arbitrary-value classes must appear as complete literal strings
// in the source for its scanner to pick them up — hence two full strings
// rather than building one via interpolation.)
const GRID_COLS = 'grid-cols-[56px_48px_108px_96px_72px_80px_96px_minmax(96px,1fr)_28px]';
const GRID_COLS_SPLIT =
  'grid-cols-[56px_48px_108px_96px_72px_80px_96px_84px_minmax(96px,1fr)_28px]';

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
      data-testid={`review-row-${row.captureId}`}
      data-capture-id={row.captureId}
      onClick={() => rv.select(row.captureId)}
      title={row.runId ?? row.captureId}
      className={cn(
        'grid cursor-pointer items-center gap-2 border-t border-gray-50 px-[18px] py-2 text-sm transition-colors first:border-t-0 hover:bg-gray-50',
        rv.splitMode ? GRID_COLS_SPLIT : GRID_COLS,
        isSelected && 'border-l-[3px] border-l-teal-600 bg-teal-50 pl-[15px]',
        row.isExcluded && 'bg-red-50 opacity-50',
      )}
    >
      <span className="font-mono text-[13px] font-semibold text-gray-900">
        {episodeLabel(row.ep)}
      </span>
      {row.batchId ? (
        <button
          type="button"
          data-testid={`review-batch-chip-${row.captureId}`}
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
      <AvailabilityChip
        capture={row.capture}
        testId={`review-availability-${row.captureId}`}
      />
      {rv.splitMode && (
        <Badge tone={transfer.tone} className="w-fit whitespace-nowrap">
          {transfer.label}
        </Badge>
      )}
      <span className="justify-self-end">
        <LaneChip lane={row.reviewLane} testId={`review-status-${row.captureId}`} />
      </span>
      <button
        type="button"
        data-testid={`review-exclude-${row.captureId}`}
        onClick={(e) => {
          e.stopPropagation();
          rv.requestExclude(row.captureId);
        }}
        title={
          row.isExcluded
            ? 'Return to review — the exclusion is a label, not a deletion'
            : 'Exclude from training use. The recording is kept and this can be undone.'
        }
        className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-gray-300 transition-colors hover:bg-amber-50 hover:text-amber-700"
      >
        {row.isExcluded ? (
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
        {rv.hasExcluded && (
          <button
            type="button"
            onClick={rv.toggleExcluded}
            className="rounded-control border border-gray-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray-500 transition-colors hover:bg-gray-50"
          >
            {rv.showExcluded ? 'Hide' : 'Show'} excluded ({rv.nExcluded})
          </button>
        )}
        {rv.hasExcluded && (
          <>
            <button
              type="button"
              data-testid="review-discard-excluded"
              onClick={() => rv.requestDiscard(rv.excludedRows.map((r) => r.captureId))}
              title={
                'Discard the excluded recordings: they were never uploaded and ' +
                'are not worth keeping. Irreversible, and a reason is required.'
              }
              className="rounded-control border border-red-300 bg-white px-3 py-1.5 text-[12.5px] font-bold text-red-700 transition-colors hover:bg-red-50"
            >
              Discard excluded ({rv.nExcluded})…
            </button>
            <button
              type="button"
              data-testid="review-delete-excluded"
              onClick={() => rv.requestDelete(rv.excludedRows.map((r) => r.captureId))}
              title={
                'Delete the excluded recordings from this machine. The catalog ' +
                'keeps a record of each one.'
              }
              className="rounded-control border border-gray-300 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
            >
              Delete excluded ({rv.nExcluded})…
            </button>
          </>
        )}
        {rv.splitMode && (
          <button
            type="button"
            data-testid="review-transfer-all"
            onClick={rv.transferAllAwaiting}
            disabled={rv.nAwaiting === 0}
            title={
              rv.nAwaiting === 0
                ? 'Every recording has reached this machine'
                : 'Pull every recording whose copy has not arrived yet'
            }
            className="rounded-control border border-gray-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray-500 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:border-gray-100 disabled:bg-gray-50 disabled:text-gray-300 disabled:hover:bg-gray-50"
          >
            Transfer pending ({rv.nAwaiting})
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
              title="Marks them unusable for training. The recordings are kept and this can be undone."
              className="rounded-control border border-amber-300 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-amber-700 transition-colors hover:bg-amber-50 disabled:cursor-not-allowed disabled:border-gray-100 disabled:text-gray-300 disabled:hover:bg-white"
            >
              Exclude batch — keeps files ({rv.batchExcludable.length})…
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
            {rv.returnBatchFailures.length > 0 && (
              // The return has no dialog to hold its result, and its toast is
              // gone in seconds — while the episodes that failed stay EXCLUDED,
              // which hides them from the default table. Without this the
              // operator's only evidence that the batch did not fully return
              // has already disappeared by the time they look.
              <span
                role="alert"
                data-testid="review-return-batch-failures"
                title={rv.returnBatchFailures
                  .map((f) => `${f.captureId}: ${f.error}`)
                  .join('\n')}
                className="rounded-chip bg-red-50 px-2 py-0.5 text-[12px] font-semibold text-red-700"
              >
                {rv.returnBatchFailures.length} still excluded — return failed
              </span>
            )}
          </>
        )}
        <input
          type="text"
          value={rv.search}
          onChange={(e) => rv.setSearch(e.target.value)}
          // The placeholder is not a name: it is gone the moment there is a
          // query, and a screen reader announces the field as "edit, blank".
          aria-label="Search episodes"
          placeholder="Search episodes…"
          data-testid="review-search"
          className="w-[150px] rounded-control border border-gray-200 px-2.5 py-1.5 text-[12.5px] text-gray-700 placeholder:text-gray-400"
        />
      </div>
      {/* The undo for the last exclude. It lives HERE, and not on the excluded
          row, because excluding a row removes it from the default view — the
          affordance would be behind "Show excluded", which is a hunt at exactly
          the moment the operator wants a mis-click back. Nor in the toast: that
          clears itself after a couple of seconds, and a recovery path with a
          countdown on it is not one. Same reasoning as the batch-return notice
          below, which is in this toolbar for the same reason. */}
      {rv.excludeUndo && (
        <div
          data-testid="review-exclude-undo"
          className="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-amber-50 px-[18px] py-2 text-[12.5px] text-amber-900"
        >
          <span>
            <span className="font-semibold">{rv.excludeUndo.subject}</span> excluded —
            the recording is kept.
          </span>
          <button
            type="button"
            data-testid="review-exclude-undo-btn"
            onClick={rv.undoExclude}
            title="Put back the status and quality this capture had before it was excluded"
            className="rounded-control border border-amber-300 bg-white px-2.5 py-1 text-[12px] font-bold text-amber-800 transition-colors hover:bg-amber-100"
          >
            <span aria-hidden>↶</span> Undo
          </button>
          <div className="flex-1" />
          <button
            type="button"
            data-testid="review-exclude-undo-dismiss"
            onClick={rv.dismissExcludeUndo}
            aria-label="Dismiss — the capture stays excluded"
            title="Dismiss — the capture stays excluded"
            className="rounded-control px-2 py-1 text-[12px] font-semibold text-amber-700 transition-colors hover:bg-amber-100"
          >
            <span aria-hidden>✕</span>
          </button>
        </div>
      )}
      {/* Exception-review: a good take costs zero clicks; you only look at the
          exceptions. */}
      <p
        data-testid="review-adopt-explainer"
        className="border-b border-gray-100 px-[18px] py-1.5 text-[11px] text-gray-400"
      >
        <span className="font-semibold text-teal-700">READY</span> episodes need no
        review — you only resolve the{' '}
        <span className="font-semibold text-amber-700">NEEDS CHECK</span> exceptions.
        Datasets take adopted episodes only: a take saved as a good success arrives
        adopted, and one still pending offers Adopt in its detail.
      </p>
      {/* E-25: header and rows share ONE horizontal scroll region.
          The column track sums to ~666px, but the screen's grid pins this card
          at its declared `minmax(580px, …)` minimum on a 1280-wide display — so
          the card's `overflow-hidden` was cutting the last columns off the
          HEADER with no mark, while the rows below scrolled independently. Both
          halves of that are wrong: the operator loses a column heading with
          nothing saying so, and scrolling the rows slides them out from under
          the headings that name them.
          Scrolling the two together keeps every column reachable and always
          labelled. Squeezing the tracks to fit instead would only move the
          silent cut inside the cells. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-x-auto">
        <div
          className={cn(
            'grid shrink-0 gap-2 border-b border-gray-100 px-[18px] py-2 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400',
            rv.splitMode ? GRID_COLS_SPLIT : GRID_COLS,
          )}
        >
          <span>Episode</span>
          <span>Batch</span>
          <span>Quality</span>
          <span>Task result</span>
          <span>Duration</span>
          <span>Time</span>
          <span>Data</span>
          {rv.splitMode && <span>Transfer</span>}
          <span className="justify-self-end">Status</span>
          <span />
        </div>
        <div className="flex-1 overflow-y-auto">
          {rv.isLoading ? (
            <p className="px-[18px] py-3 text-sm text-gray-500">Loading episodes…</p>
          ) : rv.isError ? (
            <p className="px-[18px] py-3 text-sm text-red-600" role="alert">
              Couldn&apos;t load recordings
              {rv.errorMessage ? `: ${rv.errorMessage}` : ''}.
            </p>
          ) : rv.rows.length === 0 ? (
            <p className="px-[18px] py-3 text-sm text-gray-500">
              No episodes to review yet.
            </p>
          ) : (
            rv.rows.map((row) => (
              <Row
                key={row.captureId}
                row={row}
                isSelected={row.captureId === rv.selectedCaptureId}
                rv={rv}
              />
            ))
          )}
          {/* The sweep stopped before the end of the catalog, so "no more
            episodes" here means "no more that were fetched" — and the counts
            above are of the same partial set. Said where the list ends,
            because that is where an operator concludes it. */}
          {rv.catalogTruncated && (
            <p
              data-testid="catalog-truncated"
              className="m-[18px] rounded-control border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-800"
            >
              This is not the whole catalog — there are more recordings than one sweep
              fetches, so the oldest are not listed here. Narrow the search to reach a
              specific one.
            </p>
          )}
        </div>
      </div>
      <p
        data-testid="review-bridge-caption"
        className="border-t border-gray-100 px-[18px] py-2 text-[11px] text-gray-400"
      >
        Quality / Task / Batch are saved on the capture itself. Data shows where this
        machine&apos;s copy stands.
      </p>
    </div>
  );
}
