// Shared placeholder for the five Monitor sub-views the mock doesn't specify
// beyond a name (Overview / Signals / System / Events / Logs — see §11).
// Topics is the only sub-view with a built-out layout in Phase 1.

import { Card } from '../../components/ui';

export function OtherView({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <Card className="flex flex-1 flex-col items-center justify-center gap-2 lg:min-h-0">
      <span className="text-[15px] font-bold text-gray-700">{label}</span>
      <span className="text-[12.5px] text-gray-400">
        This view isn&apos;t built yet — Topics has the live monitoring you need today.
      </span>
      <button
        type="button"
        onClick={onBack}
        className="rounded-control border border-gray-200 bg-white px-4 py-2 text-[12.5px] font-semibold text-teal-700 hover:bg-teal-50"
      >
        Back to Topics
      </button>
    </Card>
  );
}
