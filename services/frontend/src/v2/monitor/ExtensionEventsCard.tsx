// Monitor > Events — extension analysis events (the dora_live extension seam).
//
// Zero-extension-author-cost UI (the live twin of the validation lane's
// params_schema/SummaryResult contract): whatever freeform body a sidecar
// POSTed to /internal/analysis/events renders here generically — the
// kind/source/topic/t conventions get dedicated slots, every other field
// becomes a key=value chip. No frontend change is ever needed for a new
// extension or a new event shape.
//
// Honest states: the card is hidden entirely when the live backend has no
// event surface (LIVE=0 legacy monitor — showing an empty card there would
// claim a capability that doesn't exist); with the surface present but the
// ring empty, an explicit empty state says how events get here.

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { LiveEventsResponse } from '../../api/types';
import { Card } from '../../components/ui';
import { chipValue, eventTime, extraEntries } from './extensionEvents';

const POLL_MS = 2000;
const SHOWN_MAX = 100;

export function ExtensionEventsCard() {
  const { data } = useQuery<LiveEventsResponse>({
    queryKey: queryKeys.liveEvents,
    queryFn: ({ signal }) => apiGet<LiveEventsResponse>('/api/v1/live/events', { signal }),
    refetchInterval: POLL_MS,
  });

  // No data yet (first poll in flight) or no live surface at all: render
  // nothing — this card must not claim a seam that isn't there.
  if (!data || data.available === false) return null;

  // Ring order is oldest-first; the operator wants the newest at the top.
  const events = [...(data.events ?? [])].reverse().slice(0, SHOWN_MAX);

  return (
    <Card className="flex flex-col" data-testid="extension-events">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-gray-100 px-4 py-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Extension events
        </span>
        <span data-testid="extension-events-count" className="font-mono text-[11.5px] text-gray-400">
          {events.length} shown
        </span>
      </div>
      <p className="border-b border-gray-100 px-4 py-2 text-[11px] leading-relaxed text-gray-400">
        Freeform analysis events posted by live extensions (extensions/README.md). Ring-buffered
        on the robot (last 500, not persisted); newest first.
      </p>
      <div className="flex max-h-72 flex-col gap-0.5 overflow-auto p-2.5">
        {events.length === 0 ? (
          <p
            data-testid="extension-events-empty"
            className="px-1.5 py-6 text-center text-[12px] text-gray-400"
          >
            No extension events yet — sidecars POST /internal/analysis/events and rows appear
            here.
          </p>
        ) : (
          events.map((event, index) => (
            <div
              key={`${event.t ?? 'no-t'}-${index}`}
              data-testid="extension-events-row"
              className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 rounded-control px-2.5 py-2"
            >
              <span className="font-mono text-[11px] text-gray-400">{eventTime(event.t)}</span>
              <span className="text-[12.5px] font-semibold text-gray-700">
                {typeof event.kind === 'string' && event.kind ? event.kind : 'event'}
              </span>
              {typeof event.source === 'string' && event.source && (
                <span className="rounded-chip bg-teal-50 px-1.5 py-0.5 font-mono text-[10.5px] text-teal-700">
                  {event.source}
                </span>
              )}
              {typeof event.topic === 'string' && event.topic && (
                <span className="font-mono text-[11px] text-gray-500">{event.topic}</span>
              )}
              {extraEntries(event).map(([key, value]) => (
                <span
                  key={key}
                  className="rounded-chip bg-gray-100 px-1.5 py-0.5 font-mono text-[10.5px] text-gray-500"
                >
                  {key}={chipValue(value)}
                </span>
              ))}
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
