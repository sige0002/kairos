// Stream tab: live WebRTC camera preview. The camera topic is chosen from a
// dropdown seeded from live discovery (GET /api/v1/topics) merged with the
// configured camera topics (config.defaults.default_topics) — no hand-typing.
// We negotiate a recvonly peer connection directly to the streamer; connection
// state, retry, and a codec/connection fallback are surfaced clearly.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { TopicInfo } from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { useWebRtcStream } from './useWebRtcStream';

// A topic is a camera/image topic if its type is an (Compressed)Image or its
// name looks like an image stream. `camera_info` (metadata) is intentionally
// excluded — it carries no pixels.
function isImageType(type?: string): boolean {
  return !!type && /image/i.test(type);
}
function isImageName(name: string): boolean {
  return /image/i.test(name);
}

function asTopicList(data: TopicInfo[] | { topics?: TopicInfo[]; items?: TopicInfo[] }) {
  if (Array.isArray(data)) return data;
  return data.topics ?? data.items ?? [];
}

interface CameraOption {
  name: string;
  type?: string;
  live: boolean;
}

function VideoSurface({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && stream) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className="aspect-video w-full rounded bg-black"
      data-testid="stream-video"
    />
  );
}

export function StreamTab({ config }: { config: RuntimeConfig }) {
  const defaultTopics = config.defaults.default_topics ?? [];

  const topicsQuery = useQuery({
    queryKey: queryKeys.topics,
    queryFn: ({ signal }) =>
      apiGet<TopicInfo[] | { topics?: TopicInfo[]; items?: TopicInfo[] }>('/topics', {
        signal,
      }),
    refetchInterval: 5000,
  });

  // Merge live camera topics (discovery) with configured camera topics that are
  // not flowing yet (so they can be pre-selected), flagged live/offline.
  const options: CameraOption[] = useMemo(() => {
    const live = asTopicList(topicsQuery.data ?? []).filter(
      (t) => isImageType(t.type) || isImageName(t.name),
    );
    const byName = new Map<string, CameraOption>();
    for (const t of live) byName.set(t.name, { name: t.name, type: t.type, live: true });
    for (const name of defaultTopics) {
      if (isImageName(name) && !byName.has(name)) {
        byName.set(name, { name, live: false });
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [topicsQuery.data, defaultTopics]);

  const [topic, setTopic] = useState('');
  // Default to the first live camera topic (or the first option) once available.
  useEffect(() => {
    if (topic && options.some((o) => o.name === topic)) return;
    const first = options.find((o) => o.live) ?? options[0];
    if (first) setTopic(first.name);
  }, [topic, options]);

  const { phase, stream, error, retry } = useWebRtcStream({
    webrtcBase: config.endpoints.webrtc,
    topic,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium">Camera topic</span>
          <select
            aria-label="camera topic"
            className="rounded border px-2 py-1 font-mono"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          >
            {options.length === 0 ? (
              <option value="">
                {topicsQuery.isPending
                  ? 'Discovering…'
                  : 'No camera topics — start a bag/robot'}
              </option>
            ) : (
              options.map((o) => (
                <option key={o.name} value={o.name}>
                  {o.name}
                  {o.live ? '' : ' (offline)'}
                </option>
              ))
            )}
          </select>
        </label>
        <span
          className="rounded bg-gray-100 px-2 py-0.5 text-xs"
          data-testid="stream-phase"
        >
          {phase}
        </span>
        <button
          type="button"
          onClick={retry}
          className="rounded border px-3 py-1 text-sm"
        >
          Retry
        </button>
      </div>

      {error && (
        <div role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          <p>{error}</p>
          <p className="mt-1 text-red-600">
            If the camera codec is unsupported by this browser or the connection cannot
            be established, try a different topic or retry.
          </p>
        </div>
      )}

      {topic ? (
        <VideoSurface stream={stream} />
      ) : (
        <p className="text-sm text-gray-500">
          Select a camera topic to start the preview.
        </p>
      )}
    </div>
  );
}
