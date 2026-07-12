// Placeholder content panel for a v2 screen column that hasn't been built out
// yet (per-screen fidelity is later work — see the design mock). Labeling the
// gap directly in the rendered UI, not just in a code comment, keeps the WIP
// state visible to anyone clicking through the app.

import { Card, cn } from '../components/ui';

export function WipPanel({ label, className }: { label: string; className?: string }) {
  return (
    <Card
      className={cn(
        'flex min-h-0 flex-col items-center justify-center gap-1 p-6 text-center',
        className,
      )}
    >
      <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-gray-400">
        Work in progress
      </span>
      <span className="text-[13px] font-medium text-gray-500">{label}</span>
    </Card>
  );
}
