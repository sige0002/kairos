// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Right column, top: camera tiles for the robot's cameras plus operator-added
// previews. Panes come from the Collect camera store (cameraStore.ts): seeded
// from the robot's configured stream panes (config.stream.panes) and re-seeded
// on a robot switch, with operator add/remove and per-tile resolution choices
// that survive tab switches. This is v1 Stream-tab parity brought into the v2
// layout language (one large main + a low-res sub column).
//
// Every tile carries a live WebRTC stream, reusing useWebRtcStream directly
// (the MTU/black-preview workarounds live there and are not duplicated here).
// The agreed sub-multiplication mitigation (console v2 design §3-2) is a
// per-screen image budget of ONE operator-resolution stream: the main tile runs
// at the selected preset (Source…240p), every sub tile is limited to the two
// lowest presets (360p/240p, default 240p) so its robot-side encode/egress cost
// stays marginal. Clicking a sub promotes its topic to the main slot (and it
// re-negotiates at the main resolution).

import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../components/ui';
import { useWebRtcStream } from '../../features/stream/useWebRtcStream';
import type { RuntimeConfig } from '../../config';
import { useMonitorRows } from '../../features/monitor/useMonitorRows';
import { topicLiveness, type TopicLiveness } from './warnings';
import type { BatchMachine } from './useBatchMachine';
import { formatElapsed } from './control/shared';
import {
  MAIN_RES_LABELS,
  MAIN_RES_PRESETS,
  MAX_CAMERA_PANES,
  removeCameraPane,
  setMainCameraPane,
  setMainCameraRes,
} from './cameraStore';
import { ROVING_ITEM_ATTR, useRovingRadio } from './hooks/useRovingRadio';
import { HIT_AREA_RES_MAIN } from '../shared/hitArea';
import {
  AddCameraTile,
  CameraPlaceholder,
  OverlayBadge,
  StatsBadge,
  SubCameraTile,
  shortCameraLabel,
} from './CameraTile';
import { useCameraGrid } from './useCameraGrid';
import { useCameraHealth, type CameraHealth } from './useCameraHealth';

// Public surface: everything CollectScreen and the tests imported from this
// module before the CameraTile/useCameraGrid/useCameraHealth split keeps
// resolving here.
export { StatsBadge, isFramesStale, shortCameraLabel } from './CameraTile';
export {
  NO_VIDEO_AFTER_MS,
  __resetNoVideoAfterMs,
  __setNoVideoAfterMs,
  sameCameraHealth,
  type CameraHealth,
} from './useCameraHealth';

export function Cameras({
  config,
  machine,
  onHealthChange,
}: {
  config: RuntimeConfig;
  machine: BatchMachine;
  /** Reports whether the main camera stream is healthy (System status card). */
  onHealthChange?: (health: CameraHealth) => void;
}) {
  const { t } = useTranslation('collect');
  const { panes, mainResLabel, mainPane, mainTopic, mainW, mainH, addOptions } =
    useCameraGrid(config);
  const mainRes = useRovingRadio({
    options: MAIN_RES_LABELS,
    value: mainResLabel,
    onPick: setMainCameraRes,
  });
  const {
    phase,
    stream,
    stats,
    error,
    failure: mainFailure,
    retry,
  } = useWebRtcStream({
    webrtcBase: config.endpoints.webrtc,
    topic: mainTopic ?? '',
    iceServers: config.ice_servers ?? [],
    maxWidth: mainW,
    maxHeight: mainH,
  });

  // Two independent ways a tile can be showing a picture that is not current,
  // and neither implies the other: the transport can stall (frames stop
  // arriving), or the SOURCE can die while the streamer keeps re-encoding the
  // last frame at a real rate. Only the monitor can see the second one.
  //
  // Computed for EVERY pane, not just the main one. Scoping it to the main tile
  // left the sub tiles advertising a live rate beside a main tile that had
  // already owned up — one screen giving two answers about the same dead graph.
  const { rows: monitorRows } = useMonitorRows();
  const paneLiveness = useMemo(() => {
    const byTopic = new Map<string, TopicLiveness>();
    for (const pane of panes) {
      if (pane.topic) byTopic.set(pane.topic, topicLiveness(monitorRows, pane.topic));
    }
    return byTopic;
  }, [panes, monitorRows]);
  const livenessOf = (topic: string | undefined): TopicLiveness =>
    (topic && paneLiveness.get(topic)) || 'unknown';
  const mainLiveness = livenessOf(mainTopic);

  const { onStreamState } = useCameraHealth({
    mainTopic,
    phase,
    mainFailure,
    stats,
    paneLiveness,
    panes,
    onHealthChange,
  });

  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream]);

  const recording = machine.phase === 'recording';
  const elapsedText = formatElapsed(machine.elapsedMs);
  const connected = phase === 'connected' && !!mainTopic;
  const mainLabel = mainTopic ? shortCameraLabel(mainTopic) : t('noCamera');
  // Bottom line keeps only the identity facts (topic · preset · decoded WxH);
  // the live fps/latency moved to the top-right stats chip (v1 placement).
  const mainDims =
    stats.width != null && stats.height != null
      ? ` · ${stats.width}×${stats.height}`
      : '';
  const topicLine = mainTopic
    ? `${mainTopic} · ${mainResLabel}${connected ? mainDims : ` · ${t('waitingForStream')}`}`
    : t('noCameraConfigured');

  if (panes.length === 0) {
    return (
      <div
        data-testid="collect-camera-grid"
        className="flex flex-1 items-center justify-center rounded-card border border-border bg-[#1f2937]"
      >
        <span className="font-mono text-xs text-gray-300">
          {t('noCamerasConfigured')}
        </span>
      </div>
    );
  }

  const subs = panes.filter((p) => p.id !== mainPane?.id);
  const addVisible = panes.length < MAX_CAMERA_PANES;
  const rows = Math.max(1, subs.length + (addVisible ? 1 : 0));
  const hasCol2 = subs.length > 0 || addVisible;

  return (
    <div
      data-testid="collect-camera-grid"
      className="grid min-h-0 flex-1 gap-2"
      style={{
        gridTemplateColumns: hasCol2 ? '2fr 1fr' : '1fr',
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
    >
      <div
        className="relative overflow-hidden rounded-card border border-border bg-[#1f2937]"
        style={{ gridColumn: 1, gridRow: `1 / span ${rows}` }}
      >
        {/* The <video> element must stay mounted across phase changes — it
            was previously swapped in only once `connected`, so its ref was
            still null when the srcObject-assignment effect (keyed on
            `stream`) had already fired, and the element never got the
            stream. Always render it (as StreamTab's VideoSurface does) and
            overlay the placeholder on top until frames actually connect. */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full object-contain"
          data-testid="main-camera-video"
        />
        {!connected && (
          <CameraPlaceholder
            phase={phase}
            error={error}
            onRetry={retry}
            name={mainTopic ? `${mainLabel} · ${mainTopic}` : t('noCamera')}
            className="absolute inset-0"
          />
        )}
        <OverlayBadge className="left-3 top-3 bg-gray-900/75 font-sans text-xs font-semibold text-white">
          {t('mainCamera')} · {mainLabel}
        </OverlayBadge>
        {/* Top-right overlay stack: REC/STANDBY in the corner, the v1-style
            live stats chip right below it — top-right per the user's request,
            with the two chips stacked so nothing overlaps. */}
        <div className="absolute right-3 top-3 flex flex-col items-end gap-1.5">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-chip bg-gray-900/75 px-2.5 py-1 font-mono text-[11.5px] font-bold',
              recording ? 'text-status-danger-text' : 'text-accent',
            )}
          >
            <span
              className={cn(
                'h-[7px] w-[7px] animate-recpulse rounded-sm',
                recording ? 'bg-status-danger-accent' : 'bg-accent',
              )}
            />
            {recording ? t('recordingElapsed', { elapsed: elapsedText }) : t('standby')}
          </span>
          {connected && <StatsBadge stats={stats} sourceLiveness={mainLiveness} />}
        </div>
        {/* Bottom row as ONE flex strip (topic left, RES right) so the two
            chips share the width and can never overlap, whatever the topic
            name length or tile width. */}
        <div className="absolute inset-x-3 bottom-3 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate rounded-chip bg-gray-900/75 px-2.5 py-1 font-mono text-[11px] text-gray-300">
            {topicLine}
          </span>
          {/* One tab stop, not five (#17): these are radio buttons in all but
              markup, so they are a radiogroup — aria-checked says which
              resolution is on, which the background colour alone never told
              anyone. Arrows move focus and Space/Enter commits (APG manual
              activation), because each commit renegotiates the stream. */}
          <div
            ref={mainRes.groupRef}
            data-testid="main-res-group"
            role="radiogroup"
            aria-label={t('mainCameraResolution')}
            onKeyDown={mainRes.onKeyDown}
            className="flex shrink-0 items-center gap-0.5 rounded-chip bg-gray-900/80 p-[3px]"
          >
            <span
              aria-hidden
              className="px-1.5 text-[10px] font-semibold tracking-[0.04em] text-gray-300"
            >
              {t('resolutionAbbr')}
            </span>
            {MAIN_RES_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                role="radio"
                aria-checked={p.label === mainResLabel}
                tabIndex={mainRes.itemTabIndex(p.label)}
                {...{ [ROVING_ITEM_ATTR]: '' }}
                onClick={() => mainRes.commit(p.label)}
                className={cn(
                  'rounded-chip px-2 py-0.5 font-mono text-[10.5px] font-bold',
                  HIT_AREA_RES_MAIN,
                  p.label === mainResLabel
                    ? 'bg-accent-soft text-text-primary'
                    : 'text-gray-300',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {subs.map((pane, i) => (
        <SubCameraTile
          key={pane.id}
          pane={pane}
          config={config}
          onSelect={() => setMainCameraPane(pane.id)}
          onRemove={
            pane.source === 'operator' ? () => removeCameraPane(pane.id) : undefined
          }
          style={{ gridColumn: 2, gridRow: i + 1 }}
          sourceLiveness={livenessOf(pane.topic)}
          onStreamState={onStreamState}
        />
      ))}
      {addVisible && (
        <AddCameraTile
          options={addOptions}
          style={{ gridColumn: 2, gridRow: subs.length + 1 }}
        />
      )}
    </div>
  );
}
