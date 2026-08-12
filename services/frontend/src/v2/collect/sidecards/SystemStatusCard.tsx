// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// System status: one row per thing that can quietly stop working during a
// take. The rows themselves are derived in useSystemRows — this card only
// lays them out.

import { Card, cn } from '../../../components/ui';
import { SIDE_PAD } from '../compact';
import { Chip } from './Chip';
import { usePublishSystemRows } from './systemRowsStore';
import { useSystemRows, type SystemRowsInput } from './useSystemRows';

export function SystemStatusCard(props: SystemRowsInput) {
  const rows = useSystemRows(props);
  // Shared with the Active warnings card below, which must not be able to say
  // "no active warnings" while one of these rows says CHECK (#13).
  usePublishSystemRows(rows);

  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2 [@media(max-height:860px)]:gap-1',
        SIDE_PAD,
      )}
    >
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        System status
      </h2>
      {rows.map((r) => (
        <div
          key={r.label}
          data-testid={`sys-${r.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
          title={r.title}
          className="flex items-center gap-2.5 py-0.5 [@media(max-height:860px)]:py-0"
        >
          <span className="text-[13px] font-medium text-gray-700">{r.label}</span>
          <div className="flex-1" />
          <span className="font-mono text-xs text-gray-500">{r.value}</span>
          <Chip tone={r.tone}>{r.chip}</Chip>
        </div>
      ))}
    </Card>
  );
}
