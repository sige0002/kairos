// Settings tab (v2 IA) — absorbs the old Config tab plus robot profiles and
// batch plans (project/task/condition). Layout only for now; root mirrors the
// design mock's 216px / 250px / 1fr three-column grid (settings menu, a list
// panel whose contents depend on the selected menu item, and its detail).

import { WipPanel } from '../WipPanel';

export function SettingsScreen() {
  return (
    <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[216px_250px_1fr]">
      <WipPanel label="Settings — menu column (WIP)" />
      <WipPanel label="Settings — list column (WIP)" />
      <WipPanel label="Settings — detail column (WIP)" />
    </div>
  );
}
