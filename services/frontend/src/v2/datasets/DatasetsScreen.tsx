// Datasets tab (v2 IA) — recipe-based LeRobot v3 dataset builds from adopted
// Review episodes. Layout only for now; root mirrors the design mock's 270px
// / 1fr / 330px three-column grid (dataset list, detail, recipe & output).

import { WipPanel } from '../WipPanel';

export function DatasetsScreen() {
  return (
    <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[270px_1fr_330px]">
      <WipPanel label="Datasets — dataset list column (WIP)" />
      <WipPanel label="Datasets — dataset detail column (WIP)" />
      <WipPanel label="Datasets — recipe & output column (WIP)" />
    </div>
  );
}
