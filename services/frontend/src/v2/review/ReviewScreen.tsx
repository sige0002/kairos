// Review tab (v2 IA) — the episode take-review workflow (adopt / keep in
// review / exclude). Root mirrors the design mock's 216px / 1fr / 400px
// three-column grid (filters, episode list, detail). Episodes come from the
// real /runs API (mapRuns.ts fills in the quality/task/batch concepts the
// backend doesn't have yet); see useReviewState.ts for the full behavior.
//
// Also carries our own addition — MCAP transfer for split robot/recording-PC
// deployments — gated behind SPLIT_MODE (splitMode.ts), off by default.

import { Button, Modal } from '../../components/ui';
import { DetailPanel } from './DetailPanel';
import { EpisodeTable } from './EpisodeTable';
import { FiltersRail } from './FiltersRail';
import { Toast } from './Toast';
import { useReviewState } from './useReviewState';

export function ReviewScreen() {
  const rv = useReviewState();

  return (
    <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[216px_1fr_400px]">
      <FiltersRail onClearFilters={rv.clearFilters} />
      <EpisodeTable rv={rv} />
      <DetailPanel rv={rv} />

      <Toast message={rv.toast} />

      <Modal
        open={rv.pendingArchiveEp !== null}
        onClose={rv.cancelArchive}
        title="Mark episode not usable?"
        footer={
          <>
            <Button variant="ghost" onClick={rv.cancelArchive}>
              Cancel
            </Button>
            <Button variant="danger" onClick={rv.confirmArchive}>
              Mark not usable
            </Button>
          </>
        }
      >
        Mark episode #{rv.pendingArchiveEp} as NOT USABLE? It is reclassified (not deleted):
        quality → Not usable, review → Excluded, and it joins the delete candidates list.
        Episode numbers are never reassigned. Actual deletion is a separate engineer action.
      </Modal>
    </div>
  );
}
