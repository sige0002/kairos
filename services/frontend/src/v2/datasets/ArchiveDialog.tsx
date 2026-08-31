// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Archive one capture to an allow-listed path (§6). This is the only control on
// the screen that moves data OFF this machine, so the dialog's job is to make
// the consequence unmissable before it starts:
//
//   copy -> verify (sha256) -> then remove from this machine
//
// The run executes SERVER-SIDE (202 + progress poll, S2-1): a multi-GB copy
// outlives any proxy timeout, so waiting on the request reported "failed" for
// archives the server completed — and then deleted the source of. The dialog
// shows the copy's live progress and stays open until the run ends.
//
// The destination is not free text: the deployment configures the roots
// (KAIROS_ARCHIVE_ROOTS) and the operator picks a subpath under one. That is a
// safety boundary, so it is shown as a boundary — a root you choose from plus a
// path you type, with BOTH the destination that is sent and the directory the
// files actually land in echoed back, because the server appends the capture id
// under the destination and guessing which of the two is meant is how an archive
// lands one level off.
//
// If the deployment configured no roots the dialog never opens (the button that
// opens it is not rendered) — don't advertise what can't run.

import { Button, Modal } from '../../components/ui';
import { useTranslation } from 'react-i18next';
import { ArchiveError } from './ArchiveError';
import { shortCaptureId } from './data';
import type { DatasetsState } from './useDatasetsState';

export function ArchiveDialog({ state }: { state: DatasetsState }) {
  const { t } = useTranslation(['datasets', 'common']);
  const { archiveTarget, archiveRoots, archiveDestination, archiveFinalPath } = state;
  const name = archiveTarget
    ? (archiveTarget.run_id ?? shortCaptureId(archiveTarget.capture_id))
    : '';

  return (
    <Modal
      open={archiveTarget !== null}
      onClose={state.cancelArchive}
      title={t('datasets:archiveRecording')}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={state.cancelArchive}
            disabled={state.archiving}
            data-testid="archive-cancel"
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={state.confirmArchive}
            disabled={state.archiving || archiveDestination === ''}
            data-testid="archive-confirm"
          >
            {state.archiving ? t('datasets:archiving') : t('datasets:copyVerifyRemove')}
          </Button>
        </>
      }
    >
      <div data-testid="archive-dialog" className="flex flex-col gap-3">
        <p className="text-[13px] leading-relaxed text-text-secondary">
          {t('datasets:archiveExplanation', { name })}
        </p>

        {state.archiving && state.archiveProgress && (
          <p
            data-testid="archive-progress"
            className="font-mono text-[12px] text-text-secondary"
          >
            {t('datasets:copyingProgress', {
              done: (state.archiveProgress.done / 1_000_000).toFixed(0),
              total:
                state.archiveProgress.total != null
                  ? ` / ${(state.archiveProgress.total / 1_000_000).toFixed(0)}`
                  : '',
            })}
          </p>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
            {t('datasets:archiveRoot')}
          </span>
          {archiveRoots.length > 1 ? (
            <select
              data-testid="archive-root"
              value={state.archiveRoot}
              onChange={(e) => state.setArchiveRoot(e.target.value)}
              className="rounded-control border border-border bg-surface px-2 py-1.5 text-[12.5px] text-text-primary"
            >
              {archiveRoots.map((root) => (
                <option key={root} value={root}>
                  {root}
                </option>
              ))}
            </select>
          ) : (
            <span
              data-testid="archive-root"
              className="rounded-control border border-border bg-surface-muted px-2 py-1.5 font-mono text-[12px] text-text-secondary"
            >
              {state.archiveRoot}
            </span>
          )}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
            {t('datasets:pathUnderRoot')}
          </span>
          <input
            data-testid="archive-subpath"
            value={state.archiveSubpath}
            onChange={(e) => state.setArchiveSubpath(e.target.value)}
            spellCheck={false}
            className="rounded-control border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-text-primary"
          />
          <span className="text-[11px] text-text-muted">
            {t('datasets:archivePathHint')}
          </span>
        </label>

        <div className="flex flex-col gap-1 rounded-[10px] border border-border bg-surface-muted px-3 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
            {t('datasets:destination')}
          </span>
          <span
            data-testid="archive-destination"
            className="break-all font-mono text-[12px] text-text-primary"
          >
            {archiveDestination || '—'}
          </span>
          <span className="text-[11px] text-text-muted">
            {t('datasets:destination')}:{' '}
            <span
              data-testid="archive-final-path"
              className="break-all font-mono text-text-primary"
            >
              {archiveFinalPath || '—'}
            </span>{' '}
            — {t('datasets:captureIdAppended')}
          </span>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
            {t('datasets:reason')}{' '}
            <span className="font-normal normal-case text-text-muted">
              ({t('datasets:optional')})
            </span>
          </span>
          <input
            data-testid="archive-reason"
            value={state.archiveReason}
            onChange={(e) => state.setArchiveReason(e.target.value)}
            placeholder={t('datasets:archiveReasonPlaceholder')}
            className="rounded-control border border-border bg-surface px-2 py-1.5 text-[12.5px] text-text-primary"
          />
        </label>

        <ArchiveError
          error={state.archiveError}
          testIdPrefix="archive-error"
          resolveDatasetName={state.datasetName}
        />
      </div>
    </Modal>
  );
}
