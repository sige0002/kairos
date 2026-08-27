// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
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
const GRID_COLS =
  'grid-cols-[56px_48px_108px_96px_72px_80px_96px_minmax(96px,1fr)_28px]';
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
        'grid cursor-pointer items-center gap-2 border-t border-border px-[18px] py-2 text-sm transition-colors first:border-t-0 hover:bg-surface-muted',
        rv.splitMode ? GRID_COLS_SPLIT : GRID_COLS,
        isSelected && 'border-l-[3px] border-l-accent bg-interaction-selected pl-[15px]',
        row.isExcluded && 'bg-status-danger-bg opacity-90',
      )}
    >
      <span className="font-mono text-[13px] font-semibold text-text-primary">
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
              ? 'bg-interaction-selected font-semibold text-accent'
              : 'text-text-secondary hover:bg-surface-muted hover:text-text-primary',
          )}
        >
          {row.batch}
        </button>
      ) : (
        <span className="font-mono text-[12.5px] text-text-secondary">{row.batch}</span>
      )}
      <QualityCell row={row} />
      <TaskResultChip task={row.effectiveTask} reason={row.failReason} />
      <span className="font-mono text-xs text-text-secondary">
        {formatHms(row.durationMs)}
      </span>
      <span className="font-mono text-xs text-text-secondary">
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
        className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-text-secondary transition-colors hover:bg-status-warning-bg hover:text-status-warning-text"
      >
        {row.isExcluded ? (
          <span className="text-sm text-accent">↺</span>
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
    <div className="flex min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-[18px] py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-secondary">
          Episodes
        </h2>
        <span
          data-testid="review-episodes-count"
          className="font-mono text-xs text-text-secondary"
        >
          {rv.rows.length} shown
        </span>
        {rv.rows.length > 0 && (
          <>
            <span
              data-testid="review-lane-tally"
              className="rounded-chip bg-surface-muted px-2 py-0.5 font-mono text-[11px] text-text-secondary"
            >
              {nReady} ready · {nCheck} needs check · {nExcluded} excluded
            </span>
            <span
              data-testid="review-task-tally"
              className="rounded-chip bg-surface-muted px-2 py-0.5 font-mono text-[11px] text-text-secondary"
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
            className="rounded-control border border-border bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-text-secondary transition-colors hover:bg-surface-muted"
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
              className="rounded-control border border-status-danger-border bg-surface px-3 py-1.5 text-[12.5px] font-bold text-status-danger-text transition-colors hover:bg-status-danger-bg"
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
              className="rounded-control border border-border-strong bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-text-primary transition-colors hover:bg-surface-muted"
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
            className="rounded-control border border-border bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-text-secondary transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-muted disabled:text-text-muted disabled:hover:bg-surface-muted"
          >
            Transfer pending ({rv.nAwaiting})
          </button>
        )}
        {rv.batchFilter && (
          <>
            <span
              data-testid="review-batch-filter-chip"
              className="rounded-chip bg-interaction-selected px-2 py-0.5 font-mono text-[11px] font-semibold text-accent"
            >
              Batch {rv.batchFilterLabel}
            </span>
            <button
              type="button"
              data-testid="review-exclude-batch"
              onClick={rv.requestExcludeBatch}
              disabled={rv.batchExcludable.length === 0}
              title="Marks them unusable for training. The recordings are kept and this can be undone."
              className="rounded-control border border-status-warning-border bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-status-warning-text transition-colors hover:bg-status-warning-bg disabled:cursor-not-allowed disabled:border-border disabled:text-text-muted disabled:hover:bg-surface"
            >
              Exclude batch — keeps files ({rv.batchExcludable.length})…
            </button>
            {rv.batchExcluded.length > 0 && (
              <button
                type="button"
                data-testid="review-return-batch"
                onClick={rv.returnBatchToReview}
                title="Return every excluded episode of this batch to review (pending)"
                className="rounded-control border border-border bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-text-secondary transition-colors hover:bg-surface-muted"
              >
                ↺ Return batch ({rv.batchExcluded.length})
              </button>
            )}
            <button
              type="button"
              data-testid="review-batch-filter-clear"
              onClick={() => rv.toggleBatchFilter(null)}
              title="Show all batches"
              className="rounded-control border border-border bg-surface px-2 py-1.5 text-[12.5px] font-semibold text-text-secondary hover:bg-surface-muted"
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
                className="rounded-chip bg-status-danger-bg px-2 py-0.5 text-[12px] font-semibold text-status-danger-text"
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
          className="w-[150px] rounded-control border border-border px-2.5 py-1.5 text-[12.5px] text-text-primary placeholder:text-text-secondary"
        />
      </div>
      {/* The undo for the last exclude — its own band under the toolbar, not an
          affordance on the excluded row: excluding a row removes it from the
          default view, so the button would be behind "Show excluded" at exactly
          the moment the operator wants a mis-click back. Nor in the toast, which
          clears itself after a couple of seconds; a recovery path with a
          countdown on it is not one. Same reasoning as the batch-return notice
          in the toolbar above, which is persistent for the same reason.

          `role="status"`: this is the durable half of the announcement, and a
          keyboard operator who hears the exclude has to be able to find the way
          back. Polite, not alert — nothing here is urgent, and the toast has
          already said what happened. */}
      {rv.excludeUndo && (
        <div
          role="status"
          data-testid="review-exclude-undo"
          className="flex flex-wrap items-center gap-2 border-b border-border bg-status-warning-bg px-[18px] py-2 text-[12.5px] text-status-warning-text"
        >
          <span>
            <span className="font-semibold">{rv.excludeUndo.subject}</span> excluded —
            the recording is kept.
          </span>
          <button
            type="button"
            data-testid="review-exclude-undo-btn"
            onClick={rv.undoExclude}
            // Carries its subject: the sibling span naming the episode is not
            // associated with the button, so on its own this reads as one of
            // however many "Undo"s a screen reader has collected.
            aria-label={`Undo excluding ${rv.excludeUndo.subject}`}
            title="Put back the status and quality this capture had before it was excluded"
            className="rounded-control border border-status-warning-border bg-surface px-2.5 py-1 text-[12px] font-bold text-status-warning-text transition-colors hover:bg-status-warning-bg"
          >
            <span aria-hidden>↶</span> Undo
          </button>
          <div className="flex-1" />
          <button
            type="button"
            data-testid="review-exclude-undo-dismiss"
            onClick={rv.dismissExcludeUndo}
            aria-label={`Dismiss — ${rv.excludeUndo.subject} stays excluded`}
            title="Dismiss — the capture stays excluded"
            className="rounded-control px-2 py-1 text-[12px] font-semibold text-status-warning-text transition-colors hover:bg-status-warning-bg"
          >
            <span aria-hidden>✕</span>
          </button>
        </div>
      )}
      {/* Exception-review: a good take costs zero clicks; you only look at the
          exceptions. */}
      <p
        data-testid="review-adopt-explainer"
        className="border-b border-border px-[18px] py-1.5 text-[11px] text-text-secondary"
      >
        <span className="font-semibold text-accent">READY</span> episodes need no
        review — you only resolve the{' '}
        <span className="font-semibold text-status-warning-text">NEEDS CHECK</span> exceptions.
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
            'grid shrink-0 gap-2 border-b border-border px-[18px] py-2 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-text-secondary',
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
            <p className="px-[18px] py-3 text-sm text-text-secondary">Loading episodes…</p>
          ) : rv.isError ? (
            <p className="px-[18px] py-3 text-sm text-status-danger-text" role="alert">
              Couldn&apos;t load recordings
              {rv.errorMessage ? `: ${rv.errorMessage}` : ''}.
            </p>
          ) : rv.rows.length === 0 ? (
            <p className="px-[18px] py-3 text-sm text-text-secondary">
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
          {/* The bounded server page has a successor. Said where this page
            ends, because that is where an operator otherwise concludes that
            the visible rows are the whole filtered result. */}
          {rv.catalogTruncated && (
            <p
              data-testid="catalog-truncated"
              className="m-[18px] rounded-control border border-status-warning-border bg-status-warning-bg px-2.5 py-2 text-[11px] leading-relaxed text-status-warning-text"
            >
              This page is not the whole catalog; more recordings match this search. The
              counts and bulk actions above cover this page only; use Next to continue.
            </p>
          )}
        </div>
      </div>
      <p
        data-testid="review-bridge-caption"
        className="border-t border-border px-[18px] py-2 text-[11px] text-text-secondary"
      >
        Quality / Task / Batch are saved on the capture itself. Data shows where this
        machine&apos;s copy stands.
      </p>
    </div>
  );
}
