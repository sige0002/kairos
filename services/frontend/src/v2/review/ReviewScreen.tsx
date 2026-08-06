// Review tab (v2 IA) — the take-review workflow (adopt / keep in review /
// exclude) over captures, plus the two REMOVAL intents of §7, which are
// deliberately separate controls with separate dialogs: Exclude is a reversible
// review label that keeps the recording, Discard and Delete take the bytes away.
// Root mirrors the design mock's 216px / 1fr / 400px three-column grid.
//
// Also carries our own addition — MCAP transfer for split robot/recording-PC
// deployments — gated behind captures/splitMode.ts, off by default.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../api/queryKeys';
import { Button, Modal, cn } from '../../components/ui';
import { DiscardDialog, DeleteDialog } from '../captures/DeleteDialogs';
import { DetailPanel } from './DetailPanel';
import { EpisodeTable } from './EpisodeTable';
import { ImportBagsDialog } from './ImportBagsDialog';
import { FiltersRail } from './FiltersRail';
import { Toast } from './Toast';
import { useFiltersCollapsed, toggleFiltersCollapsed } from './filtersRail';
import { episodeLabel } from './types';
import { formatBytes } from './format';
import { useReviewState } from './useReviewState';

// Two complete literal grid templates (Tailwind's scanner needs full strings,
// so we pick between them rather than interpolate a width). The two evidence
// columns grow with the viewport (the detail pane, weighted 1.2fr, gets the
// larger share); the table column keeps a hard 580px floor so its row grid
// never clips. Collapsing the filter rail hands its 216→44px back to those two.
const GRID_EXPANDED =
  'lg:grid-cols-[216px_minmax(580px,0.8fr)_minmax(400px,1.2fr)]';
const GRID_COLLAPSED =
  'lg:grid-cols-[44px_minmax(580px,0.8fr)_minmax(400px,1.2fr)]';

export function ReviewScreen() {
  const rv = useReviewState();
  const { conflict, failure, failureCaptureId } = rv.reviewSave;
  const queryClient = useQueryClient();
  // Bringing in bags recorded outside kairos: a Review-side action because an
  // imported bag's whole reason to exist is to be reviewed, validated and
  // put into a dataset like any other recording.
  const [importOpen, setImportOpen] = useState(false);

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
      <div className="flex items-center gap-2.5">
        <div className="flex-1" />
        <button
          type="button"
          data-testid="review-import-bags"
          onClick={() => setImportOpen(true)}
          className="rounded-control border border-gray-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray-700 hover:bg-gray-50"
        >
          ↧ Import bags…
        </button>
      </div>
      <ImportBagsDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          // An import is QUEUED when the POST answers; the row appears only
          // once the staged copy has been moved into place, which for a
          // multi-GB bag is seconds to minutes later. Refetch now and a few
          // times after, so "I imported it and nothing showed up" needs no
          // manual reload. Bounded on purpose — this is a nudge, not a poll.
          const refetch = () =>
            void queryClient.invalidateQueries({ queryKey: queryKeys.captures });
          refetch();
          for (const delay of [3000, 10000, 30000]) setTimeout(refetch, delay);
        }}
      />
      {/* A refused save (409). The banner names what is actually stored now, so
          the operator re-applies their decision against the real current value
          instead of guessing what the other terminal chose. It also names the
          episode: only a save for that same capture supersedes it, so it
          outlives the selection and the filters, and a warning the operator
          cannot attribute to a capture is not one they can act on. */}
      {conflict && (
        <div
          role="alert"
          data-testid="review-conflict-banner"
          className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <span data-testid="review-conflict-message">
            <strong data-testid="review-conflict-subject">
              {rv.captureSubject(conflict.captureId)}
            </strong>
            {' — '}
            {conflict.reading.message} {conflict.reading.guidance}
            {conflict.current && (
              <>
                {' '}
                It is now{' '}
                <strong data-testid="review-conflict-current">
                  {conflict.current.review_status}
                  {conflict.current.quality ? ` · ${conflict.current.quality}` : ''}
                </strong>
                .
              </>
            )}
          </span>
          <Button
            variant="ghost"
            data-testid="review-conflict-dismiss"
            onClick={rv.reviewSave.dismissConflict}
          >
            Dismiss
          </Button>
        </div>
      )}

      {/* A save that wrote NOTHING (500). §12: never silent — the operator must
          not walk away believing a label exists that does not. */}
      {failure && (
        <div
          role="alert"
          data-testid="review-save-failure"
          data-error-code={failure.code}
          className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          <span>
            <strong>Not saved.</strong>{' '}
            {failureCaptureId && (
              <>
                <strong data-testid="review-save-failure-subject">
                  {rv.captureSubject(failureCaptureId)}
                </strong>
                {' — '}
              </>
            )}
            {failure.message} {failure.guidance}
          </span>
          <Button
            variant="ghost"
            data-testid="review-save-failure-dismiss"
            onClick={rv.reviewSave.dismissFailure}
          >
            Dismiss
          </Button>
        </div>
      )}

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
                ) — review and remove what you no longer need.
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
        open={rv.excludePending}
        onClose={rv.cancelExclude}
        title={`Exclude episode ${rv.pendingExcludeLabel ?? ''}?`}
        footer={
          <>
            <Button variant="ghost" onClick={rv.cancelExclude}>
              Cancel
            </Button>
            <Button
              variant="danger"
              data-testid="review-confirm-exclude"
              onClick={rv.confirmExclude}
            >
              Exclude
            </Button>
          </>
        }
      >
        The recording itself is kept and can be restored at any time. It&apos;s
        reclassified as Not usable / Excluded — episode numbers are never reassigned.
      </Modal>

      {/* The two removal intents (§12). Separate dialogs, separate testids:
          the operator must be able to tell which one they are about to do. */}
      <DiscardDialog
        open={rv.deletion.kind === 'discard'}
        captures={rv.deletion.targets}
        splitDeploy={rv.splitMode}
        busy={rv.deletion.busy}
        error={rv.deletion.error}
        done={rv.deletion.done}
        failures={rv.deletion.failures}
        onCancel={rv.deletion.cancel}
        onConfirm={(reason) => void rv.deletion.confirm(reason)}
      />
      <DeleteDialog
        open={rv.deletion.kind === 'delete'}
        captures={rv.deletion.targets}
        splitDeploy={rv.splitMode}
        busy={rv.deletion.busy}
        error={rv.deletion.error}
        done={rv.deletion.done}
        failures={rv.deletion.failures}
        onCancel={rv.deletion.cancel}
        onConfirm={(reason) => void rv.deletion.confirm(reason)}
      />

      {/* Batch-level bulk exclude: the same reversible semantics as the
          single-row Exclude, over every not-yet-excluded capture of the
          filtered batch. Nothing here removes bytes. */}
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
            const failure = rv.excludeBatchFailures.find(
              (f) => f.captureId === r.captureId,
            );
            return (
              <li
                key={r.captureId}
                className="flex items-center justify-between gap-2 border-t border-gray-100 px-2 py-1 first:border-t-0"
              >
                <span className="truncate font-mono text-gray-700">
                  {episodeLabel(r.ep)} · {r.runId ?? r.captureId}
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
    </div>
  );
}
