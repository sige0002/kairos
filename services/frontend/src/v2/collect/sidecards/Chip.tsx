// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The status pill the System status and Active warnings cards both end their
// rows with. One tone vocabulary, so "OK" is the same green everywhere.

import { cn } from '../../../components/ui';

export type Tone = 'green' | 'amber' | 'red' | 'teal' | 'gray';

const CHIP_TONE: Record<Tone, string> = {
  green: 'bg-green-100 text-green-700',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-50 text-red-700 border border-red-200',
  teal: 'bg-teal-100 text-teal-700',
  gray: 'bg-gray-100 text-gray-600',
};

export function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'shrink-0 self-start rounded-chip px-2 py-0.5 text-[11px] font-bold tracking-[0.03em]',
        CHIP_TONE[tone],
      )}
    >
      {children}
    </span>
  );
}
