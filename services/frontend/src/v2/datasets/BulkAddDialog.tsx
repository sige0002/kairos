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
  const finishedWithRunError =
    !state.bulkAddBusy && state.bulkAddError != null && state.bulkAddDone > 0;
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
            {finishedWithFailures || finishedWithRunError ? 'Close' : 'Cancel'}
          </Button>
          {finishedWithFailures ? (
            <Button
              variant="primary"
              onClick={state.retryBulkAddFailures}
              data-testid="dataset-bulk-add-retry"
            >
              Retry {state.bulkAddFailures.length} failed
            </Button>
          ) : finishedWithRunError ? null : (
            <Button
              variant="primary"
              onClick={state.confirmBulkAdd}
              disabled={state.bulkAddBusy || state.bulkAddTargetCount === 0}
              data-testid="dataset-bulk-add-confirm"
            >
              {state.bulkAddBusy
                ? `Adding… ${state.bulkAddDone} / ${state.bulkAddTotal}`
                : `Add ${state.bulkAddTargetCount} recording${
                    state.bulkAddTargetCount === 1 ? '' : 's'
                  }`}
            </Button>
          )}
        </>
      }
    >
      <div data-testid="dataset-bulk-add-dialog" className="flex flex-col gap-3">
        <p className="text-[13px] leading-relaxed text-gray-600">
          Add{' '}
          <span className="font-semibold text-gray-900">
            {state.bulkAddTargetCount} matching recording
            {state.bulkAddTargetCount === 1 ? '' : 's'}
          </span>{' '}
          to{' '}
          <span className="font-semibold text-gray-900">
            {state.bulkAddTargetDatasetName ?? 'the selected dataset'}
          </span>
          . The match set is fixed now. Each recording receives its dataset number;
          nothing moves on disk.
        </p>

        {state.bulkAddCatalogTruncated && (
          <p
            data-testid="dataset-bulk-add-truncated"
            className="rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900"
          >
            This adds every matching recording loaded in this catalog sweep. Older
            recordings may exist beyond the sweep limit and are not included.
          </p>
        )}

        {(state.bulkAddBusy || state.bulkAddDone > 0) && !finishedWithFailures && (
          <div
            aria-live="polite"
            data-testid="dataset-bulk-add-progress"
            className="rounded-control border border-teal-200 bg-teal-50 px-3 py-2 text-[12px] text-teal-900"
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
            className="flex flex-col gap-1 rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900"
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
        {finishedWithRunError && (
          <p
            role="alert"
            className="rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900"
          >
            The add requests finished, but the catalog could not be refreshed. Close
            this dialog and reload the screen before trying again; repeating this set
            now could submit recordings that already joined.
          </p>
        )}
        {state.bulkAddError != null && <ErrorMessage error={state.bulkAddError} />}
      </div>
    </Modal>
  );
}
