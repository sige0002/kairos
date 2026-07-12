// Review tab (v2 IA) — the episode take-review workflow (adopt / keep in
// review / exclude). Layout only for now; root mirrors the design mock's
// 216px / 1fr / 400px three-column grid (filters, episode list, detail).

import { WipPanel } from '../WipPanel';

export function ReviewScreen() {
  return (
    <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[216px_1fr_400px]">
      <WipPanel label="Review — filters column (WIP)" />
      <WipPanel label="Review — episode list column (WIP)" />
      <WipPanel label="Review — episode detail column (WIP)" />
    </div>
  );
}
