// Monitor context strip chip: the REAL current recording state (REC + run_id +
// capture id + elapsed while a capture is running, STANDBY otherwise), from
// /record/status — no invented episode number or time range. Shares the
// record-status query cache with Collect / the header (react-query dedupes by
// key); SSE record_status events keep it fresh between polls.

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { RecordStatus } from '../../api/types';
import { Card } from '../../components/ui';
import { useNowClock } from './useNowClock';
import { computeRecordContext, formatElapsed } from './recordContext';

/** Why an absent live-capture list may not be shown as "nothing is running". */
const UNREPORTED_TITLE =
  'The recorder answered without its live-capture list, so it cannot be ' +
  'confirmed that nothing is recording (contract §10). Check the recorder ' +
  'version and that it is reachable.';

export function RecordContextChip() {
  const { data, isPending } = useQuery({
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
          {/* The identity, abbreviated to fit the strip; the full id is the
              title so it can be read and copied without leaving Monitor. */}
          <span
            data-testid="context-capture"
            data-capture-id={ctx.captureId ?? ''}
            title={ctx.captureId ?? 'The recorder did not name the capture.'}
            className="font-mono text-[11px] text-gray-400"
          >
            {ctx.captureId ? ctx.captureId.slice(0, 8) : '—'}
          </span>
          <span className="font-mono text-xs text-gray-500">{formatElapsed(ctx.elapsedMs)}</span>
        </>
      ) : isPending ? (
        <span
          data-testid="context-state"
          className="inline-flex rounded-chip bg-gray-100 px-[7px] py-0.5 text-[10.5px] font-bold text-gray-400"
        >
          CHECKING…
        </span>
      ) : ctx.liveKnown ? (
        <span
          data-testid="context-state"
          className="inline-flex rounded-chip bg-gray-100 px-[7px] py-0.5 text-[10.5px] font-bold text-gray-500"
        >
          STANDBY
        </span>
      ) : (
        <span
          data-testid="context-state"
          title={UNREPORTED_TITLE}
          className="inline-flex rounded-chip bg-amber-100 px-[7px] py-0.5 text-[10.5px] font-bold text-amber-700"
        >
          LIVE STATE UNREPORTED
        </span>
      )}
    </Card>
  );
}
