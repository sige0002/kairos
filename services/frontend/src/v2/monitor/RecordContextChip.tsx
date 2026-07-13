// Monitor context strip chip: the REAL current recording state (REC + run_id +
// elapsed while a capture is running, STANDBY otherwise), from /record/status —
// no invented episode number or time range. Shares the record-status query cache
// with the Live tab / header (react-query dedupes by key); SSE record_status
// events keep it fresh between polls.

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { RecordStatus } from '../../api/types';
import { Card } from '../../components/ui';
import { useNowClock } from './useNowClock';
import { computeRecordContext, formatElapsed } from './recordContext';

export function RecordContextChip() {
  const { data } = useQuery({
    queryKey: queryKeys.recordStatus,
    queryFn: ({ signal }) => apiGet<RecordStatus>('/record/status', { signal }),
    refetchInterval: 5000,
  });
  const active = !!data && (data.state === 'recording' || data.state === 'stopping');
  const now = useNowClock(active);
  const ctx = computeRecordContext(data, now);

  return (
    <Card className="flex items-center gap-2.5 px-3.5 py-2" data-testid="monitor-context">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400">
        Context
      </span>
      {ctx.recording ? (
        <>
          <span
            data-testid="context-state"
            className="inline-flex items-center gap-1.5 rounded-chip bg-red-50 px-[7px] py-0.5 text-[10.5px] font-bold text-red-700"
          >
            <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-red-600" />
            REC
          </span>
          <span className="font-mono text-[12.5px] font-semibold text-gray-900">
            {ctx.runId ?? '—'}
          </span>
          <span className="font-mono text-xs text-gray-500">{formatElapsed(ctx.elapsedMs)}</span>
        </>
      ) : (
        <span
          data-testid="context-state"
          className="inline-flex rounded-chip bg-gray-100 px-[7px] py-0.5 text-[10.5px] font-bold text-gray-500"
        >
          STANDBY
        </span>
      )}
    </Card>
  );
}
