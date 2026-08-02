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
import {
  SystemStatusCard,
  WarningsCard,
  AdviceCard,
  BatchStatsCard,
  CoverageCard,
} from './SideCards';
import { Cameras, sameCameraHealth, type CameraHealth } from './Cameras';
import { EpisodeStrip } from './EpisodeStrip';
import { CollectModals } from './Modals';
import { COL_GAP } from './compact';
import { useBatchMachine, type BatchMachine } from './useBatchMachine';
import { Card, cn } from '../../components/ui';
import { formatBytes, formatHms, formatTimeOfDay } from '../review/format';

// Recovery banner (D-3) for a take stopped but never saved (e.g. a reload
// between Stop and Save). Sits above the control card until the operator labels,
// discards, or dismisses it. All figures are real (or an honest "—").
function UnsavedTakeBanner({ machine }: { machine: BatchMachine }) {
  const take = machine.unsavedTake;
  if (!take) return null;
  return (
    <Card
      role="alert"
      data-testid="unsaved-take-banner"
      className="flex shrink-0 flex-col gap-2 border-2 border-amber-200 bg-amber-50/70 px-4 py-3"
    >
      <span className="text-[13px] text-amber-900" data-testid="unsaved-take-identity">
        {machine.unsavedTakeCount > 1
          ? `${machine.unsavedTakeCount} unsaved takes. Most recent: `
          : take.interrupted
            ? 'Interrupted take from '
            : 'Unsaved take from '}
        <span className="font-semibold">
          {formatTimeOfDay(take.startedAt ?? undefined)}
        </span>{' '}
        — {formatBytes(take.bytes)}, {formatHms(take.durationMs ?? undefined)}. Label it
        now, or discard it.
        {machine.unsavedTakeCount > 1 && ' “Later” hides them all until a new one appears.'}
      </span>
      {/* WHY it ended, not just that it exists. A take the operator did not
          stop themselves is the case where the reason is the whole question,
          and a toast has long since gone by the time they look. */}
      {take.interrupted && (
        <span className="text-[12px] text-amber-800" data-testid="unsaved-take-reason">
          It ended on its own:{' '}
          {take.reason ?? 'the recorder stopped before the take was finished'}.
          Whatever it managed to write is still here.
        </span>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={machine.labelUnsavedTake}
          className="h-9 rounded-control bg-teal-600 px-3.5 text-[12.5px] font-bold text-white hover:bg-teal-700"
        >
          Label it
        </button>
        <button
          type="button"
          onClick={machine.discardUnsavedTake}
          className="h-9 rounded-control border border-gray-200 bg-white px-3.5 text-[12.5px] font-semibold text-gray-600 hover:bg-gray-50"
        >
          Discard
        </button>
        <button
          type="button"
          onClick={machine.dismissUnsavedTake}
          className="h-9 rounded-control px-2 text-[12.5px] font-semibold text-gray-500 hover:underline"
        >
          Later
        </button>
      </div>
    </Card>
  );
}

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

  const [cameraHealth, setCameraHealth] = useState<CameraHealth>({
    streamFailed: false,
    framesStale: false,
    silentTopics: 0,
    unmonitoredTopics: 0,
    totalCameras: 0,
  });
  // Only re-render when a FACT changed, not merely the object carrying it. The
  // producer already memoizes, and this keeps a future caller that forgets from
  // driving a render loop through here.
  const onHealthChange = useCallback((next: CameraHealth) => {
    setCameraHealth((prev) => (sameCameraHealth(prev, next) ? prev : next));
  }, []);

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
    //
    // Scroll fallback, scoped to the ≥900 band (where `justify-center` +
    // `max-h-742` engage): there we switch `h-full` → `h-auto`/`min-h-full` so
    // the console can grow PAST the viewport and the enclosing overflow-auto tab
    // panel scrolls to it, instead of `justify-center` clipping both the context
    // bar's top and the Batch-stats footnote with no way to reach them (verified
    // clipped at 1440×900). Below 900 the console keeps `h-full` so the grid's
    // flex-1 fill + the left column's own internal scroll are unchanged (the
    // ControlCard stays pinned; no page scroll at 1366×768).
    <div
      className={cn(
        'flex flex-col lg:mx-auto lg:h-full lg:min-h-0 lg:w-full lg:max-w-[1480px]',
        '[@media(min-height:900px)]:lg:h-auto [@media(min-height:900px)]:lg:min-h-full',
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
          <UnsavedTakeBanner machine={machine} />
          <ControlCard machine={machine} />
          <div
            className={cn(
              'flex flex-col overflow-y-auto lg:min-h-0 lg:flex-1',
              COL_GAP,
            )}
          >
            <SystemStatusCard
              machine={machine}
              sseStatus={sseStatus}
              monitorBridge={monitorBridge}
              cameraHealth={cameraHealth}
            />
            <WarningsCard machine={machine} defaultTopics={defaultTopics} />
            <AdviceCard machine={machine} />
            <BatchStatsCard machine={machine} />
            <CoverageCard machine={machine} />
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
