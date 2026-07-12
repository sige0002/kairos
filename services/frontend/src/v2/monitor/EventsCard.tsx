// Right-rail Events list — static mock (see mockData.ts): a Session/Batch/
// Episode-scoped event feed needs a backend event model that doesn't exist yet
// (Phase 2, same caveat as the Collect screen's batch state).

import { Card, cn } from '../../components/ui';
import { MOCK_EVENTS, type MockEventTone } from './mockData';

const DOT_COLOR: Record<MockEventTone, string> = {
  red: 'bg-red-600',
  amber: 'bg-amber-600',
  info: 'bg-cyan-600',
};

export function EventsCard() {
  return (
    <Card className="flex flex-1 flex-col lg:min-h-0">
      <div className="flex items-center gap-2.5 border-b border-gray-100 px-4 py-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Events
        </span>
        <div className="flex-1" />
        <span className="font-mono text-[11.5px] text-gray-400">{MOCK_EVENTS.length} in range</span>
      </div>
      <div className="flex flex-col gap-0.5 overflow-auto p-2.5">
        {MOCK_EVENTS.map((ev) => (
          <div
            key={ev.title}
            className={cn(
              'flex items-start gap-2.5 rounded-control px-2.5 py-2.5',
              ev.warn && 'bg-amber-50',
            )}
          >
            <span className={cn('mt-[5px] h-[7px] w-[7px] shrink-0 rounded-sm', DOT_COLOR[ev.tone])} />
            <div className="flex min-w-0 flex-col gap-px">
              <span className="text-[12.5px] font-semibold text-gray-700">{ev.title}</span>
              <span className="font-mono text-[11px] text-gray-400">{ev.time}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
