// Settings placeholder for the two sections that have nothing honest to configure
// yet — Dataset profiles and Users & permissions. Each explains WHY there is
// nothing here (not "coming soon" filler), so the operator isn't left hunting for
// a control that doesn't exist. No dead affordances.

import { Card } from '../../components/ui';

export function OtherSection({ label, rationale }: { label: string; rationale: string }) {
  return (
    <Card
      className="flex flex-col items-center justify-center gap-2 p-8 lg:col-span-2"
      data-testid="settings-other-placeholder"
    >
      <span className="text-[15px] font-bold text-gray-700">{label}</span>
      <p className="max-w-md text-center text-[12.5px] leading-relaxed text-gray-400">{rationale}</p>
    </Card>
  );
}
