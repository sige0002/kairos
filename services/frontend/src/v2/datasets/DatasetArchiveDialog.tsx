// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Archive the WHOLE selected dataset to an allow-listed path (§6.x) — the
// dataset's terminal transition, and the only control on the screen that both
// moves data off this machine and freezes what it leaves behind:
//
//   freeze the member set -> copy each member -> verify (sha256) -> remove it
//   -> seal the run with a manifest whose hash goes into the ledger
//
// Unlike the per-capture ArchiveDialog this IS a long-running run, so the same
// dialog has two faces: the confirmation (destination + consequence) before the
// 202, and the progress view (n of m, the member being copied, any halt) after
// it. A halt is not a failure state to dismiss — the run stays `archiving` and
// the Resume button continues it from the ledger's own record of what is done.
//
// Deliberately NOT shared with ArchiveDialog (the DeleteDialogs.tsx rule): the
// operator must be able to tell, from the dialog alone, that this one takes a
// whole dataset with it.
//
// The destination follows the same boundary presentation: a root you choose, a
// path you type, and BOTH the destination that is sent and the directory the
// dataset actually lands in echoed back — the server appends
// <operator>/<task>/<name> itself, and guessing is how an archive lands one
// level off. No roots configured -> the button that opens this never renders.

import { Badge, Button, Modal } from '../../components/ui';
import { readCaptureCode } from '../captures/errors';
import { ArchiveError } from './ArchiveError';
import { formatBytes, memberCount, shortCaptureId } from './data';
import { DatasetGoneNote } from './SelectionGone';
import type { DatasetsState } from './useDatasetsState';

function ModeRadio({ state }: { state: DatasetsState }) {
  const shared = state.datasetArchiveSharedCount;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
        What happens to the recordings here
      </span>
      <label className="flex cursor-pointer items-start gap-2 rounded-[10px] border border-border px-3 py-2">
        <input
          type="radio"
          name="dataset-archive-mode"
          data-testid="dataset-archive-mode-copy"
          checked={state.datasetArchiveMode === 'copy'}
          onChange={() => state.setDatasetArchiveMode('copy')}
        />
        <span className="text-[12.5px] leading-snug text-text-primary">
          <span className="font-semibold text-text-primary">Copy out — keep them.</span>{' '}
          The dataset is sealed as a record of the export; every recording stays
          here and other datasets keep working. The pick for a combined set.
        </span>
      </label>
      <label className="flex cursor-pointer items-start gap-2 rounded-[10px] border border-border px-3 py-2">
        <input
          type="radio"
          name="dataset-archive-mode"
          data-testid="dataset-archive-mode-move"
          checked={state.datasetArchiveMode === 'move'}
          onChange={() => state.setDatasetArchiveMode('move')}
        />
        <span className="text-[12.5px] leading-snug text-text-primary">
          <span className="font-semibold text-text-primary">
            Move out — remove them.
          </span>{' '}
          Each verified recording is deleted from this machine; the disk space
          comes back. Needs members no other dataset cites.
        </span>
      </label>
      {shared > 0 && (
        <span
          data-testid="dataset-archive-shared-note"
          className="text-[11px] leading-relaxed text-status-warning-text"
        >
          {shared} member{shared === 1 ? '' : 's'} also belong to another active
          dataset, so a Move would be refused with the list — Copy is the one
          that can succeed as-is.
        </span>
      )}
    </div>
  );
}

function ConfirmBody({ state }: { state: DatasetsState }) {
  const row = state.selectedDataset;
  const bytes = row ? row.aggregate.bytes : null;
  const copying = state.datasetArchiveMode === 'copy';

  return (
    <div className="flex flex-col gap-3">
      <p className="break-words text-[13px] leading-relaxed text-text-secondary">
        {/* With no row in view (an external status change can take it off this
            shelf mid-dialog) there is no member count to state — "0 members"
            would be a number nothing measured. */}
        {row ? (
          <>
            <span className="font-semibold text-text-primary">{row.dataset.name}</span> —{' '}
            {memberCount(row.dataset.member_count)}
          </>
        ) : (
          <span className="break-all font-mono text-text-primary">
            {state.selectedDatasetId}
          </span>
        )}
        {bytes?.total ? <>, about {formatBytes(bytes.total)}</> : null} — is copied
        to the destination as numbered folders plus a manifest, and every file is
        verified (SHA-256).{' '}
        <span className="font-semibold text-text-primary">
          {copying
            ? 'The recordings stay on this machine; the dataset becomes a sealed, read-only record of the export.'
            : 'Each recording that verifies is then removed from this machine, and the dataset becomes read-only for good.'}
        </span>{' '}
        The catalog keeps the dataset and records where it went.
      </p>

      <ModeRadio state={state} />

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          Archive root
        </span>
        {state.archiveRoots.length > 1 ? (
          <select
            data-testid="dataset-archive-root"
            value={state.datasetArchiveRoot}
            onChange={(e) => state.setDatasetArchiveRoot(e.target.value)}
            className="rounded-control border border-border bg-surface px-2 py-1.5 text-[12.5px] text-text-primary"
          >
            {state.archiveRoots.map((root) => (
              <option key={root} value={root}>
                {root}
              </option>
            ))}
          </select>
        ) : (
          <span
            data-testid="dataset-archive-root"
            className="rounded-control border border-border bg-surface-muted px-2 py-1.5 font-mono text-[12px] text-text-secondary"
          >
            {state.datasetArchiveRoot}
          </span>
        )}
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          Path under the root
        </span>
        <input
          data-testid="dataset-archive-path"
          value={state.datasetArchivePath}
          onChange={(e) => state.setDatasetArchivePath(e.target.value)}
          spellCheck={false}
          className="rounded-control border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-text-primary"
        />
        <span className="text-[11px] text-text-muted">
          Yours to rename — the last folder is the dataset's. Prefilled with the
          views shape; a path that already holds files is refused, so two
          exports cannot land on each other.
        </span>
      </label>

      <div className="flex flex-col gap-1 rounded-[10px] border border-border bg-surface-muted px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          Destination
        </span>
        <span
          data-testid="dataset-archive-destination"
          className="break-all font-mono text-[12px] text-text-primary"
        >
          {state.datasetArchiveDestination || '—'}
        </span>
        <span className="text-[11px] text-text-muted">
          The dataset lands in{' '}
          <span
            data-testid="dataset-archive-final-path"
            className="break-all font-mono text-text-primary"
          >
            {state.datasetArchiveFinalDir || '—'}
          </span>
          .
        </span>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          Reason <span className="font-normal normal-case text-text-muted">(optional)</span>
        </span>
        <input
          data-testid="dataset-archive-reason"
          value={state.datasetArchiveReason}
          onChange={(e) => state.setDatasetArchiveReason(e.target.value)}
          placeholder="e.g. training set handed off for cloud training"
          className="rounded-control border border-border bg-surface px-2 py-1.5 text-[12.5px] text-text-primary"
        />
      </label>

      <ArchiveError
        error={state.datasetArchiveStartError}
        testIdPrefix="dataset-archive-error"
        resolveDatasetName={state.datasetName}
      />
    </div>
  );
}

function ProgressBody({ state }: { state: DatasetsState }) {
  const progress = state.datasetArchiveProgress;
  // Halted = the run is NOT running (and we are not mid-resume) — the same
  // definition the Resume button below uses. This used to also require an
  // error, so a run stopped by an orchestrator restart (no error recorded)
  // wore a teal "archiving" badge for hours next to a Resume button that knew
  // better (S3-8/D5). A copy that is not copying is halted, error or not.
  const halted =
    progress != null && !progress.running && !state.datasetArchiveStarting;
  const cancellationRecorded = progress?.cancel_blocker === 'archive_canceled';
  const haltGuidance = readCaptureCode(
    progress?.error?.code,
    progress?.error?.message,
  ).guidance;
  const done = progress?.members_done ?? 0;
  const total = progress?.member_total ?? 0;

  return (
    <div className="flex flex-col gap-3" data-testid="dataset-archive-progress">
      <div className="flex items-center gap-2.5">
        <Badge tone={halted ? 'amber' : 'teal'}>
          {halted ? 'halted' : 'archiving'}
        </Badge>
        <span
          data-testid="dataset-archive-progress-count"
          className="font-mono text-[13px] font-semibold text-text-primary"
        >
          {done} / {total}
        </span>
        <span className="text-[12px] text-text-muted">recordings archived</span>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
        <div
          className={halted ? 'h-full bg-status-warning-accent' : 'h-full bg-accent'}
          style={{ width: total > 0 ? `${Math.round((done / total) * 100)}%` : '0%' }}
        />
      </div>

      {progress?.running && progress.current_capture_id && (
        <p className="text-[12px] text-text-muted">
          Copying{' '}
          <span className="font-mono text-text-primary">
            {shortCaptureId(progress.current_capture_id)}
          </span>
          {progress.current_bytes != null && (
            <> — {formatBytes(progress.current_bytes)} so far</>
          )}
          .{' '}
          {progress.mode === 'copy'
            ? 'Every file is verified as it lands; nothing here changes.'
            : 'Each file is verified before the source is removed.'}
        </p>
      )}

      <p className="break-all font-mono text-[11px] text-text-muted">
        → {progress?.destination ?? state.selectedDataset?.dataset.archive_destination}
      </p>

      {halted && (
        <div
          data-testid="dataset-archive-halt"
          className="flex flex-col gap-1 rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12.5px] leading-relaxed text-status-warning-text"
        >
          <span className="font-semibold">
            The run stopped and nothing was rolled back.
          </span>
          <span data-testid="dataset-archive-halt-message">
            {progress.error?.message ?? 'The run halted.'}
            {progress.error?.capture_id && (
              <>
                {' '}
                (<span className="font-mono">
                  {shortCaptureId(progress.error.capture_id)}
                </span>)
              </>
            )}
          </span>
          {/* The runner's halt is a plain {code, message} in the progress
              payload, not a thrown ApiError, so the catalog has to be reached
              by code (errors.ts readCaptureCode). Without this the operator is
              stopped in front of a halted run, holding a sentence and a Resume
              button — and for `ledger_unreadable`, pressing Resume changes
              nothing until someone repairs a file. An unknown code adds
              nothing rather than inventing advice. */}
          {haltGuidance && (
            <span data-testid="dataset-archive-halt-guidance" className="font-semibold">
              {haltGuidance}
            </span>
          )}
          <span>
            {cancellationRecorded
              ? 'Cancellation is recorded durably. This attempt cannot resume; close this dialog and rebuild the catalog if the dataset remains Archiving.'
              : progress.cancelable
              ? 'Resume retries from the first recording.'
              : 'Recordings already archived stay archived; Resume continues from the first unfinished one.'}
          </span>
        </div>
      )}

      {halted && progress.cancelable && (
        <div
          data-testid="dataset-archive-cancel-available"
          className="flex flex-col gap-1 rounded-control border border-border bg-surface-muted px-3 py-2 text-[12.5px] leading-relaxed text-text-primary"
        >
          <span className="font-semibold text-text-primary">
            No completed recording is recorded for this attempt.
          </span>
          <span>
            Canceling releases the frozen destination and returns the dataset to
            Active. It does not delete anything already present at the destination.
          </span>
        </div>
      )}

      <ArchiveError
        error={state.datasetArchiveStartError}
        testIdPrefix="dataset-archive-error"
        resolveDatasetName={state.datasetName}
      />
      <ArchiveError
        error={state.datasetArchiveCancelError}
        testIdPrefix="dataset-archive-cancel-error"
        resolveDatasetName={state.datasetName}
      />
    </div>
  );
}

export function DatasetArchiveDialog({ state }: { state: DatasetsState }) {
  const status = state.selectedDataset?.dataset.status ?? 'active';
  const inProgress = status === 'archiving';
  const halted =
    inProgress &&
    state.datasetArchiveProgress != null &&
    !state.datasetArchiveProgress.running &&
    !state.datasetArchiveStarting;
  const cancellationRecorded =
    state.datasetArchiveProgress?.cancel_blocker === 'archive_canceled';
  // Deleted underneath the dialog. There is no run to start and no progress to
  // report, so the dialog drops both faces and says only that — with the button
  // dead, because the one thing it must not do is look like it did something.
  const gone = state.selectionGone;

  return (
    <Modal
      open={state.datasetArchiveOpen}
      onClose={state.cancelDatasetArchive}
      title="Archive dataset"
      footer={
        inProgress && !gone ? (
          <>
            <Button
              variant="ghost"
              onClick={state.cancelDatasetArchive}
              disabled={state.datasetArchiveCanceling}
              data-testid="dataset-archive-close"
            >
              Close
            </Button>
            {halted && state.datasetArchiveProgress?.cancelable && (
              <Button
                variant="danger"
                onClick={state.cancelDatasetArchiveRun}
                disabled={
                  state.datasetArchiveStarting || state.datasetArchiveCanceling
                }
                data-testid="dataset-archive-cancel-run"
              >
                {state.datasetArchiveCanceling ? 'Canceling…' : 'Cancel archive run'}
              </Button>
            )}
            {halted && !cancellationRecorded && (
              <Button
                variant="primary"
                onClick={state.resumeDatasetArchive}
                disabled={
                  state.datasetArchiveStarting || state.datasetArchiveCanceling
                }
                data-testid="dataset-archive-resume"
              >
                {state.datasetArchiveStarting ? 'Resuming…' : 'Resume'}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              onClick={state.cancelDatasetArchive}
              disabled={state.datasetArchiveStarting}
              data-testid="dataset-archive-cancel"
            >
              {gone ? 'Close' : 'Cancel'}
            </Button>
            <Button
              variant="primary"
              onClick={state.confirmDatasetArchive}
              disabled={
                gone ||
                state.datasetArchiveStarting ||
                state.datasetArchiveDestination === '' ||
                state.datasetArchivePath.trim() === ''
              }
              data-testid="dataset-archive-confirm"
            >
              {state.datasetArchiveStarting
                ? 'Starting…'
                : state.datasetArchiveMode === 'copy'
                  ? 'Copy, verify, then seal'
                  : 'Copy, verify, then remove'}
            </Button>
          </>
        )
      }
    >
      <div data-testid="dataset-archive-dialog" className="flex flex-col gap-3">
        {gone ? (
          <>
            <DatasetGoneNote
              testId="dataset-archive-gone"
              datasetId={state.selectedDatasetId}
            />
            <ArchiveError
              error={state.datasetArchiveStartError}
              testIdPrefix="dataset-archive-error"
              resolveDatasetName={state.datasetName}
            />
          </>
        ) : inProgress ? (
          <ProgressBody state={state} />
        ) : (
          <ConfirmBody state={state} />
        )}
      </div>
    </Modal>
  );
}
