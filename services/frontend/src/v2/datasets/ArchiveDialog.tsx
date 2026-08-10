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
import { ArchiveError } from './ArchiveError';
import { shortCaptureId } from './data';
import type { DatasetsState } from './useDatasetsState';

export function ArchiveDialog({ state }: { state: DatasetsState }) {
  const { archiveTarget, archiveRoots, archiveDestination, archiveFinalPath } = state;
  const name = archiveTarget
    ? (archiveTarget.run_id ?? shortCaptureId(archiveTarget.capture_id))
    : '';

  return (
    <Modal
      open={archiveTarget !== null}
      onClose={state.cancelArchive}
      title="Archive recording"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={state.cancelArchive}
            disabled={state.archiving}
            data-testid="archive-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={state.confirmArchive}
            disabled={state.archiving || archiveDestination === ''}
            data-testid="archive-confirm"
          >
            {state.archiving ? 'Archiving…' : 'Copy, verify, then remove'}
          </Button>
        </>
      }
    >
      <div data-testid="archive-dialog" className="flex flex-col gap-3">
        <p className="text-[13px] leading-relaxed text-gray-600">
          <span className="font-mono text-gray-800">{name}</span> is copied to the
          destination and every file is verified (SHA-256) against the source.{' '}
          <span className="font-semibold text-gray-800">
            Only after it verifies is the copy here removed.
          </span>{' '}
          The catalog keeps the capture and records where it went. The copy runs
          on the server — a large recording takes a while, and progress is shown
          here.
        </p>

        {state.archiving && state.archiveProgress && (
          <p
            data-testid="archive-progress"
            className="font-mono text-[12px] text-gray-600"
          >
            Copying… {(state.archiveProgress.done / 1_000_000).toFixed(0)} MB
            {state.archiveProgress.total != null
              ? ` of ${(state.archiveProgress.total / 1_000_000).toFixed(0)} MB`
              : ''}
          </p>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Archive root
          </span>
          {archiveRoots.length > 1 ? (
            <select
              data-testid="archive-root"
              value={state.archiveRoot}
              onChange={(e) => state.setArchiveRoot(e.target.value)}
              className="rounded-control border border-gray-200 bg-white px-2 py-1.5 text-[12.5px] text-gray-700"
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
              className="rounded-control border border-gray-100 bg-gray-50 px-2 py-1.5 font-mono text-[12px] text-gray-600"
            >
              {state.archiveRoot}
            </span>
          )}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Path under the root
          </span>
          <input
            data-testid="archive-subpath"
            value={state.archiveSubpath}
            onChange={(e) => state.setArchiveSubpath(e.target.value)}
            spellCheck={false}
            className="rounded-control border border-gray-200 bg-white px-2 py-1.5 font-mono text-[12px] text-gray-700"
          />
          <span className="text-[11px] text-gray-400">
            Defaults to the operator / task the recording itself records, so an
            archive stays navigable by the same names the catalog uses.
          </span>
        </label>

        <div className="flex flex-col gap-1 rounded-[10px] border border-gray-100 bg-gray-50 px-3 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Destination
          </span>
          <span
            data-testid="archive-destination"
            className="break-all font-mono text-[12px] text-gray-800"
          >
            {archiveDestination || '—'}
          </span>
          <span className="text-[11px] text-gray-500">
            Files are written to{' '}
            <span data-testid="archive-final-path" className="break-all font-mono text-gray-700">
              {archiveFinalPath || '—'}
            </span>{' '}
            — the capture id is appended by the server.
          </span>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Reason <span className="font-normal normal-case text-gray-400">(optional)</span>
          </span>
          <input
            data-testid="archive-reason"
            value={state.archiveReason}
            onChange={(e) => state.setArchiveReason(e.target.value)}
            placeholder="e.g. moved to the shared storage server"
            className="rounded-control border border-gray-200 bg-white px-2 py-1.5 text-[12.5px] text-gray-700"
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
