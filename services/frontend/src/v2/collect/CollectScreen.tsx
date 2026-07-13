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
import { useBatchMachine } from './useBatchMachine';

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
    <div className="flex flex-col gap-2.5 lg:h-full lg:min-h-0">
      <ContextBar machine={machine} />
      <div className="grid grid-cols-1 gap-2.5 lg:min-h-0 lg:flex-1 lg:grid-cols-[340px_1fr]">
        <div className="flex flex-col gap-2.5 overflow-auto lg:min-h-0">
          <ControlCard machine={machine} />
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
        <div className="flex flex-col gap-2.5 lg:min-h-0">
          <Cameras config={config} machine={machine} onHealthChange={onHealthChange} />
          <EpisodeStrip machine={machine} />
        </div>
      </div>
      <CollectModals machine={machine} />
    </div>
  );
}
