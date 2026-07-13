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
    // Cap the console width and center it on large screens. Without a cap the
    // right column's `1fr` track (and thus the camera tile) grows unbounded — a
    // 640×480 preview balloons to ~1440px wide on a 2560 display. ~1480px keeps
    // the whole console (context bar + both columns) aligned and centered, and
    // holds the main camera tile near its 4:3 source aspect. Below the cap
    // (≤1366) it's a no-op, so the compact single-page layout is unchanged.
    <div
      className={cn(
        'flex flex-col lg:mx-auto lg:h-full lg:min-h-0 lg:w-full lg:max-w-[1480px]',
        // On tall viewports the capped camera height frees vertical space; center
        // the console block so that space is shared top and bottom (an
        // intentional centered console) rather than pinned to the top. Gated on
        // min-height so the short 1366×768 layout — which relies on the grid row
        // filling and the left cards scrolling internally — is untouched.
        '[@media(min-height:900px)]:lg:justify-center',
        COL_GAP,
      )}
    >
      <ContextBar machine={machine} />
      <div
        className={cn(
          'grid grid-cols-1 lg:min-h-0 lg:flex-1 lg:grid-cols-[340px_1fr]',
          // Paired with the console's min-height centering: CAP the row's height
          // on tall screens (742px = the console's natural height at the 600px
          // camera cap + episode strip) instead of flex-none'ing it. flex-1 +
          // max-h means: when the viewport has room the row stops at its natural
          // height and the centering has slack to distribute; when it does NOT
          // (e.g. a ~900px-tall window, where flex-none used to overflow by
          // ~22px and justify-center clipped the context bar's top AND the batch
          // stats' bottom), the row shrinks to fit and the left column falls
          // back to its internal scroll — nothing is ever clipped. Short screens
          // (<900) are untouched: plain lg:flex-1 fill + internal scroll.
          '[@media(min-height:900px)]:lg:max-h-[742px]',
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
        {/* min-w-0: this is the grid's `1fr` track — without it the camera
            column's intrinsic content width (the tiles + the add-camera select)
            makes the track exceed its share and clips the sub column at the
            viewport edge. min-w-0 lets the fr track shrink so the tiles fit. */}
        <div className={cn('flex flex-col lg:min-h-0 lg:min-w-0', COL_GAP)}>
          <Cameras config={config} machine={machine} onHealthChange={onHealthChange} />
          <EpisodeStrip machine={machine} />
        </div>
      </div>
      <CollectModals machine={machine} />
    </div>
  );
}
