// Archive one dataset to an allow-listed path (2026-07-26). Archiving is the
// only control here that moves data OFF this machine, so the dialog's job is to
// make the consequence unmissable before it is started:
//
//   copy -> verify (sha256) -> then remove from this machine
//
// The destination is not free text: the deployment configures the roots
// (KAIROS_ARCHIVE_ROOTS) and the operator picks a subpath under one. That is a
// safety boundary, so it is shown as a boundary — a root you choose from plus a
// path you type, with the resulting absolute path echoed back before you commit.
//
// If the deployment configured no roots the dialog never opens (the button that
// opens it is not rendered) — the honesty rule: don't advertise what can't run.

import { Button, Modal } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import type { DatasetsState } from './useDatasetsState';

export function ArchiveDialog({ state }: { state: DatasetsState }) {
  const { selected, archiveRoots, archiveDestination } = state;
  const name = selected
    ? `${selected.operator}/${selected.task}/${selected.index}`
    : '';

  return (
    <Modal
      open={state.archiveOpen}
      onClose={state.cancelArchive}
      title="Archive dataset"
      footer={
        <>
          <Button variant="ghost" onClick={state.cancelArchive} disabled={state.archiving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={state.confirmArchive}
            disabled={state.archiving || archiveDestination === ''}
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
          It then disappears from Datasets; the lifecycle ledger keeps a record of
          where it went.
        </p>

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
            Defaults to the catalog&apos;s own operator / task / index, so the archive
            stays navigable by the same coordinates.
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
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Reason <span className="font-normal normal-case text-gray-400">(optional)</span>
          </span>
          <input
            data-testid="archive-reason"
            value={state.departureReason}
            onChange={(e) => state.setDepartureReason(e.target.value)}
            placeholder="e.g. moved to the shared storage server"
            className="rounded-control border border-gray-200 bg-white px-2 py-1.5 text-[12.5px] text-gray-700"
          />
        </label>

        {state.archiveError && <ErrorMessage error={state.archiveError} />}
      </div>
    </Modal>
  );
}
