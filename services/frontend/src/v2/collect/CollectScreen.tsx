// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
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
import { ExternalActionHud } from './ExternalActionHud';
import { COL_GAP } from './compact';
import { useBatchMachine, type BatchMachine } from './useBatchMachine';
import { Card, cn } from '../../components/ui';
import { formatBytes, formatHms, formatTimeOfDay } from '../review/format';
import { ScreenTitle } from '../shared/ScreenTitle';

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
      className={cn(
        'flex shrink-0 flex-col gap-2 border-2 border-amber-200 bg-amber-50/70 px-4 py-3',
        // The one Collect surface that had no compact step. It sits in the
        // PINNED half of the left column, above the ControlCard, so every
        // pixel it takes at a short height is a pixel of headroom the primary
        // action loses (measured: at 1067x600 the card's headroom is 150px
        // with this banner up, against 260px without it). Same threshold and
        // the same "trim, never hide" rule as compact.ts.
        '[@media(max-height:860px)]:gap-1.5 [@media(max-height:860px)]:py-2',
      )}
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
          className="h-9 [@media(max-height:860px)]:h-8 rounded-control bg-teal-700 px-3.5 text-[12.5px] font-bold text-white hover:bg-teal-800"
        >
          Label it
        </button>
        <button
          type="button"
          onClick={machine.discardUnsavedTake}
          disabled={machine.unsavedDiscard.busy}
          className="h-9 [@media(max-height:860px)]:h-8 rounded-control border border-gray-200 bg-white px-3.5 text-[12.5px] font-semibold text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Discard
        </button>
        <button
          type="button"
          onClick={machine.dismissUnsavedTake}
          className="h-9 [@media(max-height:860px)]:h-8 rounded-control px-2 text-[12.5px] font-semibold text-gray-500 hover:underline"
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
    streamsDown: 0,
    streamFault: null,
    streamsNoVideo: 0,
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
    return (
      <>
        <ScreenTitle>Collect</ScreenTitle>
        <div className="p-4 text-sm text-gray-500">Loading…</div>
      </>
    );
  }

  return (
    <div
      data-testid="collect-layout"
      className={cn('flex flex-col lg:h-full lg:min-h-0 lg:w-full', COL_GAP)}
    >
      <ScreenTitle>Collect</ScreenTitle>
      <ContextBar machine={machine} />
      <div
        data-testid="collect-main-grid"
        className={cn(
          // Pin the one desktop grid row to the available height. An implicit
          // auto row takes the left cards' min-content height instead, so its
          // children can overflow a shorter grid even when the grid itself is
          // constrained. Datasets uses the same minmax(0,1fr) invariant.
          'grid grid-cols-1 lg:min-h-0 lg:flex-1 lg:grid-cols-[340px_1fr] lg:grid-rows-[minmax(0,1fr)]',
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
          <ExternalActionHud
            meanings={machine.externalActionMeanings}
            taskName={machine.externalActionTaskName}
          />
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
            <WarningsCard
              machine={machine}
              defaultTopics={defaultTopics}
              config={config}
            />
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
