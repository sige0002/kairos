// Right-rail Events list — REAL alerts from the monitor. The `alert` SSE snapshot
// is accumulated into a rolling max-100 buffer in the TanStack Query cache by
// useEventStream (queryKeys.alerts); we READ that cache (no second SSE
// connection) and render the most recent firing/cleared breaches. Empty until an
// alert actually fires — an honest "no alerts yet" rather than a fabricated feed.

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../api/queryKeys';
import type { AlertEvent } from '../../api/types';
import { Card, cn } from '../../components/ui';
import { incidentCount, toAlertRows, type AlertTone } from './alerts';

const CAP = 12;

const DOT_COLOR: Record<AlertTone, string> = {
  red: 'bg-red-600',
  gray: 'bg-gray-300',
};

export function EventsCard() {
  // Read-only view of the SSE-populated alert buffer: a throwing queryFn that is
  // never enabled (same idiom as useMetricHistory's metrics cache) — the data is
  // whatever useEventStream last wrote, and this subscribes to its changes.
  const { data } = useQuery<AlertEvent[]>({
    queryKey: queryKeys.alerts,
    queryFn: () => {
      throw new Error('SSE-only cache: written by useEventStream');
    },
    enabled: false,
  });
  const alerts = data ?? [];
  const rows = toAlertRows(alerts, CAP);
  // Count distinct incidents (not raw buffer entries — a sustained breach re-sends
  // its firing state each tick), so the header is honest about how many there are.
  const total = incidentCount(alerts);

  return (
    <Card className="flex flex-1 flex-col lg:min-h-0">
      <div className="flex items-center gap-2.5 border-b border-gray-100 px-4 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Events
        </h2>
        <div className="flex-1" />
        <span data-testid="events-count" className="font-mono text-[11.5px] text-gray-500">
          {total > CAP ? `${CAP} of ${total}` : `${total}`} alerts
        </span>
      </div>
      <div className="flex flex-col gap-0.5 overflow-auto p-2.5">
        {rows.length === 0 ? (
          <p
            data-testid="events-empty"
            className="px-1.5 py-6 text-center text-[11.5px] leading-relaxed text-gray-500"
          >
            No alerts yet — threshold breaches from the monitor will appear here.
          </p>
        ) : (
          rows.map((ev) => (
            <div
              key={ev.key}
              data-testid="event-row"
              className={cn(
                'flex items-start gap-2.5 rounded-control px-2.5 py-2.5',
                ev.state === 'firing' && 'bg-red-50',
              )}
            >
              <span className={cn('mt-[5px] h-[7px] w-[7px] shrink-0 rounded-sm', DOT_COLOR[ev.tone])} />
              <div className="flex min-w-0 flex-col gap-px">
                {/* `min-w-0` above lets the column shrink, but a topic name with
                    no break opportunity — no slash, no space, which is what a
                    driver that underscores its whole path produces — still has
                    nowhere to wrap, so it paints straight through the card's
                    right edge (measured: 448px outside its box). `break-words`
                    breaks only a word that cannot otherwise fit, so ordinary
                    titles wrap exactly as before. */}
                <span className="break-words text-[12.5px] font-semibold text-gray-700">
                  {ev.title}
                  {ev.detail && <span className="font-normal text-gray-500"> · {ev.detail}</span>}
                </span>
                <span className="font-mono text-[11px] text-gray-500">
                  {ev.state === 'cleared' ? `cleared · ${ev.time}` : `firing · since ${ev.time}`}
                  {ev.refires > 1 && <span className="text-gray-500"> · ×{ev.refires}</span>}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
