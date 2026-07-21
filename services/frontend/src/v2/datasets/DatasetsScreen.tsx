// Datasets tab (v2 IA). Root mirrors the design mock's 270px / 1fr / 330px
// three-column grid. 2026-07-21 IA overhaul (user report: the flat one-card-per-
// episode list became unnavigable as exports grew): the LEFT column now folds
// GET /api/v1/datasets into a task -> condition group tree (DatasetList), with a
// search box, recency/A–Z sort, and task-result + operator facets; the CENTER
// column (DatasetCenter) lists the selected group's episodes and renders the
// reused per-episode detail (loss report / video check / JSON sidecars) below
// once a row is picked. Datasets stays a CATALOG ONLY — Review is the single
// export surface — so the right rail (BuildRail) points there. Mock-only
// (Phase 2): the recipe-based LeRobot v3 build/version model has no backend yet,
// so BuildRail's build panel stays explanatory "pending" copy (2026-07-13
// directive — see data.ts).

import { BuildRail } from './BuildRail';
import { DatasetCenter } from './DatasetCenter';
import { DatasetList } from './DatasetList';
import { Toast } from './Toast';
import { useDatasetsState } from './useDatasetsState';

export function DatasetsScreen() {
  const state = useDatasetsState();
  // The single row is pinned to the free space (minmax(0,1fr)) so a long group
  // tree can never blow the row past the viewport — the auto-row fallback let
  // it, and the shell's overflow-hidden then clipped the tail with no way to
  // scroll to older groups. Columns scroll internally.
  return (
    <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[270px_1fr_330px] lg:grid-rows-[minmax(0,1fr)]">
      <DatasetList state={state} />
      <DatasetCenter state={state} />
      <BuildRail state={state} />
      <Toast message={state.toast} />
    </div>
  );
}
