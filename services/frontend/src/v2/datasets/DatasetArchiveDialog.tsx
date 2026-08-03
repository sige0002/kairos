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
import { ErrorMessage } from '../../components/ErrorMessage';
import { formatBytes, memberCount, shortCaptureId } from './data';
import type { DatasetsState } from './useDatasetsState';

function ConfirmBody({ state }: { state: DatasetsState }) {
  const row = state.selectedDataset;
  const name = row?.dataset.name ?? '';
  const count = row?.dataset.member_count ?? 0;
  const bytes = row ? row.aggregate.bytes : null;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] leading-relaxed text-gray-600">
        <span className="font-semibold text-gray-900">{name}</span> —{' '}
        {memberCount(count)}
        {bytes?.total ? <>, about {formatBytes(bytes.total)}</> : null} — is copied
        to the destination as numbered folders plus a manifest, and every file is
        verified (SHA-256).{' '}
        <span className="font-semibold text-gray-800">
          Each recording that verifies is then removed from this machine, and the
          dataset becomes read-only for good.
        </span>{' '}
        The catalog keeps the dataset and records where it went.
      </p>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Archive root
        </span>
        {state.archiveRoots.length > 1 ? (
          <select
            data-testid="dataset-archive-root"
            value={state.datasetArchiveRoot}
            onChange={(e) => state.setDatasetArchiveRoot(e.target.value)}
            className="rounded-control border border-gray-200 bg-white px-2 py-1.5 text-[12.5px] text-gray-700"
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
            className="rounded-control border border-gray-100 bg-gray-50 px-2 py-1.5 font-mono text-[12px] text-gray-600"
          >
            {state.datasetArchiveRoot}
          </span>
        )}
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Path under the root{' '}
          <span className="font-normal normal-case text-gray-400">(optional)</span>
        </span>
        <input
          data-testid="dataset-archive-subpath"
          value={state.datasetArchiveSubpath}
          onChange={(e) => state.setDatasetArchiveSubpath(e.target.value)}
          spellCheck={false}
          placeholder="e.g. exports/2026-08"
          className="rounded-control border border-gray-200 bg-white px-2 py-1.5 font-mono text-[12px] text-gray-700"
        />
      </label>

      <div className="flex flex-col gap-1 rounded-[10px] border border-gray-100 bg-gray-50 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Destination
        </span>
        <span
          data-testid="dataset-archive-destination"
          className="break-all font-mono text-[12px] text-gray-800"
        >
          {state.datasetArchiveDestination || '—'}
        </span>
        <span className="text-[11px] text-gray-500">
          The dataset lands in{' '}
          <span
            data-testid="dataset-archive-final-path"
            className="break-all font-mono text-gray-700"
          >
            {state.datasetArchiveFinalDir || '—'}
          </span>{' '}
          — operator / task / name are appended by the server.
        </span>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Reason <span className="font-normal normal-case text-gray-400">(optional)</span>
        </span>
        <input
          data-testid="dataset-archive-reason"
          value={state.datasetArchiveReason}
          onChange={(e) => state.setDatasetArchiveReason(e.target.value)}
          placeholder="e.g. training set handed off for cloud training"
          className="rounded-control border border-gray-200 bg-white px-2 py-1.5 text-[12.5px] text-gray-700"
        />
      </label>

      {state.datasetArchiveStartError != null && (
        <ErrorMessage error={state.datasetArchiveStartError} />
      )}
    </div>
  );
}

function ProgressBody({ state }: { state: DatasetsState }) {
  const progress = state.datasetArchiveProgress;
  const halted = progress != null && !progress.running && progress.error != null;
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
          className="font-mono text-[13px] font-semibold text-gray-900"
        >
          {done} / {total}
        </span>
        <span className="text-[12px] text-gray-500">recordings archived</span>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-gray-100">
        <div
          className={halted ? 'h-full bg-amber-400' : 'h-full bg-teal-500'}
          style={{ width: total > 0 ? `${Math.round((done / total) * 100)}%` : '0%' }}
        />
      </div>

      {progress?.running && progress.current_capture_id && (
        <p className="text-[12px] text-gray-500">
          Copying{' '}
          <span className="font-mono text-gray-700">
            {shortCaptureId(progress.current_capture_id)}
          </span>
          {progress.current_bytes != null && (
            <> — {formatBytes(progress.current_bytes)} so far</>
          )}
          . Each file is verified before the source is removed.
        </p>
      )}

      <p className="break-all font-mono text-[11px] text-gray-500">
        → {progress?.destination ?? state.selectedDataset?.dataset.archive_destination}
      </p>

      {halted && (
        <div
          data-testid="dataset-archive-halt"
          className="flex flex-col gap-1 rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] leading-relaxed text-amber-900"
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
          <span>
            Recordings already archived stay archived; Resume continues from the
            first unfinished one.
          </span>
        </div>
      )}

      {state.datasetArchiveStartError != null && (
        <ErrorMessage error={state.datasetArchiveStartError} />
      )}
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

  return (
    <Modal
      open={state.datasetArchiveOpen}
      onClose={state.cancelDatasetArchive}
      title="Archive dataset"
      footer={
        inProgress ? (
          <>
            <Button
              variant="ghost"
              onClick={state.cancelDatasetArchive}
              data-testid="dataset-archive-close"
            >
              Close
            </Button>
            {halted && (
              <Button
                variant="primary"
                onClick={state.resumeDatasetArchive}
                disabled={state.datasetArchiveStarting}
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
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={state.confirmDatasetArchive}
              disabled={
                state.datasetArchiveStarting || state.datasetArchiveDestination === ''
              }
              data-testid="dataset-archive-confirm"
            >
              {state.datasetArchiveStarting
                ? 'Starting…'
                : 'Copy, verify, then remove'}
            </Button>
          </>
        )
      }
    >
      <div data-testid="dataset-archive-dialog">
        {inProgress ? <ProgressBody state={state} /> : <ConfirmBody state={state} />}
      </div>
    </Modal>
  );
}
