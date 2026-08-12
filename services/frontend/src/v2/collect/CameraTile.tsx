// Presentational pieces of the Collect camera wall, split out of Cameras.tsx:
// the stats/placeholder/overlay chips, the sub-tile (with its own WebRTC
// stream) and the add-camera tile. Container logic stays in Cameras.tsx.

import { useEffect, useRef } from 'react';
import { cn } from '../../components/ui';
import {
  useWebRtcStream,
  type StreamFailure,
  type StreamStats,
  type StreamPhase,
  FRAME_STALE_MS,
} from '../../features/stream/useWebRtcStream';
import type { RuntimeConfig } from '../../config';
import type { TopicLiveness } from './warnings';
import {
  SUB_RES_LABELS,
  addCameraPane,
  resBounds,
  setSubCameraRes,
  type CameraOption,
  type CameraPane,
  type SubResLabel,
} from './cameraStore';
import { ROVING_ITEM_ATTR, useRovingRadio } from './hooks/useRovingRadio';
import { HIT_AREA_RES_SUB } from '../shared/hitArea';

/** True once the decoded-frame count has stood still past the deadline. */
export function isFramesStale(stats: StreamStats): boolean {
  return stats.framesStaleMs != null && stats.framesStaleMs >= FRAME_STALE_MS;
}

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

/** v1 StreamTab's latency-threshold colour for the preview latency chip: high
 *  is red, caution amber, normal teal. This is WebRTC preview latency
 *  (getStats), independent of the ROS recording path. */
function latColor(ms: number): string {
  return ms > 150 ? '#dc2626' : ms >= 85 ? '#d97706' : '#0d9488';
}

export function StatsBadge({
  stats,
  className,
  sourceLiveness = 'unknown',
}: {
  stats: StreamStats;
  className?: string;
  /** What the monitor can say about the SOURCE topic. The stream keeps
   *  delivering a real frame rate whatever the source does — it re-encodes the
   *  frozen last frame — so the transport rate may only be shown when nothing
   *  contradicts it, and never as evidence that the picture is current. */
  sourceLiveness?: TopicLiveness;
}) {
  if (sourceLiveness === 'silent') {
    return (
      <span
        data-testid="camera-stats"
        data-topic-silent="true"
        title={
          'The monitor reports this topic has stopped publishing. The stream is ' +
          'still delivering frames, but they are re-encodings of the last one ' +
          'that arrived — the picture is not current.'
        }
        className={cn(
          'inline-flex items-center gap-1.5 rounded-chip bg-amber-500/90 px-2.5 py-1 font-mono text-[11px] font-semibold text-gray-900',
          className,
        )}
      >
        topic silent — showing the last frame
      </span>
    );
  }
  if (sourceLiveness === 'unmonitored') {
    // Nobody is measuring this topic, so the only rate available is the
    // transport's — and that one keeps reading 15fps over a dead source. Grey,
    // not amber: this is an absence of evidence, not a fault. The chip says
    // what it cannot tell rather than filling the slot with a number that means
    // something else.
    return (
      <span
        data-testid="camera-stats"
        data-topic-unmonitored="true"
        title={
          'This topic is outside the monitored set, so nothing measures whether ' +
          'it is still publishing. The preview keeps delivering frames either ' +
          'way — including re-encodings of a frozen last frame — so no rate is ' +
          'shown here. The picture may or may not be current.'
        }
        className={cn(
          'inline-flex items-center gap-1.5 rounded-chip bg-gray-900/75 px-2.5 py-1 font-mono text-[11px] text-gray-300',
          className,
        )}
      >
        not monitored — no rate available
      </span>
    );
  }
  return <StreamStatsBadge stats={stats} className={className} />;
}

function StreamStatsBadge({ stats, className }: { stats: StreamStats; className?: string }) {
  // Frames have stopped advancing. The connection is still up and getStats will
  // happily keep reporting its last framesPerSecond, but no picture is arriving
  // — so the chip reports what it can actually measure (how long since the last
  // frame) instead of a rate nothing is producing.
  const stale = isFramesStale(stats);
  if (stale) {
    return (
      <span
        data-testid="camera-stats"
        data-stale="true"
        title={
          'No new frames have decoded since this counter started. The stream is ' +
          'still connected, so this is usually the source topic losing its ' +
          'publisher rather than a network problem.'
        }
        className={cn(
          'inline-flex items-center gap-1.5 rounded-chip bg-amber-500/90 px-2.5 py-1 font-mono text-[11px] font-semibold text-gray-900',
          className,
        )}
      >
        no frames for {Math.round((stats.framesStaleMs ?? 0) / 1000)}s
      </span>
    );
  }
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
export function CameraPlaceholder({
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
            className="max-w-full truncate font-mono text-[11px] text-gray-500"
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
            className="mt-0.5 rounded-control border border-gray-500 bg-gray-900/70 px-3 py-1 text-[11.5px] font-semibold text-teal-200 hover:bg-gray-800"
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

export function OverlayBadge({ className, children }: { className: string; children: React.ReactNode }) {
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
function SubResToggle({
  value,
  onPick,
  cameraLabel,
}: {
  value: SubResLabel;
  onPick: (l: SubResLabel) => void;
  /** Which camera this group belongs to. Up to three sub tiles are on screen at
   *  once, so a shared label would leave a screen-reader user with three groups
   *  called the same thing and no way to tell which stream they were changing. */
  cameraLabel: string;
}) {
  // One tab stop per tile, not two (#17) — with three tiles on screen those
  // chips were six of the nine stops between Start and anything else. Arrows
  // move focus and Space/Enter commits: each commit renegotiates this tile's
  // stream.
  const res = useRovingRadio({ options: SUB_RES_LABELS, value, onPick });
  return (
    <div
      ref={res.groupRef}
      role="radiogroup"
      aria-label={`${cameraLabel} camera resolution`}
      onKeyDown={res.onKeyDown}
      className="flex items-center gap-0.5 rounded-chip bg-gray-900/80 p-[2px]"
    >
      {SUB_RES_LABELS.map((label) => (
        <button
          key={label}
          type="button"
          role="radio"
          aria-checked={label === value}
          tabIndex={res.itemTabIndex(label)}
          {...{ [ROVING_ITEM_ATTR]: '' }}
          onClick={() => res.commit(label)}
          title={`Sub preview resolution — subs stay low-res by design (§3-2)`}
          className={cn(
            'rounded-chip px-1.5 py-0.5 font-mono text-[9.5px] font-bold',
            HIT_AREA_RES_SUB,
            label === value ? 'bg-teal-300 text-gray-900' : 'text-gray-300',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function SubCameraTile({
  pane,
  config,
  onSelect,
  onRemove,
  onStreamState,
  style,
  sourceLiveness = 'unknown',
}: {
  pane: CameraPane;
  config: RuntimeConfig;
  onSelect: () => void;
  /** Provided only for operator-added panes (config cameras aren't removable). */
  onRemove?: () => void;
  style: React.CSSProperties;
  /** What the monitor can say about this pane's SOURCE topic. */
  sourceLiveness?: TopicLiveness;
  /** Report this pane's own stream state up, so the System card can speak for
   *  the whole wall instead of for the main tile (E-37). */
  onStreamState?: (
    topic: string,
    down: boolean,
    failure: StreamFailure | null,
    waitingSince: number | null,
  ) => void;
}) {
  const { w, h } = resBounds(pane.subResLabel);
  const { phase, stream, stats, error, failure, retry } = useWebRtcStream({
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
  // 'failed' only — a stream still negotiating is not yet a fault, and calling
  // it one would make every page load flash a camera warning.
  // `since` is when THIS attempt began, on the monotonic clock — the wall clock
  // is not a stopwatch (E-32) and this figure is a duration measured here.
  // Reported as null once connected: a pane carrying video is not waiting.
  const attemptSinceRef = useRef<number | null>(null);
  if (phase !== 'connected' && attemptSinceRef.current === null) {
    attemptSinceRef.current = performance.now();
  }
  if (phase === 'connected') attemptSinceRef.current = null;
  useEffect(() => {
    if (pane.topic) {
      onStreamState?.(pane.topic, phase === 'failed', failure, attemptSinceRef.current);
    }
  }, [pane.topic, phase, failure, onStreamState]);
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
        <SubResToggle
          value={pane.subResLabel}
          onPick={(l) => setSubCameraRes(pane.id, l)}
          cameraLabel={label}
        />
        {connected && (
          <StatsBadge
            stats={stats}
            sourceLiveness={sourceLiveness}
            className="px-1.5 py-0.5 text-[10px]"
          />
        )}
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
export function AddCameraTile({
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
      <span className="text-xl font-semibold text-gray-500">+</span>
      <span className="text-[11px] font-semibold text-gray-500">Add camera</span>
      <select
        aria-label="add camera topic"
        data-testid="add-camera-select"
        value=""
        onChange={(e) => {
          if (e.target.value) addCameraPane(e.target.value);
          // Value stays "" (it's an action trigger, not a persistent selection).
        }}
        className="w-full max-w-[92%] rounded-control border border-gray-200 bg-white px-2 py-1 font-mono text-[11px] text-gray-700 focus:border-teal-600 focus:outline-none"
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
