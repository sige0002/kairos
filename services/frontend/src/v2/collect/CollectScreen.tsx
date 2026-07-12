// Collect tab (v2 IA). Layout only for now — per-screen fidelity (the plan
// context bar, the READY/recording control card, the stream+monitor column)
// lands in a later task. Root layout mirrors the design mock: a context bar
// above a 340px / 1fr two-column grid.

import { Card } from '../../components/ui';
import { WipPanel } from '../WipPanel';

export function CollectScreen() {
  return (
    <div className="flex flex-col gap-2.5 lg:h-full lg:min-h-0">
      <Card className="shrink-0 px-4 py-3 text-sm text-gray-400">
        Collect — context bar (WIP): project · task · batch · episode · condition
      </Card>
      <div className="grid grid-cols-1 gap-2.5 lg:min-h-0 lg:flex-1 lg:grid-cols-[340px_1fr]">
        <WipPanel label="Collect — control column (WIP)" />
        <WipPanel label="Collect — stream & monitor column (WIP)" />
      </div>
    </div>
  );
}
