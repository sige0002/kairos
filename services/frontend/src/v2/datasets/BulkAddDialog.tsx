// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Confirmation and receipt for adding the current candidate match set. The
// target IDs are snapshotted before this opens; a live refilter can therefore
// never change the write set underneath the operator.

import { Button, Modal } from '../../components/ui';
import { useTranslation } from 'react-i18next';
import { ErrorMessage } from '../../components/ErrorMessage';
import { shortCaptureId } from './data';
import type { DatasetsState } from './useDatasetsState';

export function BulkAddDialog({ state }: { state: DatasetsState }) {
  const { t } = useTranslation(['datasets', 'common']);
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
      title={t('datasets:addMatchingRecordings')}
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
              ? t('common:actions.close')
              : t('common:actions.cancel')}
          </Button>
          {finishedWithFailures || finishedWithReceiptFailure ? (
            <Button
              variant="primary"
              onClick={state.retryBulkAddFailures}
              data-testid="dataset-bulk-add-retry"
            >
              {finishedWithReceiptFailure
                ? retryableMemberFailures > 0
                  ? t('datasets:retryFailedAndReceipt', {
                      count: retryableMemberFailures,
                    })
                  : t('datasets:retryReceipt')
                : t('datasets:retryFailed', { count: retryableMemberFailures })}
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
                ? t('datasets:addingProgress', {
                    done: String(state.bulkAddDone),
                    total: String(state.bulkAddTotal),
                  })
                : finishedSuccessfully
                  ? t('common:actions.close')
                  : state.bulkAddCanRetryRequest
                    ? t('datasets:retryRequest')
                    : t('datasets:addRecordings', {
                        count: state.bulkAddTargetCount,
                        plural: state.bulkAddTargetCount === 1 ? '' : 's',
                      })}
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
            {t('datasets:bulkFreezing')}
          </p>
        )}
        <p className="text-[13px] leading-relaxed text-text-secondary">
          {t('datasets:bulkSummary', {
            count: state.bulkAddTargetCount,
            plural: state.bulkAddTargetCount === 1 ? '' : 's',
            dataset: state.bulkAddTargetDatasetName ?? t('datasets:selectedDataset'),
            state: state.bulkAddPreflighting
              ? t('datasets:bulkFreezingDetail')
              : t('datasets:bulkFrozenDetail'),
          })}
        </p>

        {state.bulkAddExpiresAt && (
          <p className="text-[12px] text-text-muted">
            {t('datasets:bulkExpires', { time: state.bulkAddExpiresAt })}
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
              {t('datasets:bulkEmpty')}
            </p>
          )}

        {state.bulkAddCatalogTruncated && (
          <p
            data-testid="dataset-bulk-add-truncated"
            className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12px] leading-relaxed text-status-warning-text"
          >
            {t('datasets:bulkTruncated')}
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
              {t('datasets:bulkProgress', {
                done: String(state.bulkAddDone),
                total: String(state.bulkAddTotal),
              })}
            </div>
          )}

        {finishedWithFailures && (
          <div
            role="alert"
            data-testid="dataset-bulk-add-failures"
            className="flex flex-col gap-1 rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12px] leading-relaxed text-status-warning-text"
          >
            <span className="font-semibold">
              {t('datasets:bulkJoined', {
                done: String(succeeded),
                total: String(state.bulkAddTotal),
                failed: String(state.bulkAddFailures.length),
              })}
            </span>
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {state.bulkAddFailures.map((failure) => (
                <span key={failure.captureId}>
                  <span className="font-mono">{shortCaptureId(failure.captureId)}</span>{' '}
                  — {failure.message}
                </span>
              ))}
            </div>
            <span>{t('datasets:additionsRemain')}</span>
          </div>
        )}
        {finishedSuccessfully && (
          <p
            data-testid="dataset-bulk-add-complete"
            className="rounded-control border border-status-success-border bg-status-success-bg px-3 py-2 text-[12px] leading-relaxed text-status-success-text"
          >
            {t('datasets:bulkComplete', { count: state.bulkAddDone })}
          </p>
        )}
        {finishedWithReceiptFailure && (
          <p
            role="alert"
            data-testid="dataset-bulk-add-receipt-failed"
            className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12px] leading-relaxed text-status-warning-text"
          >
            {retryableMemberFailures > 0
              ? t('datasets:receiptAndMembersFailed', {
                  count: retryableMemberFailures,
                })
              : t('datasets:receiptOnly')}
          </p>
        )}
        {finishedWithRunError && !state.bulkAddCanRetryRequest && (
          <p
            role="alert"
            className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12px] leading-relaxed text-status-warning-text"
          >
            {state.bulkAddSelectionExpired
              ? t('datasets:selectionExpired')
              : t('datasets:bulkStatusUnreadable')}
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
              {t('datasets:refreshSelection')}
            </Button>
          )}
        {state.bulkAddError != null && <ErrorMessage error={state.bulkAddError} />}
      </div>
    </Modal>
  );
}
