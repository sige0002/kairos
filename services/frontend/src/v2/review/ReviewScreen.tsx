// Review tab (v2 IA) — the episode take-review workflow (adopt / keep in
// review / exclude), plus a two-step physical delete: Exclude is a reversible
// review label (kept on disk); Delete permanently reclaims the storage. Root
// mirrors the design mock's 216px / 1fr / 400px three-column grid (filters,
// episode list, detail). Episodes come from the real /runs API; see
// useReviewState.ts for the full behavior.
//
// Also carries our own addition — MCAP transfer for split robot/recording-PC
// deployments — gated behind SPLIT_MODE (splitMode.ts), off by default.

import { Button, Modal, cn } from '../../components/ui';
import { DetailPanel } from './DetailPanel';
import { EpisodeTable } from './EpisodeTable';
import { FiltersRail } from './FiltersRail';
import { Toast } from './Toast';
import { formatBytes } from './format';
import { useReviewState } from './useReviewState';

export function ReviewScreen() {
  const rv = useReviewState();
  const del = rv.pendingDeleteRow;
  const bulkTotalBytes = rv.excludedRows.reduce((sum, r) => sum + (r.bytes ?? 0), 0);

  return (
    <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[216px_1fr_400px]">
      <FiltersRail
        operatorOptions={rv.operatorOptions}
        operatorFilter={rv.operatorFilter}
        onOperatorChange={rv.setOperatorFilter}
        onClearFilters={rv.clearFilters}
      />
      <EpisodeTable rv={rv} />
      <DetailPanel rv={rv} />

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
            <Button variant="danger" data-testid="review-confirm-exclude" onClick={rv.confirmArchive}>
              Exclude
            </Button>
          </>
        }
      >
        The recording itself is kept and can be restored at any time. It&apos;s reclassified as
        Not usable / Excluded — episode numbers are never reassigned.
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
          (<span data-testid="review-delete-size">{formatBytes(del?.bytes)}</span>) from disk? This
          reclaims the storage and <strong>cannot be undone</strong>. The recording is already
          excluded from dataset use.
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
            <Button variant="ghost" onClick={rv.cancelBulkDelete} disabled={rv.bulkRunning}>
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
          <span className="font-mono text-gray-800">{formatBytes(bulkTotalBytes)}</span>. This{' '}
          <strong>cannot be undone</strong>.
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
                  <span className="shrink-0 font-mono text-gray-400">{formatBytes(r.bytes)}</span>
                )}
              </li>
            );
          })}
        </ul>
        {rv.bulkFailures.length > 0 && !rv.bulkRunning && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {rv.bulkFailures.length} deletion{rv.bulkFailures.length === 1 ? '' : 's'} failed — those
            recordings are still on disk.
          </p>
        )}
      </Modal>

      {/* Export adopted → Datasets (Adopt = label · Export = MOVE). */}
      <Modal
        open={rv.exportAdoptedOpen}
        onClose={rv.cancelExportAdopted}
        title={`Export ${rv.adoptedExportable.length} adopted recording${rv.adoptedExportable.length === 1 ? '' : 's'} to Datasets?`}
        footer={
          <>
            <Button variant="ghost" onClick={rv.cancelExportAdopted} disabled={rv.exportRunning}>
              {rv.exportFailures.length > 0 && !rv.exportRunning ? 'Close' : 'Cancel'}
            </Button>
            <Button
              onClick={rv.confirmExportAdopted}
              disabled={rv.exportRunning || rv.adoptedExportable.length === 0}
            >
              {rv.exportRunning
                ? `Exporting… (${rv.exportDone}/${rv.adoptedExportable.length})`
                : `Export ${rv.adoptedExportable.length}`}
            </Button>
          </>
        }
      >
        <p>
          Export <strong>moves</strong> each adopted recording into the dataset tree
          (<span className="font-mono text-gray-800">data/&lt;operator&gt;/&lt;task&gt;/NNN</span>):
          it <strong>leaves Review</strong> and appears under Datasets.
        </p>
        <ul
          data-testid="review-export-list"
          className="mt-2 max-h-48 overflow-auto rounded-control border border-gray-200 text-xs"
        >
          {rv.adoptedExportable.map((r) => {
            const failure = rv.exportFailures.find((f) => f.runId === r.runId);
            return (
              <li
                key={r.runId}
                className="flex items-center justify-between gap-2 border-t border-gray-100 px-2 py-1 first:border-t-0"
              >
                <span className="truncate font-mono text-gray-700">{r.runId}</span>
                <span className={cn('shrink-0', failure ? 'text-red-600' : 'text-gray-400')} title={failure?.error}>
                  {failure ? 'failed' : `#${r.ep}`}
                </span>
              </li>
            );
          })}
        </ul>
        {rv.adoptedSkipped.length > 0 && (
          <div
            data-testid="review-export-skipped"
            className="mt-2 rounded-control border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800"
          >
            {rv.adoptedSkipped.length} adopted recording{rv.adoptedSkipped.length === 1 ? '' : 's'}{' '}
            skipped — only <strong>completed</strong> runs can be exported:
            <ul className="mt-1 flex flex-col gap-0.5">
              {rv.adoptedSkipped.map((r) => (
                <li key={r.runId} className="truncate font-mono">
                  #{r.ep} {r.runId} · {r.state}
                </li>
              ))}
            </ul>
          </div>
        )}
        {rv.exportFailures.length > 0 && !rv.exportRunning && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {rv.exportFailures.length} export{rv.exportFailures.length === 1 ? '' : 's'} failed — those
            recordings stayed in Review.
          </p>
        )}
      </Modal>
    </div>
  );
}
