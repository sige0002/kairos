// Settings > any of the 6 sections outside Robots/Plans — not built yet. The
// heading names the section; the body points to what is wired up today.

import { Card } from '../../components/ui';

export function OtherSection({ label }: { label: string }) {
  return (
    <Card
      className="flex flex-col items-center justify-center gap-2 lg:col-span-2"
      data-testid="settings-other-placeholder"
    >
      <span className="text-[15px] font-bold text-gray-700">{label}</span>
      <span className="text-[12.5px] text-gray-400">
        This section isn&apos;t built yet — Robots and Plans are wired up today.
      </span>
    </Card>
  );
}
