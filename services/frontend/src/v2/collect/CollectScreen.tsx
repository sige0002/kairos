// Collect screen: the operator's recording console. Batch/episode/phase state
// is a frontend-local machine (useBatchMachine) — the backend has no
// Session/Batch/Episode model yet (Phase 2). Start/Stop are real orchestrator
// calls; everything else (arming hold, saving/quick-check pacing, warnings,
// advice) is demo-paced local state, matching the design mock
// (.dev/kairos-console-v2.dc.html, "Collect" section).

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchRuntimeConfig } from '../../config';
import { queryKeys } from '../../api/queryKeys';
import { useUiStore } from '../../store/uiStore';
import { ContextBar } from './ContextBar';
import { ControlCard } from './ControlCard';
import { SystemStatusCard, WarningsCard, AdviceCard, BatchStatsCard } from './SideCards';
import { Cameras } from './Cameras';
import { EpisodeStrip } from './EpisodeStrip';
import { CollectModals } from './Modals';
import { COL_GAP } from './compact';
import { useBatchMachine } from './useBatchMachine';
import { cn } from '../../components/ui';

export function CollectScreen() {
  // The runtime config is already fetched (and cached under this same key) by
  // the app shell before any tab renders — this just reads that cache instead
  // of threading a `config` prop through Shell/TabPanel/TabContent.
  const { data: config } = useQuery({
    queryKey: queryKeys.runtimeConfig,
    queryFn: fetchRuntimeConfig,
  });

  const sseStatus = useUiStore((s) => s.sseStatus);
  const monitorBridge = useUiStore((s) => s.monitorBridge);

  // The machine resolves the next-start topic selection from these configured
  // defaults + the uiStore Monitor picker (see useBatchMachine's RecordSelection).
  const defaultTopics = config?.defaults.default_topics ?? [];
  const machine = useBatchMachine({ defaultTopics });

  const [camerasOk, setCamerasOk] = useState(true);
  const onHealthChange = useCallback((ok: boolean) => setCamerasOk(ok), []);

  if (!config) {
    return <div className="p-4 text-sm text-gray-400">Loading…</div>;
  }

  return (
    <div className={cn('flex flex-col lg:h-full lg:min-h-0', COL_GAP)}>
      <ContextBar machine={machine} />
      <div
        className={cn(
          'grid grid-cols-1 lg:min-h-0 lg:flex-1 lg:grid-cols-[340px_1fr]',
          COL_GAP,
        )}
      >
        {/* The ControlCard (the primary Start/Stop/Save action) is pinned and
            always fully visible; only the secondary reference cards below scroll
            when a tall phase (e.g. the episode result with banners) leaves no
            room — so the page itself never scrolls and the control is never cut
            off. In the steady states everything fits with no scroll at all. */}
        <div className={cn('flex flex-col overflow-hidden lg:min-h-0', COL_GAP)}>
          <ControlCard machine={machine} />
          <div className={cn('flex flex-col overflow-y-auto lg:min-h-0 lg:flex-1', COL_GAP)}>
            <SystemStatusCard
              machine={machine}
              sseStatus={sseStatus}
              monitorBridge={monitorBridge}
              camerasOk={camerasOk}
            />
            <WarningsCard machine={machine} />
            <AdviceCard machine={machine} />
            <BatchStatsCard machine={machine} />
          </div>
        </div>
        <div className={cn('flex flex-col lg:min-h-0', COL_GAP)}>
          <Cameras config={config} machine={machine} onHealthChange={onHealthChange} />
          <EpisodeStrip machine={machine} />
        </div>
      </div>
      <CollectModals machine={machine} />
    </div>
  );
}
