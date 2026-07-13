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
import {
  useWebRtcStream,
  type StreamStats,
  type StreamPhase,
} from '../../features/stream/useWebRtcStream';
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

/** v1 StreamTab's latency-threshold colour for the preview latency chip: high
 *  is red, caution amber, normal teal. This is WebRTC preview latency
 *  (getStats), independent of the ROS recording path. */
function latColor(ms: number): string {
  return ms > 150 ? '#dc2626' : ms >= 85 ? '#d97706' : '#0d9488';
}

/** v1-style live stats chip — latency (threshold colour) + fps, placed at the
 *  tile's top-right (user preference over the mock's bottom stats line). Only
 *  the values the hook actually measured are rendered (honesty: never a
 *  synthesized fps/latency to fill a slot); nothing at all until one exists. */
export function StatsBadge({ stats, className }: { stats: StreamStats; className?: string }) {
  if (stats.latencyMs == null && stats.fps == null) return null;
  return (
    <span
      data-testid="camera-stats"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-chip bg-gray-900/75 px-2.5 py-1 font-mono text-[11px]',
        className,
      )}
    >
      {stats.latencyMs != null && (
        <span className="font-semibold" style={{ color: latColor(stats.latencyMs) }}>
          {stats.latencyMs}ms
        </span>
      )}
      {stats.latencyMs != null && stats.fps != null && <span className="text-gray-500">·</span>}
      {stats.fps != null && <span className="text-gray-300">{stats.fps}fps</span>}
    </span>
  );
}

/** Overlay for a camera tile with no frames yet. It names the state the
 *  operator needs to distinguish — still CONNECTING (a spinner + "Connecting to
 *  camera…") vs FAILED (the reason + a Retry that re-triggers the WebRTC
 *  connect) — so a blank tile never silently reads as a failure, and a real
 *  failure is recoverable in place. `phase === 'failed'` is the same signal the
 *  SYSTEM STATUS Cameras row reads (onHealthChange), so the two always agree. */
function CameraPlaceholder({
  phase,
  error,
  onRetry,
  name,
  className,
}: {
  phase: StreamPhase;
  error: string | null;
  onRetry: () => void;
  /** Human camera name (identity), shown muted under the status line. */
  name: string;
  className?: string;
}) {
  const failed = phase === 'failed';
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-1.5 border border-gray-200 px-3 text-center',
        className,
      )}
      style={{
        backgroundImage:
          'repeating-linear-gradient(45deg,#1f2937 0px,#1f2937 14px,#243042 14px,#243042 28px)',
      }}
    >
      {failed ? (
        <>
          <span aria-hidden className="text-lg leading-none text-amber-400">
            ⚠
          </span>
          <span className="font-sans text-xs font-semibold text-gray-200">
            Camera preview unavailable
          </span>
          <span
            className="max-w-full truncate font-mono text-[11px] text-gray-400"
            title={error ?? undefined}
          >
            {error ?? "the WebRTC stream couldn't connect"}
          </span>
          <span className="max-w-full truncate font-mono text-[10.5px] text-gray-500">{name}</span>
          <button
            type="button"
            data-testid="camera-retry"
            onClick={(e) => {
              e.stopPropagation();
              onRetry();
            }}
            className="mt-0.5 rounded-control border border-gray-500 bg-gray-900/70 px-3 py-1 text-[11.5px] font-semibold text-teal-300 hover:bg-gray-800"
          >
            Retry
          </button>
        </>
      ) : (
        <>
          <span
            aria-hidden
            data-testid="camera-connecting-spinner"
            className="h-6 w-6 animate-spin rounded-full border-2 border-gray-600 border-t-teal-400"
          />
          <span className="font-sans text-xs font-semibold text-gray-300">
            Connecting to camera…
          </span>
          <span className="max-w-full truncate font-mono text-[10.5px] text-gray-500">{name}</span>
        </>
      )}
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

/** Compact segmented control for a sub tile's resolution (360p/240p only).
 *  Positioned by its parent (the tile's top-right overlay stack). */
function SubResToggle({ value, onPick }: { value: SubResLabel; onPick: (l: SubResLabel) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-chip bg-gray-900/80 p-[2px]">
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
  const { phase, stream, stats, error, retry } = useWebRtcStream({
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
      {!connected && (
        <CameraPlaceholder
          phase={phase}
          error={error}
          onRetry={retry}
          name={label}
          className="absolute inset-0"
        />
      )}
      {/* Top-right overlay stack: res toggle, then the v1-style live stats
          below it — the corner placement the user asked for, without the two
          chips overlapping each other (or the remove control at top-left). */}
      <div
        className="absolute right-1.5 top-1.5 flex flex-col items-end gap-1"
        // Don't let a res/stats click bubble to the tile's click-to-main handler.
        onClick={(e) => e.stopPropagation()}
      >
        <SubResToggle value={pane.subResLabel} onPick={(l) => setSubCameraRes(pane.id, l)} />
        {connected && <StatsBadge stats={stats} className="px-1.5 py-0.5 text-[10px]" />}
      </div>
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

  const { phase, stream, stats, error, retry } = useWebRtcStream({
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
  // Bottom line keeps only the identity facts (topic · preset · decoded WxH);
  // the live fps/latency moved to the top-right stats chip (v1 placement).
  const mainDims =
    stats.width != null && stats.height != null ? ` · ${stats.width}×${stats.height}` : '';
  const topicLine = mainTopic
    ? `${mainTopic} · ${mainResLabel}${connected ? mainDims : ' · waiting for stream…'}`
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
    // max-h caps the camera area's height on tall/large screens so a small
    // (e.g. 640×480) stream isn't stretched to fill the whole column — object-
    // contain would otherwise upscale it to dominate the screen. The cap sits
    // above the compact 1366×768 height (~534px) so it's a no-op there and only
    // engages on larger displays; the freed vertical space lets the column
    // breathe. Width is bounded by CollectScreen's console max-width.
    <div
      className="grid flex-1 gap-2 lg:max-h-[600px]"
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
          <CameraPlaceholder
            phase={phase}
            error={error}
            onRetry={retry}
            name={mainTopic ? `${mainLabel} · ${mainTopic}` : 'no camera'}
            className="absolute inset-0"
          />
        )}
        <OverlayBadge className="left-3 top-3 bg-gray-900/75 font-sans text-xs font-semibold text-white">
          Main camera · {mainLabel}
        </OverlayBadge>
        {/* Top-right overlay stack: REC/STANDBY in the corner, the v1-style
            live stats chip right below it — top-right per the user's request,
            with the two chips stacked so nothing overlaps. */}
        <div className="absolute right-3 top-3 flex flex-col items-end gap-1.5">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-chip bg-gray-900/75 px-2.5 py-1 font-mono text-[11.5px] font-bold',
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
          {connected && <StatsBadge stats={stats} />}
        </div>
        {/* Bottom row as ONE flex strip (topic left, RES right) so the two
            chips share the width and can never overlap, whatever the topic
            name length or tile width. */}
        <div className="absolute inset-x-3 bottom-3 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate rounded-chip bg-gray-900/75 px-2.5 py-1 font-mono text-[11px] text-gray-300">
            {topicLine}
          </span>
          <div
            data-testid="main-res-group"
            className="flex shrink-0 items-center gap-0.5 rounded-chip bg-gray-900/80 p-[3px]"
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
