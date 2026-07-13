// Right column, top: camera tiles derived from the robot's actually
// configured stream panes (config.stream.panes — the same source StreamTab
// seeds its panes from). This is NOT a fixed mock 'top/left/right' layout:
// only as many tiles render as the robot has cameras, redistributing the
// space rather than showing empty frames for cameras that don't exist (a
// 2-camera robot like the HSR sample rig gets exactly 2 tiles).
//
// Every tile carries a live WebRTC stream, reusing useWebRtcStream directly
// (the MTU/black-preview workarounds live there and are not duplicated here).
// The agreed sub-multiplication mitigation (console v2 design §3-2) is a
// per-screen image budget of ONE operator-resolution stream: the main tile
// runs at the selected preset, every sub tile is force-capped to 320x240 so
// its robot-side encode/egress cost stays marginal. Clicking a sub swaps its
// topic into the main slot (and the demoted topic drops to the sub cap).

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../components/ui';
import { useWebRtcStream } from '../../features/stream/useWebRtcStream';
import type { RuntimeConfig } from '../../config';
import type { BatchMachine } from './useBatchMachine';

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

const RES_PRESETS: { label: string; w: number; h: number }[] = [
  { label: '720p', w: 1280, h: 720 },
  { label: '480p', w: 640, h: 480 },
  { label: '240p', w: 320, h: 240 },
];

// Forced cap for every sub tile — the "sub cameras are always low-res" half of
// the image-budget rule in the file header.
const SUB_MAX = { w: 320, h: 240 };

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

function SubCameraTile({
  topic,
  config,
  onSelect,
  style,
}: {
  topic: string;
  config: RuntimeConfig;
  onSelect: () => void;
  style: React.CSSProperties;
}) {
  const { phase, stream, stats } = useWebRtcStream({
    webrtcBase: config.endpoints.webrtc,
    topic,
    iceServers: config.ice_servers ?? [],
    maxWidth: SUB_MAX.w,
    maxHeight: SUB_MAX.h,
  });
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream]);
  const connected = phase === 'connected';
  const label = shortCameraLabel(topic);
  return (
    <button
      type="button"
      onClick={onSelect}
      title={`${topic} — click to make this the main camera`}
      data-testid="sub-camera-tile"
      className="relative overflow-hidden rounded-card border border-gray-200 bg-[#1f2937] hover:border-teal-500"
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
        <PlaceholderTile className="absolute inset-0" label={`camera — ${label}`} />
      )}
      <OverlayBadge className="bottom-2 left-2 max-w-[90%] truncate px-2 py-0.5 text-[10px]">
        {label} · {connected ? `${stats.fps ?? '—'} fps` : 'connecting…'}
      </OverlayBadge>
    </button>
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
  // The robot's actual configured cameras, in configured order, deduped.
  const cameraTopics = useMemo(() => {
    const panes = config.stream?.panes ?? [];
    const topics = panes.map((p) => p.topic).filter((t): t is string => !!t);
    return Array.from(new Set(topics));
  }, [config.stream]);

  const [mainTopic, setMainTopic] = useState<string | undefined>(cameraTopics[0]);
  useEffect(() => {
    // Re-seed if the configured list changed (e.g. a robot switch) and the
    // current pick is no longer in it; otherwise keep the operator's choice.
    setMainTopic((prev) => (prev && cameraTopics.includes(prev) ? prev : cameraTopics[0]));
  }, [cameraTopics]);

  const subTopics = useMemo(
    () => cameraTopics.filter((t) => t !== mainTopic),
    [cameraTopics, mainTopic],
  );

  const [res, setRes] = useState(RES_PRESETS[1]!); // 480p, matches the design mock's default

  const { phase, stream, stats } = useWebRtcStream({
    webrtcBase: config.endpoints.webrtc,
    topic: mainTopic ?? '',
    iceServers: config.ice_servers ?? [],
    maxWidth: res.w,
    maxHeight: res.h,
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
  const topicLine = mainTopic
    ? `${mainTopic} · ${res.label}${
        connected ? ` · ${stats.fps ?? '—'} fps · ${stats.latencyMs ?? '—'} ms` : ' · waiting for stream…'
      }`
    : 'no camera configured for this robot';

  if (cameraTopics.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-card border border-gray-200 bg-[#1f2937]">
        <span className="font-mono text-xs text-gray-500">No cameras configured for this robot.</span>
      </div>
    );
  }

  const hasSubs = subTopics.length > 0;
  const rows = Math.max(1, subTopics.length);

  return (
    <div
      className="grid flex-1 gap-2"
      style={{
        gridTemplateColumns: hasSubs ? '2fr 1fr' : '1fr',
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
            className={cn('h-[7px] w-[7px] animate-recpulse rounded-sm', recording ? 'bg-red-500' : 'bg-teal-400')}
          />
          {recording ? `REC ${elapsedText}` : 'STANDBY'}
        </span>
        <OverlayBadge className="bottom-3 left-3 max-w-[75%] truncate">{topicLine}</OverlayBadge>
        <div className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-chip bg-gray-900/80 p-[3px]">
          <span className="px-1.5 text-[10px] font-semibold tracking-[0.04em] text-gray-400">RES</span>
          {RES_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setRes(p)}
              className={cn(
                'rounded-chip px-2 py-0.5 font-mono text-[10.5px] font-bold',
                p.label === res.label ? 'bg-teal-300 text-gray-900' : 'text-gray-400',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {subTopics.map((topic, i) => (
        <SubCameraTile
          key={topic}
          topic={topic}
          config={config}
          onSelect={() => setMainTopic(topic)}
          style={{ gridColumn: 2, gridRow: i + 1 }}
        />
      ))}
    </div>
  );
}
