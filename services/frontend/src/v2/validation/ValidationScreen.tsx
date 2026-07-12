// Validation tab (v2 IA) — Standard/Candidate/Experimental pipeline runs.
// Layout only for now; root mirrors the design mock's 290px / 1fr two-column
// grid (pipeline list, pipeline detail with parameters + latest run).

import { WipPanel } from '../WipPanel';

export function ValidationScreen() {
  return (
    <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[290px_1fr]">
      <WipPanel label="Validation — pipelines column (WIP)" />
      <WipPanel label="Validation — pipeline detail column (WIP)" />
    </div>
  );
}
