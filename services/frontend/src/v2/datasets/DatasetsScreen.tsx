// Datasets tab (v2 IA). Root mirrors the design mock's 270px / 1fr / 330px
// three-column grid (dataset list, detail, export & build). The list and
// detail columns are wired to the real export API (GET /api/v1/datasets,
// GET /api/v1/datasets/{operator}/{task}/{index} — see useDatasetsState.ts);
// the recipe-based LeRobot v3 build/version model in the mock has no backend
// yet, so those panels stay as explanatory copy rather than fabricated data
// (2026-07-13 user directive — see data.ts).

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
