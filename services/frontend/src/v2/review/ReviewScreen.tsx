// Review tab (v2 IA) — the episode take-review workflow (adopt / keep in
// review / exclude), plus a two-step physical delete: Exclude is a reversible
// review label (kept on disk); Delete permanently reclaims the storage. Root
// mirrors the design mock's 216px / 1fr / 400px three-column grid (filters,
// episode list, detail). Episodes come from the real /runs API; see
// useReviewState.ts for the full behavior.
//
// Also carries our own addition — MCAP transfer for split robot/recording-PC
// deployments — gated behind SPLIT_MODE (splitMode.ts), off by default.

import { useEffect, useRef } from 'react';
import { Button, Modal, cn } from '../../components/ui';
import { DetailPanel } from './DetailPanel';
import { EpisodeTable } from './EpisodeTable';
import { FiltersRail } from './FiltersRail';
import { Toast } from './Toast';
import { useFiltersCollapsed, toggleFiltersCollapsed } from './filtersRail';
import { formatBytes } from './format';
import { useReviewState } from './useReviewState';

// Two complete literal grid templates (Tailwind's scanner needs full strings,
// so we pick between them rather than interpolate a width). The two evidence
// columns grow with the viewport (the detail pane, weighted 1.2fr, gets the
// larger share — it was previously a fixed 400px); the table column keeps a
// hard 580px floor so its 8-column row grid never clips (56+48+108+96+72+80+28
// fixed tracks + 7×8px gaps + 36px padding). Collapsing the filter rail hands
// its 216→44px back to those two columns (detail again taking the larger cut).
const GRID_EXPANDED =
  'lg:grid-cols-[216px_minmax(580px,0.8fr)_minmax(400px,1.2fr)]';
const GRID_COLLAPSED =
  'lg:grid-cols-[44px_minmax(580px,0.8fr)_minmax(400px,1.2fr)]';

export function ReviewScreen() {
  const rv = useReviewState();
  const del = rv.pendingDeleteRow;
  const bulkTotalBytes = rv.excludedRows.reduce((sum, r) => sum + (r.bytes ?? 0), 0);

  // FiltersRail collapse (persisted). The collapsed and expanded toggle buttons
  // never mount at once, so after a user toggle we restore focus to whichever
  // one is now rendered (keyboard-flow: the toggle stays the focused control).
  const collapsed = useFiltersCollapsed();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const onToggleCollapsed = () => {
    restoreFocus.current = true;
    toggleFiltersCollapsed();
  };
  useEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    toggleRef.current?.focus();
  }, [collapsed]);

  return (
    <div className="flex flex-col gap-2.5 lg:h-full lg:min-h-0">
      {rv.showRetentionBanner && (
        <div
          role="status"
          data-testid="review-retention-banner"
          className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {rv.retentionFilterActive ? (
            <>
              <span data-testid="review-retention-message">
                Showing {rv.retentionCandidateCount} recording
                {rv.retentionCandidateCount === 1 ? '' : 's'} older than{' '}
                {rv.retentionDays} days (
                <span className="font-mono">{formatBytes(rv.retentionTotalBytes)}</span>
                ).
              </span>
              <Button
                variant="ghost"
                data-testid="review-retention-show-all"
                onClick={rv.clearRetentionFilter}
              >
                Show all
              </Button>
            </>
          ) : (
            <>
              <span data-testid="review-retention-message">
                {rv.retentionCandidateCount} recording
                {rv.retentionCandidateCount === 1 ? '' : 's'} older than{' '}
                {rv.retentionDays} days (
                <span className="font-mono">{formatBytes(rv.retentionTotalBytes)}</span>
                ) — review and delete what you no longer need.
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  data-testid="review-retention-review"
                  onClick={rv.applyRetentionFilter}
                >
                  Review these ({rv.retentionCandidateCount})
                </Button>
                <button
                  type="button"
                  aria-label="Dismiss retention notice"
                  data-testid="review-retention-dismiss"
                  className="rounded-control px-1.5 text-lg leading-none text-amber-700 hover:bg-amber-100"
                  onClick={rv.dismissRetentionBanner}
                >
                  &times;
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <div
        className={cn(
          'grid grid-cols-1 gap-2.5 lg:min-h-0 lg:flex-1 lg:grid-rows-[minmax(0,1fr)]',
          collapsed ? GRID_COLLAPSED : GRID_EXPANDED,
        )}
      >
        <FiltersRail
          ref={toggleRef}
          operatorOptions={rv.operatorOptions}
          operatorFilter={rv.operatorFilter}
          onOperatorChange={rv.setOperatorFilter}
          batchFilterLabel={rv.batchFilterLabel}
          onClearBatchFilter={() => rv.toggleBatchFilter(null)}
          onClearFilters={rv.clearFilters}
          collapsed={collapsed}
          onToggleCollapsed={onToggleCollapsed}
        />
        <EpisodeTable rv={rv} />
        <DetailPanel rv={rv} />
      </div>

      <Toast message={rv.toast} />

      <Modal
        open={rv.pendingArchiveEp !== null}
        onClose={rv.cancelArchive}
        title={`Exclude episode #${rv.pendingArchiveEp}?`}
        footer={
          <>
            <Button variant="ghost" onClick={rv.cancelArchive}>
              Cancel
            </Button>
            <Button
              variant="danger"
              data-testid="review-confirm-exclude"
              onClick={rv.confirmArchive}
            >
              Exclude
            </Button>
          </>
        }
      >
        The recording itself is kept and can be restored at any time. It&apos;s
        reclassified as Not usable / Excluded — episode numbers are never reassigned.
      </Modal>

      {/* Single physical delete — only reachable from an excluded episode. */}
      <Modal
        open={del !== null}
        onClose={rv.cancelDelete}
        title={`Delete episode #${del?.ep} from disk?`}
        footer={
          <>
            <Button variant="ghost" onClick={rv.cancelDelete} disabled={rv.deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={rv.confirmDelete} disabled={rv.deleting}>
              {rv.deleting ? 'Deleting…' : 'Delete from disk'}
            </Button>
          </>
        }
      >
        <p>
          Permanently delete{' '}
          <span data-testid="review-delete-runid" className="font-mono text-gray-800">
            {del?.runId}
          </span>{' '}
          (<span data-testid="review-delete-size">{formatBytes(del?.bytes)}</span>) from
          disk? This reclaims the storage and <strong>cannot be undone</strong>. The
          recording is already excluded from dataset use.
        </p>
        {rv.deleteError && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {rv.deleteError}
          </p>
        )}
      </Modal>

      {/* Bulk physical delete of every excluded episode. */}
      <Modal
        open={rv.bulkDeleteOpen}
        onClose={rv.cancelBulkDelete}
        title={`Delete ${rv.excludedRows.length} excluded recording${rv.excludedRows.length === 1 ? '' : 's'} from disk?`}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={rv.cancelBulkDelete}
              disabled={rv.bulkRunning}
            >
              {rv.bulkFailures.length > 0 && !rv.bulkRunning ? 'Close' : 'Cancel'}
            </Button>
            <Button
              variant="danger"
              onClick={rv.confirmBulkDelete}
              disabled={rv.bulkRunning || rv.excludedRows.length === 0}
            >
              {rv.bulkRunning
                ? `Deleting… (${rv.bulkDone}/${rv.excludedRows.length})`
                : `Delete ${rv.excludedRows.length}`}
            </Button>
          </>
        }
      >
        <p>
          Permanently delete these excluded recordings from disk — reclaiming{' '}
          <span className="font-mono text-gray-800">{formatBytes(bulkTotalBytes)}</span>
          . This <strong>cannot be undone</strong>.
        </p>
        <ul
          data-testid="review-bulk-list"
          className="mt-2 max-h-48 overflow-auto rounded-control border border-gray-200 text-xs"
        >
          {rv.excludedRows.map((r) => {
            const failure = rv.bulkFailures.find((f) => f.runId === r.runId);
            return (
              <li
                key={r.runId}
                className="flex items-center justify-between gap-2 border-t border-gray-100 px-2 py-1 first:border-t-0"
              >
                <span className="truncate font-mono text-gray-700">{r.runId}</span>
                {failure ? (
                  <span className="shrink-0 text-red-600" title={failure.error}>
                    failed
                  </span>
                ) : (
                  <span className="shrink-0 font-mono text-gray-400">
                    {formatBytes(r.bytes)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {rv.bulkFailures.length > 0 && !rv.bulkRunning && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {rv.bulkFailures.length} deletion{rv.bulkFailures.length === 1 ? '' : 's'}{' '}
            failed — those recordings are still on disk.
          </p>
        )}
      </Modal>

      {/* Batch-level bulk exclude (blast-radius follow-up): the same reversible
          semantics as the single-row Exclude, over every not-yet-excluded
          episode of the filtered batch. */}
      <Modal
        open={rv.excludeBatchOpen}
        onClose={rv.cancelExcludeBatch}
        title={`Exclude batch ${rv.batchFilterLabel ?? ''} — ${rv.batchExcludable.length} episode${rv.batchExcludable.length === 1 ? '' : 's'}?`}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={rv.cancelExcludeBatch}
              disabled={rv.excludeBatchRunning}
            >
              {rv.excludeBatchFailures.length > 0 && !rv.excludeBatchRunning
                ? 'Close'
                : 'Cancel'}
            </Button>
            <Button
              variant="danger"
              data-testid="review-exclude-batch-confirm"
              onClick={rv.confirmExcludeBatch}
              disabled={rv.excludeBatchRunning || rv.batchExcludable.length === 0}
            >
              {rv.excludeBatchRunning
                ? `Excluding… (${rv.excludeBatchDone}/${rv.batchExcludable.length})`
                : `Exclude ${rv.batchExcludable.length}`}
            </Button>
          </>
        }
      >
        <p>
          Marks every not-yet-excluded episode of this batch{' '}
          <strong>Not usable · Excluded</strong> — e.g. after a failed batch validation.
          The recordings are <strong>kept on disk</strong> and this is reversible (↺
          Return batch, or per episode).
        </p>
        <ul
          data-testid="review-exclude-batch-list"
          className="mt-2 max-h-48 overflow-auto rounded-control border border-gray-200 text-xs"
        >
          {rv.batchExcludable.map((r) => {
            const failure = rv.excludeBatchFailures.find((f) => f.runId === r.runId);
            return (
              <li
                key={r.runId}
                className="flex items-center justify-between gap-2 border-t border-gray-100 px-2 py-1 first:border-t-0"
              >
                <span className="truncate font-mono text-gray-700">
                  #{r.ep} · {r.runId}
                </span>
                {failure ? (
                  <span className="shrink-0 text-red-600" title={failure.error}>
                    failed
                  </span>
                ) : (
                  <span className="shrink-0 font-mono text-gray-400">
                    {r.reviewLane}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {rv.excludeBatchFailures.length > 0 && !rv.excludeBatchRunning && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {rv.excludeBatchFailures.length} exclude
            {rv.excludeBatchFailures.length === 1 ? '' : 's'} failed — those episodes
            keep their previous status.
          </p>
        )}
      </Modal>

      {/* Export ready → Datasets (exception-review: READY set, one click, MOVE). */}
      <Modal
        open={rv.exportReadyOpen}
        onClose={rv.cancelExportReady}
        title={`Export ${rv.readyExportable.length} ready recording${rv.readyExportable.length === 1 ? '' : 's'} to Datasets?`}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={rv.cancelExportReady}
              disabled={rv.exportRunning}
            >
              {rv.exportFailures.length > 0 && !rv.exportRunning ? 'Close' : 'Cancel'}
            </Button>
            <Button
              onClick={rv.confirmExportReady}
              disabled={rv.exportRunning || rv.readyExportable.length === 0}
            >
              {rv.exportRunning
                ? `Exporting… (${rv.exportDone}/${rv.readyExportable.length})`
                : `Export ${rv.readyExportable.length}`}
            </Button>
          </>
        }
      >
        <p>
          Export <strong>moves</strong> each READY recording into the dataset tree (
          <span className="font-mono text-gray-800">
            data/&lt;operator&gt;/&lt;task&gt;/NNN
          </span>
          ): it <strong>leaves Review</strong> and appears under Datasets.
          {!rv.includeFailed && ' Task-failed recordings are excluded (toggle above).'}
        </p>
        <ul
          data-testid="review-export-list"
          className="mt-2 max-h-48 overflow-auto rounded-control border border-gray-200 text-xs"
        >
          {rv.readyExportable.map((r) => {
            const failure = rv.exportFailures.find((f) => f.runId === r.runId);
            return (
              <li
                key={r.runId}
                className="flex items-center justify-between gap-2 border-t border-gray-100 px-2 py-1 first:border-t-0"
              >
                <span className="truncate font-mono text-gray-700">{r.runId}</span>
                <span
                  className={cn('shrink-0', failure ? 'text-red-600' : 'text-gray-400')}
                  title={failure?.error}
                >
                  {failure ? 'failed' : `#${r.ep}`}
                </span>
              </li>
            );
          })}
        </ul>
        {rv.readySkipped.length > 0 && (
          <div
            data-testid="review-export-skipped"
            className="mt-2 rounded-control border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800"
          >
            {rv.readySkipped.length} ready recording
            {rv.readySkipped.length === 1 ? '' : 's'} skipped — only{' '}
            <strong>completed</strong> runs can be exported:
            <ul className="mt-1 flex flex-col gap-0.5">
              {rv.readySkipped.map((r) => (
                <li key={r.runId} className="truncate font-mono">
                  #{r.ep} {r.runId} · {r.state}
                </li>
              ))}
            </ul>
          </div>
        )}
        {rv.exportFailures.length > 0 && !rv.exportRunning && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {rv.exportFailures.length} export{rv.exportFailures.length === 1 ? '' : 's'}{' '}
            failed — those recordings stayed in Review.
          </p>
        )}
      </Modal>
    </div>
  );
}
