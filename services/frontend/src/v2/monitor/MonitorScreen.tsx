// Monitor tab (v2 IA) — absorbs the old Graph + Probe tabs (Topics / Camera /
// Events / System sub-views) plus the header's old SystemInfo footer. Layout
// only for now; root mirrors the design mock: a context bar + sub-nav row
// above a 1fr / 340px two-column grid (topic chart & table, events & system).

import { Card } from '../../components/ui';
import { WipPanel } from '../WipPanel';

export function MonitorScreen() {
  return (
    <div className="flex flex-col gap-2.5 lg:h-full lg:min-h-0">
      <Card className="shrink-0 px-4 py-3 text-sm text-gray-400">
        Monitor — context bar & sub-nav (WIP): Topics · Camera · Events · System
      </Card>
      <div className="grid grid-cols-1 gap-2.5 lg:min-h-0 lg:flex-1 lg:grid-cols-[1fr_340px]">
        <WipPanel label="Monitor — topics chart & table column (WIP)" />
        <WipPanel label="Monitor — events & system column (WIP)" />
      </div>
    </div>
  );
}
