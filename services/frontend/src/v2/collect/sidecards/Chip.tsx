// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The status pill the System status and Active warnings cards both end their
// rows with. One tone vocabulary, so "OK" is the same green everywhere.

import { cn } from '../../../components/ui';

export type Tone = 'green' | 'amber' | 'red' | 'teal' | 'gray';

const CHIP_TONE: Record<Tone, string> = {
  green: 'bg-status-success-bg text-status-success-text',
  amber: 'bg-status-warning-bg text-status-warning-text',
  red: 'bg-status-danger-bg text-status-danger-text border border-status-danger-border',
  teal: 'bg-interaction-selected text-accent',
  gray: 'bg-surface-muted text-text-secondary',
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
