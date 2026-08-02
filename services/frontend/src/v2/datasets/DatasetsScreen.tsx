// Datasets tab. Root mirrors the design mock's 270px / 1fr / 330px three-column
// grid: the LEFT column lists the logical datasets (§6) with a search, a sort
// and the member facets; the CENTER column lists the selected dataset's members
// and renders the selected member's capture below it; the RIGHT rail adds
// finished recordings to the selected dataset.
//
// A dataset is a named SET OF CAPTURES: creating one, adding to one and deleting
// one all move exactly nothing on disk, and the browsable views/ tree is the
// server's to regenerate. So this screen never exports anything — it edits a
// list — which is why there is no build progress, no job to watch, and no
// refresh button.
//
// The two removal dialogs are the SHARED ones (captures/DeleteDialogs.tsx),
// mounted at the root so a run in flight survives the member selection changing
// underneath it.

import { DeleteDialog, DiscardDialog } from '../captures/DeleteDialogs';
import { BuildRail } from './BuildRail';
import { DatasetCenter } from './DatasetCenter';
import { DatasetList } from './DatasetList';
import { Toast } from './Toast';
import { useDatasetsState } from './useDatasetsState';

export function DatasetsScreen() {
  const state = useDatasetsState();
  const { deletion } = state;
  // The single row is pinned to the free space (minmax(0,1fr)) so a long list
  // can never blow the row past the viewport — the auto-row fallback let it, and
  // the shell's overflow-hidden then clipped the tail with no way to scroll to
  // older datasets. Columns scroll internally.
  return (
    <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[270px_1fr_330px] lg:grid-rows-[minmax(0,1fr)]">
      <DatasetList state={state} />
      <DatasetCenter state={state} />
      <BuildRail state={state} />

      <DiscardDialog
        open={deletion.kind === 'discard'}
        captures={deletion.targets}
        splitDeploy={state.splitDeploy}
        busy={deletion.busy}
        error={deletion.error}
        done={deletion.done}
        failures={deletion.failures}
        onCancel={deletion.cancel}
        onConfirm={(reason) => void deletion.confirm(reason)}
      />
      <DeleteDialog
        open={deletion.kind === 'delete'}
        captures={deletion.targets}
        splitDeploy={state.splitDeploy}
        busy={deletion.busy}
        error={deletion.error}
        done={deletion.done}
        failures={deletion.failures}
        onCancel={deletion.cancel}
        onConfirm={(reason) => void deletion.confirm(reason)}
      />

      <Toast message={state.toast} />
    </div>
  );
}
