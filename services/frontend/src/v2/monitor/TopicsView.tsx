// Topics sub-view (the mock's own scope, §11): frequency chart + topics table
// on the left, Events + System on the right. The only real data plumbing here
// is topic selection — which rows are OVERLAID on the chart (v1 Graph parity) —
// everything else is delegated to the child cards.

import { useMemo, useState } from 'react';
import type { RuntimeConfig } from '../../config';
import { useMonitorRows } from '../../features/monitor/useMonitorRows';
import { FrequencyChartCard } from './FrequencyChartCard';
import { TopicsTable } from './TopicsTable';
import { EventsCard } from './EventsCard';
import { SystemCard } from './SystemCard';
import { MAX_SERIES, toggleTopic } from './chartSeries';

export function TopicsView({ config }: { config: RuntimeConfig }) {
  const { rows, isDiscovering } = useMonitorRows(config);
  // `null` = the operator hasn't touched selection yet → default to the first
  // row (configured/measured topics sort first, see useMonitorRows). Once they
  // click, it becomes an explicit (possibly empty) ordered set. Order is the
  // series/palette order; the cap is enforced by toggleTopic.
  const [selected, setSelected] = useState<string[] | null>(null);

  const chartedTopics = useMemo(() => {
    const base = selected ?? (rows[0] ? [rows[0].name] : []);
    // Drop any topic that has since disappeared (bag ended, robot dropped it).
    return base.filter((t) => rows.some((r) => r.name === t)).slice(0, MAX_SERIES);
  }, [selected, rows]);

  const onToggle = (name: string) => {
    setSelected((prev) => {
      const base = prev ?? (rows[0] ? [rows[0].name] : []);
      return toggleTopic(base, name);
    });
  };

  return (
    <div className="grid flex-1 grid-cols-1 gap-2.5 lg:min-h-0 lg:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-2.5 lg:min-h-0">
        <FrequencyChartCard config={config} rows={rows} topics={chartedTopics} />
        <TopicsTable
          rows={rows}
          isDiscovering={isDiscovering}
          chartedTopics={chartedTopics}
          onToggle={onToggle}
        />
      </div>
      <div className="flex flex-col gap-2.5 lg:min-h-0">
        <EventsCard />
        <SystemCard />
      </div>
    </div>
  );
}
