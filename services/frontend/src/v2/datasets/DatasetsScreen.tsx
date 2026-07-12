// Datasets tab (v2 IA) — recipe-based LeRobot v3 dataset builds from adopted
// Review episodes. Root mirrors the design mock's 270px / 1fr / 330px
// three-column grid (dataset list, detail, recipe & output). All state is
// frontend-local mock data in Phase 1 (see data.ts / useDatasetsState.ts) —
// the Recipe/Build model has no backend yet.

import { BuildRail } from './BuildRail';
import { DatasetDetail } from './DatasetDetail';
import { DatasetList } from './DatasetList';
import { Toast } from './Toast';
import { useDatasetsState } from './useDatasetsState';

export function DatasetsScreen() {
  const state = useDatasetsState();
  return (
    <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[270px_1fr_330px]">
      <DatasetList state={state} />
      <DatasetDetail state={state} />
      <BuildRail state={state} />
      <Toast message={state.toast} />
    </div>
  );
}
