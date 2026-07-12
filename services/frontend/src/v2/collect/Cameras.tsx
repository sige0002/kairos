// Right column, top: main camera (real WebRTC preview, reusing
// useWebRtcStream — the MTU/black-preview workarounds live there and are not
// duplicated here) + two sub tiles. Sub tiles stay mock placeholders per the
// Collect task brief; clicking one swaps it into the main slot.

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../components/ui';
import { useWebRtcStream } from '../../features/stream/useWebRtcStream';
import type { RuntimeConfig } from '../../config';
import type { BatchMachine } from './useBatchMachine';

function isImageName(name: string): boolean {
  return /image/i.test(name);
}

/** Best-effort match of a mock camera id ('top'/'left'/'right') to a real
 *  configured image topic, e.g. "top" -> "/camera/top/image_raw". Empty when
 *  no such topic is configured for this robot — the caller then falls back to
 *  the placeholder tile (useWebRtcStream stays idle with no topic). */
function resolveCameraTopic(camId: string, defaultTopics: string[]): string {
  const lower = camId.toLowerCase();
  return (
    defaultTopics.find((t) => isImageName(t) && t.toLowerCase().includes(`/${lower}/`)) ??
    defaultTopics.find((t) => isImageName(t) && t.toLowerCase().includes(lower)) ??
    ''
  );
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `00:${mm}:${ss}`;
}

// Deterministic wobble for the (mock) sub-tile stats, so they're not static
// but need no state of their own — a function of elapsed time only.
function wobble(elapsedMs: number, base: number, amp: number, phase: number): string {
  return (base + Math.sin((elapsedMs / 1000) * 2.1 + phase) * amp).toFixed(1);
}

const RES_PRESETS: { label: string; w: number; h: number }[] = [
  { label: '720p', w: 1280, h: 720 },
  { label: '480p', w: 640, h: 480 },
  { label: '240p', w: 320, h: 240 },
];

function PlaceholderTile({ label, className }: { label: string; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center justify-center border border-gray-200',
        className,
      )}
      style={{
        backgroundImage:
          'repeating-linear-gradient(45deg,#1f2937 0px,#1f2937 14px,#243042 14px,#243042 28px)',
      }}
    >
      <span className="font-mono text-xs text-gray-500">{label}</span>
    </div>
  );
}

function OverlayBadge({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={cn('absolute rounded-chip bg-gray-900/75 px-2.5 py-1 font-mono text-[11px] text-gray-300', className)}>
      {children}
    </span>
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
  const [mainCam, setMainCam] = useState('top');
  const [altCams, setAltCams] = useState<[string, string]>(['left', 'right']);
  const [res, setRes] = useState(RES_PRESETS[1]!); // 480p, matches the design mock's default

  const defaultTopics = useMemo(() => config.defaults.default_topics ?? [], [config]);
  const mainTopic = resolveCameraTopic(mainCam, defaultTopics);

  const { phase, stream, stats } = useWebRtcStream({
    webrtcBase: config.endpoints.webrtc,
    topic: mainTopic,
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
  const camWarn = machine.recWarning && recording;

  function swapTo(slot: 0 | 1) {
    setAltCams((prev) => {
      const next: [string, string] = [...prev] as [string, string];
      next[slot] = mainCam;
      return next;
    });
    setMainCam(altCams[slot]);
  }

  const connected = phase === 'connected' && !!mainTopic;
  const camStatsText = connected
    ? `${res.label} · ${stats.fps ?? '—'} fps · ${stats.latencyMs ?? '—'} ms`
    : `${res.label} · waiting for stream…`;

  return (
    <div className="grid flex-1 grid-cols-[2fr_1fr] grid-rows-2 gap-2">
      <div className="relative col-start-1 row-span-2 overflow-hidden rounded-card border border-gray-200 bg-[#1f2937]">
        {connected ? (
          <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" data-testid="main-camera-video" />
        ) : (
          <PlaceholderTile className="h-full w-full" label={`live camera preview — /camera/${mainTopic || mainCam}`} />
        )}
        <OverlayBadge className="left-3 top-3 bg-gray-900/75 font-sans text-xs font-semibold text-white">
          Main camera · {mainCam}
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
        <OverlayBadge className="bottom-3 left-3">{camStatsText}</OverlayBadge>
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

      <button
        type="button"
        onClick={() => swapTo(0)}
        title="Click to make this the main camera"
        className="relative col-start-2 row-start-1 overflow-hidden rounded-card border border-gray-200 hover:border-teal-500"
      >
        <PlaceholderTile className="h-full w-full" label={`camera — ${altCams[0]}`} />
        <OverlayBadge className="bottom-2 left-2 px-2 py-0.5 text-[10px]">
          {wobble(machine.elapsedMs, recording ? 29.5 : 29.6, recording ? 0.4 : 0, 1)} fps · 142 ms
        </OverlayBadge>
      </button>

      <button
        type="button"
        onClick={() => swapTo(1)}
        title="Click to make this the main camera"
        className="relative col-start-2 row-start-2 overflow-hidden rounded-card border border-gray-200 hover:border-teal-500"
      >
        <PlaceholderTile className="h-full w-full" label={`camera — ${altCams[1]}`} />
        <span
          className={cn(
            'absolute bottom-2 left-2 rounded-chip px-2 py-0.5 font-mono text-[10px]',
            camWarn ? 'bg-amber-800/90 text-amber-200' : 'bg-gray-900/80 text-gray-400',
          )}
        >
          {camWarn
            ? `${wobble(machine.elapsedMs, 22.1, 0.8, 2)} fps · 210 ms`
            : `${wobble(machine.elapsedMs, recording ? 30.0 : 30.1, recording ? 0.4 : 0, 2)} fps · 138 ms`}
        </span>
      </button>
    </div>
  );
}
