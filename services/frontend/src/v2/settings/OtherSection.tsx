// Settings > any of the 6 sections outside Robots/Plans — spec'd elsewhere
// (per the design mock: "§12") and out of scope for this pass.

import { Card } from '../../components/ui';

export function OtherSection({ label }: { label: string }) {
  return (
    <Card
      className="flex flex-col items-center justify-center gap-2 lg:col-span-2"
      data-testid="settings-other-placeholder"
    >
      <span className="text-[15px] font-bold text-gray-700">{label}</span>
      <span className="text-[12.5px] text-gray-400">
        This settings section is specified in §12 — mock focuses on Robots.
      </span>
    </Card>
  );
}
