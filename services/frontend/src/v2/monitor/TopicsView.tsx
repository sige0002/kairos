// Topics sub-view (the mock's own scope, §11): frequency chart + topics table
// on the left, Events + System on the right. The only real data plumbing here
// is topic selection — which row is charted — everything else is delegated to
// the child cards.

import { useMemo, useState } from 'react';
import type { RuntimeConfig } from '../../config';
import { useMonitorRows } from '../../features/monitor/useMonitorRows';
import { FrequencyChartCard } from './FrequencyChartCard';
import { TopicsTable } from './TopicsTable';
import { EventsCard } from './EventsCard';
import { SystemCard } from './SystemCard';

export function TopicsView({ config }: { config: RuntimeConfig }) {
  const { rows, isDiscovering } = useMonitorRows(config);
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);

  // Falls back to the first row (configured/measured topics sort first — see
  // useMonitorRows) until the operator explicitly picks one, and re-falls-back
  // if the previously-selected topic drops off the list (bag ended, robot
  // dropped it).
  const activeTopic = useMemo(() => {
    if (selectedTopic && rows.some((r) => r.name === selectedTopic)) return selectedTopic;
    return rows[0]?.name ?? null;
  }, [selectedTopic, rows]);

  return (
    <div className="grid flex-1 grid-cols-1 gap-2.5 lg:min-h-0 lg:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-2.5 lg:min-h-0">
        <FrequencyChartCard config={config} rows={rows} topic={activeTopic} />
        <TopicsTable
          rows={rows}
          isDiscovering={isDiscovering}
          selectedTopic={activeTopic}
          onSelect={setSelectedTopic}
        />
      </div>
      <div className="flex flex-col gap-2.5 lg:min-h-0">
        <EventsCard />
        <SystemCard />
      </div>
    </div>
  );
}
