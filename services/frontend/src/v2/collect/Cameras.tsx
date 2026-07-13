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
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { TopicInfo } from '../../api/types';
import { cn } from '../../components/ui';
import { useWebRtcStream, type StreamStats } from '../../features/stream/useWebRtcStream';
import type { RuntimeConfig } from '../../config';
import type { BatchMachine } from './useBatchMachine';
import {
  MAIN_RES_PRESETS,
  MAX_CAMERA_PANES,
  SUB_RES_LABELS,
  addCameraPane,
  imageTopicOptions,
  removeCameraPane,
  resBounds,
  seedCameraPanes,
  setMainCameraPane,
  setMainCameraRes,
  setSubCameraRes,
  useCameraStore,
  type CameraOption,
  type CameraPane,
  type SubResLabel,
} from './cameraStore';

/** Short, human camera name derived from its ROS topic, e.g.
 *  "/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed" -> "head",
 *  "/hsrb/hand_camera/image_raw/compressed" -> "hand". Falls back to the
 *  topic's first path segment if nothing looks camera-shaped. */
export function shortCameraLabel(topic: string): string {
  const segments = topic.split('/').filter(Boolean);
  const candidate = segments.find((s) => /cam|sensor/i.test(s)) ?? segments[0] ?? topic;
  const cleaned = candidate
    .replace(/_?(rgbd?|rgb|depth|color)?_?(sensor|camera|cam)s?$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return cleaned || candidate;
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `00:${mm}:${ss}`;
}

/** Real receive-side stats line for an overlay badge — only the values the hook
 *  actually measured (honesty: never a synthesized fps/latency to fill a slot).
 *  `withRes` appends the decoded WxH (main tile only). */
function statsLine(stats: StreamStats, withRes: boolean): string {
  const parts: string[] = [];
  if (stats.fps != null) parts.push(`${stats.fps} fps`);
  if (stats.latencyMs != null) parts.push(`${stats.latencyMs} ms`);
  if (withRes && stats.width != null && stats.height != null) {
    parts.push(`${stats.width}×${stats.height}`);
  }
  return parts.join(' · ');
}

function PlaceholderTile({ label, className }: { label: string; className?: string }) {
  return (
    <div
      className={cn('flex items-center justify-center border border-gray-200', className)}
      style={{
        backgroundImage:
          'repeating-linear-gradient(45deg,#1f2937 0px,#1f2937 14px,#243042 14px,#243042 28px)',
      }}
    >
      <span className="truncate px-3 font-mono text-xs text-gray-500">{label}</span>
    </div>
  );
}

function OverlayBadge({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'absolute rounded-chip bg-gray-900/75 px-2.5 py-1 font-mono text-[11px] text-gray-300',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Compact segmented control for a sub tile's resolution (360p/240p only). */
function SubResToggle({ value, onPick }: { value: SubResLabel; onPick: (l: SubResLabel) => void }) {
  return (
    <div
      className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-chip bg-gray-900/80 p-[2px]"
      // Don't let a res click bubble to the tile's click-to-main handler.
      onClick={(e) => e.stopPropagation()}
    >
      {SUB_RES_LABELS.map((label) => (
        <button
          key={label}
          type="button"
          onClick={() => onPick(label)}
          title={`Sub preview resolution — subs stay low-res by design (§3-2)`}
          className={cn(
            'rounded-chip px-1.5 py-0.5 font-mono text-[9.5px] font-bold',
            label === value ? 'bg-teal-300 text-gray-900' : 'text-gray-400',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function SubCameraTile({
  pane,
  config,
  onSelect,
  onRemove,
  style,
}: {
  pane: CameraPane;
  config: RuntimeConfig;
  onSelect: () => void;
  /** Provided only for operator-added panes (config cameras aren't removable). */
  onRemove?: () => void;
  style: React.CSSProperties;
}) {
  const { w, h } = resBounds(pane.subResLabel);
  const { phase, stream, stats } = useWebRtcStream({
    webrtcBase: config.endpoints.webrtc,
    topic: pane.topic,
    iceServers: config.ice_servers ?? [],
    maxWidth: w,
    maxHeight: h,
  });
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream]);
  const connected = phase === 'connected';
  const label = shortCameraLabel(pane.topic);
  const line = connected ? statsLine(stats, false) : 'connecting…';
  return (
    // A plain clickable tile (as the design mock's sub cameras are) rather than a
    // <button>, so the resolution toggle and remove control can nest inside it
    // without invalid button-in-button semantics.
    <div
      onClick={onSelect}
      title={`${pane.topic} — click to make this the main camera`}
      data-testid="sub-camera-tile"
      className="relative cursor-pointer overflow-hidden rounded-card border border-gray-200 bg-[#1f2937] hover:border-teal-500"
      style={style}
    >
      {/* Always mounted, like the main tile — see the comment there. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="h-full w-full object-contain"
        data-testid="sub-camera-video"
      />
      {!connected && <PlaceholderTile className="absolute inset-0" label={`camera — ${label}`} />}
      <SubResToggle value={pane.subResLabel} onPick={(l) => setSubCameraRes(pane.id, l)} />
      {onRemove && (
        <button
          type="button"
          aria-label={`remove ${label} camera`}
          title="Remove this camera preview"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-chip bg-gray-900/80 text-[13px] font-bold leading-none text-gray-300 hover:bg-red-500 hover:text-white"
        >
          ×
        </button>
      )}
      <OverlayBadge className="bottom-2 left-2 max-w-[92%] truncate px-2 py-0.5 text-[10px]">
        {label}
        {line ? ` · ${line}` : ''}
      </OverlayBadge>
    </div>
  );
}

/** The "+ Add camera" tile: pick a discovered/configured image topic to open a
 *  new operator pane. Visible only below the pane cap. */
function AddCameraTile({
  options,
  style,
}: {
  options: CameraOption[];
  style: React.CSSProperties;
}) {
  return (
    <div
      data-testid="add-camera-tile"
      className="flex min-w-0 flex-col items-center justify-center gap-2 overflow-hidden rounded-card border border-dashed border-gray-300 bg-gray-50 p-3"
      style={style}
    >
      <span className="text-xl font-semibold text-gray-400">+</span>
      <span className="text-[11px] font-semibold text-gray-500">Add camera</span>
      <select
        aria-label="add camera topic"
        data-testid="add-camera-select"
        value=""
        onChange={(e) => {
          if (e.target.value) addCameraPane(e.target.value);
          // Value stays "" (it's an action trigger, not a persistent selection).
        }}
        className="w-full max-w-[92%] rounded-control border border-gray-200 bg-white px-2 py-1 font-mono text-[11px] text-gray-700 focus:border-teal-500 focus:outline-none"
      >
        <option value="" disabled>
          {options.length === 0 ? 'No image topics found' : 'Choose a camera…'}
        </option>
        {options.map((o) => (
          <option key={o.name} value={o.name}>
            {shortCameraLabel(o.name)}
            {o.live ? '' : ' (offline)'}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Cameras({
  config,
  machine,
  onHealthChange,
}: {
  config: RuntimeConfig;
  machine: BatchMachine;
  /** Reports whether the main camera stream is healthy (System status card). */
  onHealthChange?: (ok: boolean) => void;
}) {
  // Seed / re-seed the camera store from the robot's configured cameras. Keyed
  // by the configured topic list so a robot switch re-seeds (new cameras),
  // while tab switches keep operator-added panes and per-tile resolutions.
  const configuredTopics = useMemo(() => {
    const panes = config.stream?.panes ?? [];
    const topics = panes.map((p) => p.topic).filter((t): t is string => !!t);
    return Array.from(new Set(topics));
  }, [config.stream]);
  useEffect(() => {
    seedCameraPanes(configuredTopics, JSON.stringify(configuredTopics));
  }, [configuredTopics]);

  const { panes, mainId, mainResLabel } = useCameraStore();

  // Live camera-topic discovery for the add-camera dropdown (same source and
  // cadence as v1 StreamTab). Merged with the configured default camera topics.
  const topicsQuery = useQuery({
    queryKey: queryKeys.topics,
    queryFn: ({ signal }) =>
      apiGet<TopicInfo[] | { topics?: TopicInfo[]; items?: TopicInfo[] }>('/topics', { signal }),
    refetchInterval: 5000,
  });
  const usedTopics = useMemo(() => new Set(panes.map((p) => p.topic)), [panes]);
  const addOptions = useMemo(
    () =>
      imageTopicOptions(topicsQuery.data, config.defaults.default_topics ?? []).filter(
        (o) => !usedTopics.has(o.name),
      ),
    [topicsQuery.data, config.defaults.default_topics, usedTopics],
  );

  const mainPane = panes.find((p) => p.id === mainId) ?? panes[0];
  const mainTopic = mainPane?.topic;
  const { w: mainW, h: mainH } = resBounds(mainResLabel);

  const { phase, stream, stats } = useWebRtcStream({
    webrtcBase: config.endpoints.webrtc,
    topic: mainTopic ?? '',
    iceServers: config.ice_servers ?? [],
    maxWidth: mainW,
    maxHeight: mainH,
  });

  useEffect(() => {
    onHealthChange?.(phase !== 'failed');
  }, [phase, onHealthChange]);

  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream]);

  const recording = machine.phase === 'recording';
  const elapsedText = formatElapsed(machine.elapsedMs);
  const connected = phase === 'connected' && !!mainTopic;
  const mainLabel = mainTopic ? shortCameraLabel(mainTopic) : 'none';
  const mainStats = statsLine(stats, true);
  const topicLine = mainTopic
    ? `${mainTopic} · ${mainResLabel}${connected ? (mainStats ? ` · ${mainStats}` : '') : ' · waiting for stream…'}`
    : 'no camera configured for this robot';

  if (panes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-card border border-gray-200 bg-[#1f2937]">
        <span className="font-mono text-xs text-gray-500">
          No cameras configured for this robot.
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
      className="grid flex-1 gap-2"
      style={{
        gridTemplateColumns: hasCol2 ? '2fr 1fr' : '1fr',
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
    >
      <div
        className="relative overflow-hidden rounded-card border border-gray-200 bg-[#1f2937]"
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
          <PlaceholderTile
            className="absolute inset-0"
            label={`live camera preview — ${mainTopic ?? '—'}`}
          />
        )}
        <OverlayBadge className="left-3 top-3 bg-gray-900/75 font-sans text-xs font-semibold text-white">
          Main camera · {mainLabel}
        </OverlayBadge>
        <span
          className={cn(
            'absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-chip bg-gray-900/75 px-2.5 py-1 font-mono text-[11.5px] font-bold',
            recording ? 'text-red-300' : 'text-teal-300',
          )}
        >
          <span
            className={cn(
              'h-[7px] w-[7px] animate-recpulse rounded-sm',
              recording ? 'bg-red-500' : 'bg-teal-400',
            )}
          />
          {recording ? `REC ${elapsedText}` : 'STANDBY'}
        </span>
        <OverlayBadge className="bottom-3 left-3 max-w-[70%] truncate">{topicLine}</OverlayBadge>
        <div
          data-testid="main-res-group"
          className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-chip bg-gray-900/80 p-[3px]"
        >
          <span className="px-1.5 text-[10px] font-semibold tracking-[0.04em] text-gray-400">
            RES
          </span>
          {MAIN_RES_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setMainCameraRes(p.label)}
              className={cn(
                'rounded-chip px-2 py-0.5 font-mono text-[10.5px] font-bold',
                p.label === mainResLabel ? 'bg-teal-300 text-gray-900' : 'text-gray-400',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {subs.map((pane, i) => (
        <SubCameraTile
          key={pane.id}
          pane={pane}
          config={config}
          onSelect={() => setMainCameraPane(pane.id)}
          onRemove={pane.source === 'operator' ? () => removeCameraPane(pane.id) : undefined}
          style={{ gridColumn: 2, gridRow: i + 1 }}
        />
      ))}
      {addVisible && (
        <AddCameraTile options={addOptions} style={{ gridColumn: 2, gridRow: subs.length + 1 }} />
      )}
    </div>
  );
}
