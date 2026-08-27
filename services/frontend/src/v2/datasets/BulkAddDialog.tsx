// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Confirmation and receipt for adding the current candidate match set. The
// target IDs are snapshotted before this opens; a live refilter can therefore
// never change the write set underneath the operator.

import { Button, Modal } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import { shortCaptureId } from './data';
import type { DatasetsState } from './useDatasetsState';

export function BulkAddDialog({ state }: { state: DatasetsState }) {
  const finishedWithFailures =
    !state.bulkAddBusy && state.bulkAddFailures.length > 0 && state.bulkAddTotal > 0;
  const finishedWithRunError = !state.bulkAddBusy && state.bulkAddError != null;
  const finishedSuccessfully =
    state.bulkAddTerminal &&
    !state.bulkAddBusy &&
    state.bulkAddTotal > 0 &&
    state.bulkAddDone === state.bulkAddTotal &&
    state.bulkAddFailures.length === 0;
  const finishedWithReceiptFailure =
    state.bulkAddTerminal && !state.bulkAddBusy && state.bulkAddReceiptFailed;
  const retryableMemberFailures = state.bulkAddFailures.length;
  const succeeded = state.bulkAddDone - state.bulkAddFailures.length;

  return (
    <Modal
      open={state.bulkAddOpen}
      onClose={state.cancelBulkAdd}
      title="Add matching recordings"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={state.cancelBulkAdd}
            disabled={state.bulkAddBusy}
            data-testid="dataset-bulk-add-cancel"
          >
            {finishedWithFailures ||
            finishedWithRunError ||
            finishedSuccessfully ||
            finishedWithReceiptFailure
              ? 'Close'
              : 'Cancel'}
          </Button>
          {finishedWithFailures || finishedWithReceiptFailure ? (
            <Button
              variant="primary"
              onClick={state.retryBulkAddFailures}
              data-testid="dataset-bulk-add-retry"
            >
              {finishedWithReceiptFailure
                ? retryableMemberFailures > 0
                  ? `Retry ${retryableMemberFailures} failed and receipt`
                  : 'Retry receipt'
                : `Retry ${retryableMemberFailures} failed`}
            </Button>
          ) : finishedWithRunError && !state.bulkAddCanRetryRequest ? null : (
            <Button
              variant="primary"
              onClick={state.confirmBulkAdd}
              disabled={
                state.bulkAddBusy ||
                state.bulkAddPreflighting ||
                state.bulkAddTargetCount === 0
              }
              data-testid="dataset-bulk-add-confirm"
            >
              {state.bulkAddBusy
                ? `Adding… ${state.bulkAddDone} / ${state.bulkAddTotal}`
                : finishedSuccessfully
                  ? 'Close'
                  : state.bulkAddCanRetryRequest
                    ? 'Retry request'
                    : `Add ${state.bulkAddTargetCount} recording${
                        state.bulkAddTargetCount === 1 ? '' : 's'
                      }`}
            </Button>
          )}
        </>
      }
    >
      <div data-testid="dataset-bulk-add-dialog" className="flex flex-col gap-3">
        {state.bulkAddPreflighting && (
          <p
            data-testid="dataset-bulk-add-preflighting"
            className="rounded-control border border-border bg-surface-muted px-3 py-2 text-[12px] text-text-primary"
          >
            Freezing the server match set… no recording will be added until you confirm
            it.
          </p>
        )}
        <p className="text-[13px] leading-relaxed text-text-secondary">
          Add{' '}
          <span className="font-semibold text-text-primary">
            {state.bulkAddTargetCount} matching recording
            {state.bulkAddTargetCount === 1 ? '' : 's'}
          </span>{' '}
          to{' '}
          <span className="font-semibold text-text-primary">
            {state.bulkAddTargetDatasetName ?? 'the selected dataset'}
          </span>
          .{' '}
          {state.bulkAddPreflighting
            ? 'The server is freezing the match set before it adds anything.'
            : 'This server match set is frozen until it expires. Confirm to start adding.'}{' '}
          Each recording receives its dataset number; nothing moves on disk.
        </p>

        {state.bulkAddExpiresAt && (
          <p className="text-[12px] text-text-muted">
            Server snapshot expires at {state.bulkAddExpiresAt}. Refresh it before
            confirming if it expires.
          </p>
        )}

        {!state.bulkAddPreflighting &&
          state.bulkAddExpiresAt &&
          state.bulkAddTargetCount === 0 &&
          !state.bulkAddBusy && (
            <p
              data-testid="dataset-bulk-add-empty-selection"
              className="rounded-control border border-border bg-surface-muted px-3 py-2 text-[12px] leading-relaxed text-text-primary"
            >
              Nothing eligible matched this server selection. No membership run can be
              started.
            </p>
          )}

        {state.bulkAddCatalogTruncated && (
          <p
            data-testid="dataset-bulk-add-truncated"
            className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12px] leading-relaxed text-status-warning-text"
          >
            This adds every matching recording loaded in this catalog sweep. Older
            recordings may exist beyond the sweep limit and are not included.
          </p>
        )}

        {(state.bulkAddBusy || state.bulkAddDone > 0) &&
          !finishedWithFailures &&
          !finishedSuccessfully && (
            <div
              aria-live="polite"
              data-testid="dataset-bulk-add-progress"
              className="rounded-control border border-accent bg-interaction-selected px-3 py-2 text-[12px] text-accent-strong"
            >
              {state.bulkAddDone} / {state.bulkAddTotal} processed. Additions are
              committed one at a time, so this run cannot be canceled safely once it
              starts.
            </div>
          )}

        {finishedWithFailures && (
          <div
            role="alert"
            data-testid="dataset-bulk-add-failures"
            className="flex flex-col gap-1 rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12px] leading-relaxed text-status-warning-text"
          >
            <span className="font-semibold">
              {succeeded} of {state.bulkAddTotal} joined; {state.bulkAddFailures.length}{' '}
              did not:
            </span>
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {state.bulkAddFailures.map((failure) => (
                <span key={failure.captureId}>
                  <span className="font-mono">{shortCaptureId(failure.captureId)}</span>{' '}
                  — {failure.message}
                </span>
              ))}
            </div>
            <span>The successful additions remain in the dataset.</span>
          </div>
        )}
        {finishedSuccessfully && (
          <p
            data-testid="dataset-bulk-add-complete"
            className="rounded-control border border-status-success-border bg-status-success-bg px-3 py-2 text-[12px] leading-relaxed text-status-success-text"
          >
            {state.bulkAddDone} recordings joined. The server saved this run; nothing
            moved on disk.
          </p>
        )}
        {finishedWithReceiptFailure && (
          <p
            role="alert"
            data-testid="dataset-bulk-add-receipt-failed"
            className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12px] leading-relaxed text-status-warning-text"
          >
            {retryableMemberFailures > 0
              ? `The provenance receipt was not saved, and ${retryableMemberFailures} membership addition${retryableMemberFailures === 1 ? '' : 's'} failed. Retrying re-attempts only those failed additions, then records the receipt; successful additions stay durable.`
              : 'Members are durable, but the provenance receipt was not saved. Retrying records the receipt only; do not submit a new member add.'}
          </p>
        )}
        {finishedWithRunError && !state.bulkAddCanRetryRequest && (
          <p
            role="alert"
            className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12px] leading-relaxed text-status-warning-text"
          >
            {state.bulkAddSelectionExpired
              ? 'The frozen server selection expired before the run started. Refresh it, review its current count, then confirm again.'
              : 'The run status could not be read. Close this dialog and reload the screen before trying again.'}
          </p>
        )}
        {finishedWithRunError &&
          state.bulkAddSelectionExpired &&
          !state.bulkAddBusy && (
            <Button
              variant="ghost"
              onClick={state.refreshBulkAddSelection}
              data-testid="dataset-bulk-add-refresh-selection"
            >
              Refresh selection
            </Button>
          )}
        {state.bulkAddError != null && <ErrorMessage error={state.bulkAddError} />}
      </div>
    </Modal>
  );
}
